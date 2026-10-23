"use strict";
// Eigenes, temporaeres Datenverzeichnis - darf NIE die echte data/rules.json
// anfassen (bis v0.18.5 hat dieses Skript sie geleert). Muss VOR dem
// require von src/rules gesetzt werden.
process.env.WRC6_DATA_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "wrc6-test-"));
// Manueller Smoke-Test (nicht Teil des Plugins) - simuliert einen Systemzustand
// aehnlich dem WRC6-Setup und prueft rules.js + webServer.js end-to-end,
// ohne eine echte HCU zu brauchen.

const fs = require("fs");
const path = require("path");
const { RuleEngine } = require("./src/rules");
const { createWebServer } = require("./src/webServer");

// Gruppen-/Raum-Struktur bewusst so wie im offiziellen Doku-Beispiel
// (Kapitel 6.8.6.3 "getStateForClient"): die META-Raumgruppe haengt am
// Basiskanal (Index 0) eines Geraets; der eigentliche Funktionskanal
// referenziert stattdessen oft eine andere Gruppe (hier: SECURITY), die
// ihrerseits per "metaGroupId" auf die META-Gruppe zeigt. Beide Wege muss
// RuleEngine.resolveRoomLabel abdecken (siehe dortige Tests unten).
const systemState = {
  devices: {
    "LIGHT-DEVICE": {
      id: "LIGHT-DEVICE",
      label: "Licht Haustuer",
      modelType: "HmIP-BSM",
      functionalChannels: {
        "0": { functionalChannelType: "DEVICE_BASE", index: 0, label: "", groups: ["room-flur"] },
        "1": { functionalChannelType: "SWITCH_CHANNEL", index: 1, label: "", on: false, groups: ["sec-flur"] },
      },
    },
    "WRC6-DEVICE": {
      id: "WRC6-DEVICE",
      label: "Flur Wandtaster 6-fach",
      modelType: "HmIP-WRC6-230",
      functionalChannels: {
        "0": { functionalChannelType: "DEVICE_BASE", index: 0, label: "", groups: ["room-flur"] },
        "9": { functionalChannelType: "NOTIFICATION_LIGHT_CHANNEL", index: 9, label: "LED (9) Haustuer", dimLevel: 0.0 },
        "10": {
          functionalChannelType: "NOTIFICATION_LIGHT_CHANNEL",
          index: 10,
          label: "LED (10) Kueche",
          dimLevel: 0.0,
          simpleRGBColorState: "BLACK",
        },
      },
    },
    "WINDOW-DEVICE": {
      id: "WINDOW-DEVICE",
      label: "Fenster Kueche",
      modelType: "HmIP-SWDO",
      functionalChannels: {
        "0": { functionalChannelType: "DEVICE_BASE", index: 0, label: "", groups: ["room-kueche"] },
        "1": { functionalChannelType: "SHUTTER_CONTACT_CHANNEL", index: 1, label: "", windowState: "CLOSED", groups: ["sec-kueche"] },
      },
    },
    "WINDOW-DEVICE-2": {
      id: "WINDOW-DEVICE-2",
      label: "Fenster Kueche Terrasse",
      modelType: "HmIP-SWDO",
      functionalChannels: {
        "0": { functionalChannelType: "DEVICE_BASE", index: 0, label: "", groups: ["room-kueche"] },
        "1": { functionalChannelType: "SHUTTER_CONTACT_CHANNEL", index: 1, label: "", windowState: "CLOSED", groups: ["sec-kueche"] },
      },
    },
    "OTHER-ACTOR-DEVICE": {
      id: "OTHER-ACTOR-DEVICE",
      label: "Deckenlampe Flur",
      modelType: "HmIP-BDT",
      functionalChannels: {
        "0": { functionalChannelType: "DEVICE_BASE", index: 0, label: "", groups: ["room-flur"] },
        "1": { functionalChannelType: "DIMMER_CHANNEL", index: 1, label: "", dimLevel: 0.0 },
      },
    },
  },
  groups: {
    "room-flur": { id: "room-flur", type: "META", label: "Flur" },
    "room-kueche": { id: "room-kueche", type: "META", label: "Küche" },
    "sec-flur": { id: "sec-flur", type: "SECURITY", metaGroupId: "room-flur" },
    "sec-kueche": { id: "sec-kueche", type: "SECURITY", metaGroupId: "room-kueche" },
  },
};

function assert(cond, msg) {
  if (!cond) throw new Error("FEHLGESCHLAGEN: " + msg);
  console.log("OK:", msg);
}

async function main() {
  process.chdir(__dirname);

  // --- Neu: Migration alter Regeln (Feld "source" statt "sources") beim Laden ---
  const dataDir = process.env.WRC6_DATA_DIR;
  const rulesFile = path.join(dataDir, "rules.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    rulesFile,
    JSON.stringify([
      {
        id: "old-format-rule",
        enabled: true,
        invert: false,
        source: { deviceId: "LIGHT-DEVICE", channelIndex: 1, deviceLabel: "Licht Haustuer", channelLabel: "" },
        target: { deviceId: "WRC6-DEVICE", channelIndex: 9, deviceLabel: "Flur Wandtaster 6-fach", channelLabel: "LED (9) Haustuer", controlType: "DIM" },
        createdAt: 1,
      },
    ])
  );
  const migrationEngine = new RuleEngine({ onLog: () => {}, verifyDelayMs: 0 });
  const migrated = migrationEngine.getRules()[0];
  assert(migrated && Array.isArray(migrated.sources) && migrated.sources.length === 1 && !migrated.source, "Alte Regel mit Feld 'source' wird beim Laden zu 'sources'-Array migriert");
  migrationEngine.deleteRule("old-format-rule"); // Testdatei wieder leeren

  // rules.js in Isolation testen (eigenes /data Verzeichnis fuer den Test)
  const engine = new RuleEngine({ onLog: () => {}, verifyDelayMs: 0 });
  // vorherige Test-Regeln entfernen
  for (const r of [...engine.getRules()]) engine.deleteRule(r.id);

  const rule = engine.addRule(
    { sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 9 }, invert: false },
    systemState
  );
  assert(rule.target.controlType === "DIM", "Ziel-Kanal (dimLevel-Feld) wird als DIM erkannt");
  assert(rule.sources.length === 1 && rule.sources[0].channelLabel === "", "Quelle korrekt referenziert");

  engine.initFromSystemState(systemState);

  // Quelle schaltet an -> Ziel sollte per setDimLevel auf 1.0 gesetzt werden
  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = true;
  let calledPath = null;
  let calledBody = null;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    calledPath = path;
    calledBody = body;
    return { code: 200 };
  });
  assert(calledPath === "/hmip/device/control/setDimLevel", "Steuerbefehl setDimLevel wird gesendet");
  assert(calledBody.dimLevel === 1.0 && calledBody.deviceId === "WRC6-DEVICE" && calledBody.channelIndex === 9, "Steuerbefehl-Body korrekt: " + JSON.stringify(calledBody));

  // Erneuter Aufruf ohne echten Wechsel -> darf NICHT nochmal senden
  calledPath = null;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    calledPath = path;
    return { code: 200 };
  });
  assert(calledPath === null, "Kein doppelter Befehl ohne Zustandswechsel");

  // Quelle geht aus -> Ziel aus
  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    calledPath = path;
    calledBody = body;
    return { code: 200 };
  });
  assert(calledBody.dimLevel === 0.0, "Bei Quelle=aus wird Ziel auf dimLevel 0.0 gesetzt");

  const log = engine.getLog();
  assert(log.length === 2, "Log enthaelt beide Aktionen (" + log.length + ")");

  // --- Neu: enforceAllRules setzt beim (simulierten) Plugin-Start sofort
  // den tatsaechlichen Zustand durch, nicht erst bei einer kuenftigen
  // Aenderung ("Zustand, nicht Zustandsaenderung"). ---
  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = true; // Quelle ist schon an, BEVOR die Regel existiert
  const startupRule = engine.addRule(
    { sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 9 }, invert: false },
    systemState
  );
  let startupCalledBody = null;
  await engine.enforceAllRules(systemState, async (path, body) => {
    startupCalledBody = body;
    return { code: 200 };
  });
  assert(startupCalledBody && startupCalledBody.dimLevel === 1.0, "enforceAllRules schaltet die LED sofort an, weil die Quelle beim Start bereits 'an' ist (kein Warten auf eine Aenderung)");

  // Danach (laufender Betrieb): ohne echten Wechsel darf onDevicesChanged NICHT erneut senden.
  startupCalledBody = null;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    startupCalledBody = body;
    return { code: 200 };
  });
  assert(startupCalledBody === null, "Im laufenden Betrieb bleibt onDevicesChanged aenderungsbasiert (kein Duty-Cycle-Spam ohne echten Wechsel)");
  engine.deleteRule(startupRule.id);
  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;

  // --- Neu: Fensterkontakt als Quelle ---
  const windowRule = engine.addRule(
    { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 9 }, invert: false },
    systemState
  );
  engine.initFromSystemState(systemState);

  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "OPEN";
  let windowCalledBody = null;
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (path, body) => {
    windowCalledBody = body;
    return { code: 200 };
  });
  assert(windowCalledBody && windowCalledBody.dimLevel === 1.0, "Fenster OPEN loest setDimLevel(1.0) auf der LED aus");

  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "CLOSED";
  windowCalledBody = null;
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (path, body) => {
    windowCalledBody = body;
    return { code: 200 };
  });
  assert(windowCalledBody && windowCalledBody.dimLevel === 0.0, "Fenster CLOSED schaltet die LED wieder aus");
  engine.deleteRule(windowRule.id);

  // --- Neu: Mehrfachauswahl - ODER-Verknuepfung ueber zwei Fensterkontakte ---
  const multiRule = engine.addRule(
    {
      sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }, { deviceId: "WINDOW-DEVICE-2", channelIndex: 1 }],
      target: { deviceId: "WRC6-DEVICE", channelIndex: 9 },
      invert: false,
    },
    systemState
  );
  assert(multiRule.sources.length === 2, "Regel speichert beide Quellen");
  engine.initFromSystemState(systemState);

  // Fenster 1 oeffnet -> Ziel an
  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "OPEN";
  let multiCalledPath = null;
  let multiCalledBody = null;
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (path, body) => {
    multiCalledPath = path;
    multiCalledBody = body;
    return { code: 200 };
  });
  assert(multiCalledBody && multiCalledBody.dimLevel === 1.0, "ODER: erste Quelle ausgeloest -> Ziel an");

  // Fenster 2 oeffnet ZUSAETZLICH, waehrend Fenster 1 noch offen ist -> kein erneuter Befehl (Zustand unveraendert: schon an)
  multiCalledPath = null;
  systemState.devices["WINDOW-DEVICE-2"].functionalChannels["1"].windowState = "OPEN";
  await engine.onDevicesChanged(["WINDOW-DEVICE-2"], systemState, async (path, body) => {
    multiCalledPath = path;
    return { code: 200 };
  });
  assert(multiCalledPath === null, "ODER: zweite Quelle zusaetzlich ausgeloest, kombinierter Zustand bleibt an -> kein erneuter Befehl");

  // Fenster 1 schliesst wieder, Fenster 2 ist noch offen -> Ziel bleibt an, kein Befehl
  multiCalledPath = null;
  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "CLOSED";
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (path, body) => {
    multiCalledPath = path;
    return { code: 200 };
  });
  assert(multiCalledPath === null, "ODER: eine von zwei Quellen schliesst, die andere ist noch offen -> Ziel bleibt an, kein Befehl");

  // Fenster 2 schliesst nun auch -> Ziel geht aus
  multiCalledBody = null;
  systemState.devices["WINDOW-DEVICE-2"].functionalChannels["1"].windowState = "CLOSED";
  await engine.onDevicesChanged(["WINDOW-DEVICE-2"], systemState, async (path, body) => {
    multiCalledBody = body;
    return { code: 200 };
  });
  assert(multiCalledBody && multiCalledBody.dimLevel === 0.0, "ODER: letzte Quelle schliesst auch -> Ziel geht aus");

  // --- Neu: updateRule kann die Quellenliste ersetzen ---
  const updatedMultiRule = engine.updateRule(multiRule.id, { sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }] }, systemState);
  assert(updatedMultiRule.sources.length === 1 && updatedMultiRule.sources[0].deviceId === "LIGHT-DEVICE", "updateRule ersetzt die Quellenliste einer Regel");

  let updateRejected = false;
  try {
    engine.updateRule(multiRule.id, { sources: [{ deviceId: "does-not-exist", channelIndex: 0 }] }, systemState);
  } catch (err) {
    updateRejected = true;
  }
  assert(updateRejected, "updateRule lehnt eine ungueltige neue Quelle ab");
  engine.deleteRule(multiRule.id);

  // --- Neu: Ziel MUSS ein WRC6-230 sein ---
  let rejected = false;
  try {
    engine.addRule(
      { sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }], target: { deviceId: "OTHER-ACTOR-DEVICE", channelIndex: 1 }, invert: false },
      systemState
    );
  } catch (err) {
    rejected = true;
    assert(/WRC6-230/.test(err.message), "Fehlermeldung nennt WRC6-230 als Grund: " + err.message);
  }
  assert(rejected, "Ziel auf Nicht-WRC6-230-Geraet wird serverseitig abgelehnt");

  // --- Neu: RGB_DIM-Ziel (Farbe + Helligkeit) ---
  const colorRule = engine.addRule(
    {
      sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }],
      target: { deviceId: "WRC6-DEVICE", channelIndex: 10 },
      invert: false,
      onDimLevel: 0.5,
      onColor: "RED",
    },
    systemState
  );
  assert(colorRule.target.controlType === "RGB_DIM", "Kanal mit dimLevel+simpleRGBColorState wird als RGB_DIM erkannt");
  assert(colorRule.target.onDimLevel === 0.5 && colorRule.target.onColor === "RED", "onDimLevel/onColor werden in der Regel gespeichert");

  const colorRuleDefaults = engine.addRule(
    { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, invert: false },
    systemState
  );
  assert(colorRuleDefaults.target.onDimLevel === 1.0 && colorRuleDefaults.target.onColor === "WHITE", "Ohne Angabe gelten Standardwerte 100% / WHITE");
  engine.deleteRule(colorRuleDefaults.id);

  let invalidColorRejected = false;
  try {
    engine.addRule(
      { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, invert: false, onColor: "PINK" },
      systemState
    );
  } catch (err) {
    invalidColorRejected = true;
    assert(/Ungültige Farbe/.test(err.message), "Fehlermeldung nennt ungueltige Farbe: " + err.message);
  }
  assert(invalidColorRejected, "Nicht unterstuetzte Farbe wird abgelehnt");

  engine.initFromSystemState(systemState);
  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = true;
  let colorCalledPath = null;
  let colorCalledBody = null;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    colorCalledPath = path;
    colorCalledBody = body;
    return { code: 200 };
  });
  assert(colorCalledPath === "/hmip/device/control/setSimpleRGBColorDimLevel", "Bei Ausloesen wird setSimpleRGBColorDimLevel gesendet");
  assert(
    colorCalledBody.simpleRGBColorState === "RED" && colorCalledBody.dimLevel === 0.5 && colorCalledBody.channelIndex === 10,
    "Farbe/Helligkeit aus der Regel werden korrekt gesendet: " + JSON.stringify(colorCalledBody)
  );

  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    colorCalledPath = path;
    colorCalledBody = body;
    return { code: 200 };
  });
  assert(
    colorCalledPath === "/hmip/device/control/setSimpleRGBColorDimLevel" && colorCalledBody.dimLevel === 0.0 && colorCalledBody.simpleRGBColorState === "RED",
    "Beim Zurueckschalten wird die LED wie bei der manuellen Steuerung per setSimpleRGBColorDimLevel(dimLevel 0.0) ausgeschaltet (NICHT mehr setDimLevel, siehe CHANGELOG 0.19.0): " + colorCalledPath
  );
  engine.deleteRule(colorRule.id);

  // --- Neu: Signalverhalten (Blinken/Blitzen/Wallend) bei Regeln ---
  const behaviourRule = engine.addRule(
    {
      sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }],
      target: { deviceId: "WRC6-DEVICE", channelIndex: 10 },
      invert: false,
      onDimLevel: 0.8,
      onColor: "BLUE",
      onBehaviour: "BLINKING_MIDDLE",
    },
    systemState
  );
  assert(behaviourRule.target.onBehaviour === "BLINKING_MIDDLE", "onBehaviour wird in der Regel gespeichert");

  let invalidBehaviourRejected = false;
  try {
    engine.addRule(
      { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, invert: false, onBehaviour: "SPARKLE" },
      systemState
    );
  } catch (err) {
    invalidBehaviourRejected = true;
    assert(/Ungültige Leuchtart/.test(err.message), "Fehlermeldung nennt ungueltiges Signalverhalten: " + err.message);
  }
  assert(invalidBehaviourRejected, "Nicht unterstuetztes Signalverhalten wird bei Regeln abgelehnt");

  engine.initFromSystemState(systemState);
  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = true;
  let behaviourCalledPath = null;
  let behaviourCalledBody = null;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    behaviourCalledPath = path;
    behaviourCalledBody = body;
    return { code: 200 };
  });
  assert(behaviourCalledPath === "/hmip/device/control/setOpticalSignal", "Regel mit onBehaviour sendet setOpticalSignal: " + behaviourCalledPath);
  assert(
    behaviourCalledBody.opticalSignalBehaviour === "BLINKING_MIDDLE" && behaviourCalledBody.simpleRGBColorState === "BLUE" && behaviourCalledBody.dimLevel === 0.8,
    "setOpticalSignal-Body der Regel korrekt: " + JSON.stringify(behaviourCalledBody)
  );

  systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
  await engine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (path, body) => {
    behaviourCalledPath = path;
    behaviourCalledBody = body;
    return { code: 200 };
  });
  assert(
    behaviourCalledPath === "/hmip/device/control/setSimpleRGBColorDimLevel" && behaviourCalledBody.dimLevel === 0.0,
    "Auch eine Effekt-Regel schaltet wie die manuelle 'Aus'-Taste per setSimpleRGBColorDimLevel(0.0) aus: " + JSON.stringify(behaviourCalledBody)
  );

  const behaviourUpdated = engine.updateRule(behaviourRule.id, { onBehaviour: "" }, systemState);
  assert(behaviourUpdated.target.onBehaviour === "", "onBehaviour laesst sich per updateRule wieder auf 'dauerhaft an' zuruecksetzen");
  engine.deleteRule(behaviourRule.id);

  // --- Neu: UND-Verknuepfung + Prioritaet bei mehreren Regeln fuer dasselbe
  // Ziel - Beispiel: Fenster OG auf -> rot, Fenster UG auf -> gruen,
  // BEIDE auf -> gelb. Alle drei Regeln teilen sich denselben WRC6-Kanal. ---
  const ruleOG = engine.addRule(
    { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, invert: false, onColor: "RED" },
    systemState
  );
  const ruleUG = engine.addRule(
    { sources: [{ deviceId: "WINDOW-DEVICE-2", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, invert: false, onColor: "GREEN" },
    systemState
  );
  const ruleBoth = engine.addRule(
    {
      sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }, { deviceId: "WINDOW-DEVICE-2", channelIndex: 1 }],
      sourceLogic: "AND",
      target: { deviceId: "WRC6-DEVICE", channelIndex: 10 },
      invert: false,
      onColor: "YELLOW",
    },
    systemState
  );
  assert(ruleBoth.sourceLogic === "AND", "sourceLogic 'AND' wird in der Regel gespeichert");
  assert(ruleOG.sourceLogic === "OR", "sourceLogic ohne Angabe faellt auf 'OR' zurueck (Standard/Abwaertskompatibilitaet)");

  let invalidLogicRejected = false;
  try {
    engine.addRule(
      { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, sourceLogic: "XOR" },
      systemState
    );
  } catch (err) {
    invalidLogicRejected = true;
    assert(/Ungültige Verknüpfung/.test(err.message), "Fehlermeldung nennt ungueltige Quellen-Verknuepfung: " + err.message);
  }
  assert(invalidLogicRejected, "Unbekannte sourceLogic wird abgelehnt");

  engine.initFromSystemState(systemState);

  // OG oeffnet (UG noch zu): nur ruleOG matched -> rot
  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "OPEN";
  let conflictBody = null;
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (path, body) => {
    conflictBody = body;
    return { code: 200 };
  });
  assert(conflictBody && conflictBody.simpleRGBColorState === "RED", "Nur OG offen -> rot (ruleOG gewinnt): " + JSON.stringify(conflictBody));

  // UG oeffnet ZUSAETZLICH: ruleBoth (UND) ist jetzt auch erfuellt, ABER
  // steht in der Prioritaet noch UNTER ruleOG (spaeter angelegt = weiter
  // unten) - ruleOG bleibt also weiterhin Gewinner, genau das im Eingangs-
  // Beispiel beschriebene Problem OHNE Umsortieren: es bleibt bei rot, kein
  // erneuter Befehl (der Gewinner hat sich nicht geaendert).
  conflictBody = null;
  let conflictCalled = false;
  systemState.devices["WINDOW-DEVICE-2"].functionalChannels["1"].windowState = "OPEN";
  await engine.onDevicesChanged(["WINDOW-DEVICE-2"], systemState, async (path, body) => {
    conflictCalled = true;
    conflictBody = body;
    return { code: 200 };
  });
  assert(!conflictCalled, "Ohne Umsortieren bleibt ruleOG (zuerst angelegt = hoehere Prioritaet) Gewinner, obwohl ruleBoth (UND) jetzt auch erfuellt ist - kein Befehl, da Gewinner unveraendert");

  const statusBeforeReorder = engine.getRulesWithStatus(systemState);
  const ogStatus = statusBeforeReorder.find((r) => r.id === ruleOG.id);
  const bothStatusBefore = statusBeforeReorder.find((r) => r.id === ruleBoth.id);
  assert(ogStatus.matches === true && ogStatus.active === true, "Live-Status: ruleOG trifft zu UND ist aktiv (Gewinner)");
  assert(bothStatusBefore.matches === true && bothStatusBefore.active === false, "Live-Status: ruleBoth trifft zwar zu (UND erfuellt), ist aber NICHT aktiv (von ruleOG ueberschrieben)");

  // ruleBoth per Prioritaet (moveRule) an die Spitze schieben (2x "up", da
  // an Index 2 angelegt) - danach syncTarget (wie es webServer.js nach einer
  // Umsortierung ausloesen wuerde) statt auf ein neues Geraete-Event zu warten.
  engine.moveRule(ruleBoth.id, "up");
  engine.moveRule(ruleBoth.id, "up");
  // Absichtlich relative Reihenfolge pruefen, nicht Index 0 der Gesamtliste -
  // die weiter oben angelegte, noch lebende "rule" (anderes Ziel, Kanal 9)
  // steht global davor, ist fuer die Prioritaet INNERHALB dieser Ziel-Gruppe
  // (Kanal 10) aber irrelevant (siehe _groupRulesByTarget: Gruppierung nach
  // Ziel-Kanal, nicht nach Gesamt-Listenposition).
  const orderAfterMove = engine.getRules().map((r) => r.id);
  assert(
    orderAfterMove.indexOf(ruleBoth.id) < orderAfterMove.indexOf(ruleOG.id) && orderAfterMove.indexOf(ruleBoth.id) < orderAfterMove.indexOf(ruleUG.id),
    "moveRule('up') zweimal verschiebt ruleBoth vor ruleOG und ruleUG (hoechste Prioritaet innerhalb der Ziel-Gruppe)"
  );

  let syncBody = null;
  await engine.syncTarget("WRC6-DEVICE", 10, systemState, async (path, body) => {
    syncBody = body;
    return { code: 200 };
  });
  assert(syncBody && syncBody.simpleRGBColorState === "YELLOW", "Nach Umsortieren + syncTarget gewinnt ruleBoth (UND, jetzt hoechste Prioritaet) -> gelb: " + JSON.stringify(syncBody));

  const statusAfterReorder = engine.getRulesWithStatus(systemState);
  const bothStatusAfter = statusAfterReorder.find((r) => r.id === ruleBoth.id);
  const ogStatusAfter = statusAfterReorder.find((r) => r.id === ruleOG.id);
  assert(bothStatusAfter.active === true, "Live-Status nach Umsortieren: ruleBoth ist jetzt aktiv");
  assert(ogStatusAfter.matches === true && ogStatusAfter.active === false, "Live-Status nach Umsortieren: ruleOG trifft weiter zu, ist aber nicht mehr aktiv");

  // moveRule('down') am Ende der Gesamtliste ist ein No-Op (kein Fehler,
  // keine Aenderung) - ruleUG steht nach den beiden "up"-Verschiebungen von
  // ruleBoth ganz am Ende der Liste (eindeutig, unabhaengig von der
  // lebenden "rule" mit anderem Ziel).
  const beforeNoOp = engine.getRules().map((r) => r.id);
  engine.moveRule(ruleUG.id, "down");
  const afterNoOp = engine.getRules().map((r) => r.id);
  assert(JSON.stringify(beforeNoOp) === JSON.stringify(afterNoOp), "moveRule('down') am Ende der Liste aendert nichts (kein Fehler, kein Effekt)");

  // UG schliesst wieder: ruleBoth (UND) nicht mehr erfuellt -> zurueck auf ruleOG (rot)
  systemState.devices["WINDOW-DEVICE-2"].functionalChannels["1"].windowState = "CLOSED";
  let backToRedBody = null;
  await engine.onDevicesChanged(["WINDOW-DEVICE-2"], systemState, async (path, body) => {
    backToRedBody = body;
    return { code: 200 };
  });
  assert(backToRedBody && backToRedBody.simpleRGBColorState === "RED", "UG schliesst wieder -> ruleBoth nicht mehr erfuellt, ruleOG uebernimmt wieder -> rot: " + JSON.stringify(backToRedBody));

  // OG schliesst auch: keine Regel mehr erfuellt -> aus
  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "CLOSED";
  let allOffBody = null;
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (path, body) => {
    allOffBody = body;
    return { code: 200 };
  });
  assert(allOffBody && allOffBody.dimLevel === 0.0, "Beide Fenster zu -> keine Regel erfuellt -> LED aus: " + JSON.stringify(allOffBody));

  let moveUnknownRejected = false;
  try {
    engine.moveRule("does-not-exist", "up");
  } catch (err) {
    moveUnknownRejected = true;
  }
  assert(moveUnknownRejected, "moveRule mit unbekannter id wirft einen Fehler");

  engine.deleteRule(ruleOG.id);
  engine.deleteRule(ruleUG.id);
  engine.deleteRule(ruleBoth.id);

  // --- Web-Server-Endpunkte testen ---
  const sentCommands = []; // Aufzeichnung aller ueber die Web-API tatsaechlich gesendeten Befehle
  const fakeApi = {
    connected: true,
    systemStateReady: true,
    systemState,
    sendSystemRequest: async (path, body) => {
      sentCommands.push({ path, body });
      return { code: 200, path, body };
    },
  };
  const app = createWebServer({ api: fakeApi, ruleEngine: engine });
  const server = app.listen(0);
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  const devicesRes = await fetch(`${base}/api/devices`);
  const devices = await devicesRes.json();
  assert(devicesRes.status === 200, "GET /api/devices -> 200");
  assert(devices.some((d) => d.deviceId === "WRC6-DEVICE" && d.channelIndex === 9), "WRC6-LED-Kanal 9 erscheint in /api/devices");
  assert(!devices.some((d) => d.channelType === "DEVICE_BASE"), "Basiskanaele ohne An/Aus-Zustand werden herausgefiltert");

  const targetCandidates = devices.filter((d) => d.isTargetCandidate);
  assert(
    targetCandidates.length === 2 && targetCandidates.every((d) => d.deviceId === "WRC6-DEVICE"),
    "Nur die WRC6-230-Kanaele (9 und 10) sind isTargetCandidate=true"
  );
  assert(targetCandidates.find((d) => d.channelIndex === 10).supportsColor, "RGB-faehiger WRC6-Kanal meldet supportsColor=true");
  assert(!targetCandidates.find((d) => d.channelIndex === 9).supportsColor, "Reiner Dimm-Kanal meldet supportsColor=false");
  assert(!devices.find((d) => d.deviceId === "OTHER-ACTOR-DEVICE").isTargetCandidate, "Nicht-WRC6-Dimmer ist NICHT isTargetCandidate");

  const windowEntry = devices.find((d) => d.deviceId === "WINDOW-DEVICE");
  assert(windowEntry.stateLabel === "GESCHLOSSEN", "Fensterkontakt zeigt stateLabel GESCHLOSSEN statt AUS: " + windowEntry.stateLabel);
  assert(!windowEntry.isTargetCandidate, "Fensterkontakt ist nicht als Ziel waehlbar (nicht steuerbar)");

  // --- Neu: Raum-Filterung ueber die META-Gruppe (zwei Aufloesungswege) ---
  // Weg A: Funktionskanal referenziert eine SECURITY-Gruppe mit metaGroupId.
  assert(windowEntry.roomLabel === "Küche", "Fensterkontakt (Weg ueber metaGroupId) zeigt Raumnamen 'Küche': " + windowEntry.roomLabel);
  const lightEntry = devices.find((d) => d.deviceId === "LIGHT-DEVICE" && d.channelIndex === 1);
  assert(lightEntry.roomLabel === "Flur", "Lichtschalter (Weg ueber metaGroupId) zeigt Raumnamen 'Flur': " + lightEntry.roomLabel);
  // Weg B: Funktionskanal hat gar keine eigene Gruppe -> Fallback auf den
  // Basiskanal (Index 0) des Geraets, der die META-Gruppe direkt referenziert.
  const wrc6LedEntry = devices.find((d) => d.deviceId === "WRC6-DEVICE" && d.channelIndex === 9);
  assert(wrc6LedEntry.roomLabel === "Flur", "WRC6-LED ohne eigene Gruppen-Zuordnung zeigt ueber den Basiskanal 'Flur': " + wrc6LedEntry.roomLabel);
  const otherActorEntry = devices.find((d) => d.deviceId === "OTHER-ACTOR-DEVICE");
  assert(otherActorEntry.roomLabel === "Flur", "Dimmer ohne eigene Gruppen-Zuordnung zeigt ueber den Basiskanal 'Flur': " + otherActorEntry.roomLabel);

  const distinctRooms = new Set(devices.map((d) => d.roomLabel).filter(Boolean));
  assert(distinctRooms.size === 2 && distinctRooms.has("Flur") && distinctRooms.has("Küche"), "Mindestens zwei unterschiedliche Raeume werden erkannt: " + [...distinctRooms].join(", "));

  const rulesRes = await fetch(`${base}/api/rules`);
  const rules = await rulesRes.json();
  assert(rules.length === 1, "GET /api/rules liefert die angelegte Regel");
  assert(Array.isArray(rules[0].sources), "Regel im JSON hat ein sources-Array");

  const badRes = await fetch(`${base}/api/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: [{ deviceId: "does-not-exist", channelIndex: 0 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 9 } }),
  });
  assert(badRes.status === 400, "POST /api/rules mit unbekannter Quelle -> 400 (sauberer Fehler, kein Crash)");

  const noSourceRes = await fetch(`${base}/api/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources: [], target: { deviceId: "WRC6-DEVICE", channelIndex: 9 } }),
  });
  assert(noSourceRes.status === 400, "POST /api/rules ohne Quelle -> 400");

  const delRes = await fetch(`${base}/api/rules/${rule.id}`, { method: "DELETE" });
  assert(delRes.status === 204, "DELETE /api/rules/:id -> 204");
  assert(engine.getRules().length === 0, "Regel nach DELETE tatsaechlich entfernt");

  // --- Neu: sourceLogic (UND) + Prioritaet (moveRule) ueber die Web-API ---
  // Beide Fenster schon offen anlegen, BEVOR die Regeln existieren - so laesst
  // sich pruefen, dass POST /api/rules den neuen Zustand sofort abgleicht
  // (syncTargetSafely), statt erst auf ein kuenftiges Geraete-Event zu warten.
  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "OPEN";
  systemState.devices["WINDOW-DEVICE-2"].functionalChannels["1"].windowState = "OPEN";

  const addRuleARes = await fetch(`${base}/api/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }],
      target: { deviceId: "WRC6-DEVICE", channelIndex: 10 },
      onColor: "RED",
    }),
  });
  const ruleAHttp = await addRuleARes.json();
  assert(addRuleARes.status === 201, "POST /api/rules (ruleA, nur OG) -> 201");
  assert(
    sentCommands.length && sentCommands[sentCommands.length - 1].body.simpleRGBColorState === "RED",
    "POST /api/rules gleicht sofort ab: ruleA trifft bereits zu (Fenster schon offen) -> sofort rot gesendet"
  );

  const addRuleBRes = await fetch(`${base}/api/rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }, { deviceId: "WINDOW-DEVICE-2", channelIndex: 1 }],
      sourceLogic: "AND",
      target: { deviceId: "WRC6-DEVICE", channelIndex: 10 },
      onColor: "YELLOW",
    }),
  });
  const ruleBHttp = await addRuleBRes.json();
  assert(addRuleBRes.status === 201 && ruleBHttp.sourceLogic === "AND", "POST /api/rules (ruleB, UND) -> 201, sourceLogic gespeichert");
  assert(
    sentCommands[sentCommands.length - 1].body.simpleRGBColorState === "RED",
    "ruleB (neu angelegt, niedrigste Prioritaet) trifft zwar auch zu, aber ruleA bleibt Gewinner -> weiterhin rot"
  );

  const statusHttpRes = await fetch(`${base}/api/rules`);
  const statusHttp = await statusHttpRes.json();
  const ruleAStatus = statusHttp.find((r) => r.id === ruleAHttp.id);
  const ruleBStatus = statusHttp.find((r) => r.id === ruleBHttp.id);
  assert(ruleAStatus.matches === true && ruleAStatus.active === true, "GET /api/rules: ruleA matches+active=true");
  assert(ruleBStatus.matches === true && ruleBStatus.active === false, "GET /api/rules: ruleB matches=true, aber active=false (von ruleA ueberschrieben)");

  const moveRes = await fetch(`${base}/api/rules/${ruleBHttp.id}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction: "up" }),
  });
  assert(moveRes.status === 200, "POST /api/rules/:id/move -> 200");
  assert(
    sentCommands[sentCommands.length - 1].body.simpleRGBColorState === "YELLOW",
    "Nach dem Verschieben nach oben gewinnt ruleB (UND) -> sofort gelb gesendet: " + JSON.stringify(sentCommands[sentCommands.length - 1].body)
  );

  const moveUnknownRes = await fetch(`${base}/api/rules/does-not-exist/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction: "up" }),
  });
  assert(moveUnknownRes.status === 400, "POST /api/rules/:id/move mit unbekannter id -> 400");

  await fetch(`${base}/api/rules/${ruleAHttp.id}`, { method: "DELETE" });
  await fetch(`${base}/api/rules/${ruleBHttp.id}`, { method: "DELETE" });
  assert(
    sentCommands[sentCommands.length - 1].body.dimLevel === 0.0,
    "Nach Loeschen beider Regeln ist keine mehr uebrig -> LED geht aus: " + JSON.stringify(sentCommands[sentCommands.length - 1].body)
  );
  assert(engine.getRules().length === 0, "Web-API-Testregeln wieder entfernt");
  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "CLOSED";
  systemState.devices["WINDOW-DEVICE-2"].functionalChannels["1"].windowState = "CLOSED";

  // --- Neu: POST /api/control (manuelle Direktsteuerung) ---
  const controlOkRes = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "WRC6-DEVICE", channelIndex: 10, dimLevel: 0.75, color: "GREEN" }),
  });
  const controlOkBody = await controlOkRes.json();
  assert(controlOkRes.status === 200, "POST /api/control fuer WRC6-230-RGB-Kanal -> 200");
  assert(controlOkBody.ok === true, "/api/control liefert ok:true");

  const controlBadRes = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "OTHER-ACTOR-DEVICE", channelIndex: 1, dimLevel: 0.5 }),
  });
  const controlBadBody = await controlBadRes.json();
  assert(controlBadRes.status === 400, "POST /api/control fuer Nicht-WRC6-230-Geraet -> 400");
  assert(/WRC6-230/.test(controlBadBody.error || ""), "Fehlermeldung nennt WRC6-230-Beschraenkung: " + controlBadBody.error);

  // --- Neu: Signalverhalten (Blinken/Blitzen/Wallend) ueber setOpticalSignal ---
  assert(controlOkBody.result.path === "/hmip/device/control/setSimpleRGBColorDimLevel", "Ohne behaviour bleibt es beim bisherigen setSimpleRGBColorDimLevel-Pfad");

  const blinkRes = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "WRC6-DEVICE", channelIndex: 10, dimLevel: 0.5, color: "BLUE", behaviour: "BLINKING_MIDDLE" }),
  });
  const blinkBody = await blinkRes.json();
  assert(blinkRes.status === 200, "POST /api/control mit behaviour -> 200");
  assert(blinkBody.result.path === "/hmip/device/control/setOpticalSignal", "Mit behaviour wird setOpticalSignal gesendet: " + blinkBody.result.path);
  assert(
    blinkBody.result.body.opticalSignalBehaviour === "BLINKING_MIDDLE" && blinkBody.result.body.simpleRGBColorState === "BLUE" && blinkBody.result.body.dimLevel === 0.5,
    "setOpticalSignal-Body enthaelt Verhalten/Farbe/Helligkeit korrekt: " + JSON.stringify(blinkBody.result.body)
  );

  const badBehaviourRes = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "WRC6-DEVICE", channelIndex: 10, dimLevel: 0.5, behaviour: "RAINBOW" }),
  });
  const badBehaviourBody = await badBehaviourRes.json();
  assert(badBehaviourRes.status === 400, "POST /api/control mit ungueltigem behaviour -> 400");
  assert(/Leuchtart/.test(badBehaviourBody.error || ""), "Fehlermeldung nennt ungueltiges Signalverhalten: " + badBehaviourBody.error);

  // --- Neu: Einblendzeit (rampTime) ---
  const rampRes = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "WRC6-DEVICE", channelIndex: 10, dimLevel: 0.9, color: "GREEN", rampTime: 5 }),
  });
  const rampBody = await rampRes.json();
  assert(rampRes.status === 200, "POST /api/control mit rampTime -> 200");
  assert(rampBody.result.path === "/hmip/device/control/setSimpleRGBColorDimLevelWithTime", "Mit rampTime wird die WithTime-Variante gesendet: " + rampBody.result.path);
  assert(
    rampBody.result.body.rampTime === 5 && rampBody.result.body.onTime === RuleEngine.MAX_ON_TIME_SECONDS,
    "rampTime wird gesetzt und onTime automatisch auf das dokumentierte Maximum: " + JSON.stringify(rampBody.result.body)
  );

  const rampBehaviourRes = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "WRC6-DEVICE", channelIndex: 10, dimLevel: 0.9, color: "GREEN", behaviour: "FLASH_MIDDLE", rampTime: 5 }),
  });
  const rampBehaviourBody = await rampBehaviourRes.json();
  assert(
    rampBehaviourBody.result.path === "/hmip/device/control/setOpticalSignalWithTime",
    "rampTime + behaviour zusammen nutzen setOpticalSignalWithTime: " + rampBehaviourBody.result.path
  );

  const badRampRes = await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "WRC6-DEVICE", channelIndex: 10, dimLevel: 0.5, rampTime: 99999 }),
  });
  const badRampBody = await badRampRes.json();
  assert(badRampRes.status === 400, "POST /api/control mit rampTime ausserhalb 0.1-16383 -> 400");
  assert(/Einblendzeit/.test(badRampBody.error || ""), "Fehlermeldung nennt ungueltige Einblendzeit: " + badRampBody.error);

  // --- Neu: Manuelle Steuerung verwirft den Duty-Cycle-Cache des Ziels
  // (Nutzer-Feedback: "nach Nutzung der manuellen Schaltung laeuft die
  // Automatik gar nicht mehr"), siehe RuleEngine.forgetTargetState. ---
  const manualCacheRule = engine.addRule(
    { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, invert: false, onColor: "RED" },
    systemState
  );
  engine.initFromSystemState(systemState);
  const manualCacheKey = `${manualCacheRule.target.deviceId}::${manualCacheRule.target.channelIndex}`;

  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "OPEN";
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (p, b) => {
    sentCommands.push({ path: p, body: b });
    return { code: 200 };
  });
  assert(
    engine.lastTargetWinner.get(manualCacheKey) === manualCacheRule.id,
    "Duty-Cycle-Cache steht nach echtem Fenster-Ereignis auf die gewinnende Regel"
  );

  // Manuelle Direktsteuerung desselben Ziels, z.B. weil jemand die LED kurz
  // selbst anders eingestellt hat - geht an der Regel-Engine vorbei.
  await fetch(`${base}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: "WRC6-DEVICE", channelIndex: 10, dimLevel: 0.3, color: "GREEN" }),
  });
  assert(
    !engine.lastTargetWinner.has(manualCacheKey),
    "Nach manueller Steuerung ist der Duty-Cycle-Cache fuer dieses Ziel verworfen (forgetTargetState)"
  );

  // Ohne Fix wuerde die naechste Auswertung mit UNVERAeNDERTEM Gewinner
  // (Fenster bleibt einfach offen, Regel-Zustand aendert sich nicht) jetzt
  // fehlschlagen zu senden, weil der (veraltete) Cache zufaellig schon den
  // richtigen Gewinner enthielt. Mit dem Fix fehlt der Cache-Eintrag
  // komplett -> es wird garantiert wieder gesendet, die Automatik
  // "haengt" nicht mehr fest.
  let afterManualSent = false;
  await engine.onDevicesChanged(["WINDOW-DEVICE"], systemState, async (p, b) => {
    afterManualSent = true;
    sentCommands.push({ path: p, body: b });
    return { code: 200 };
  });
  assert(
    afterManualSent === true,
    "Nach manueller Steuerung sendet die naechste Quellen-Auswertung wieder einen Befehl, auch ohne dass sich der Gewinner geaendert hat"
  );
  assert(
    engine.lastTargetWinner.get(manualCacheKey) === manualCacheRule.id,
    "Duty-Cycle-Cache ist nach dem erzwungenen Resync wieder korrekt gesetzt"
  );

  engine.deleteRule(manualCacheRule.id);
  systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "CLOSED";


  // --- v0.19.0: Fehlgeschlagener Befehl verwirft den Duty-Cycle-Cache ---
  {
    const failEngine = new RuleEngine({ onLog: () => {}, verifyDelayMs: 0 });
    for (const r of [...failEngine.getRules()]) failEngine.deleteRule(r.id);
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
    const failRule = failEngine.addRule(
      { sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, onColor: "RED", onDimLevel: 1 },
      systemState
    );
    failEngine.initFromSystemState(systemState);
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = true;
    await failEngine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async () => {
      throw new Error("Zeitueberschreitung");
    });
    let resent = null;
    await failEngine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (p, b) => {
      resent = b;
      return {};
    });
    assert(resent && resent.dimLevel === 1, "Nach fehlgeschlagenem Senden sendet das naechste Event erneut (Cache verworfen)");
    failEngine.deleteRule(failRule.id);
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
  }

  // --- v0.19.0: Pruefung des gemeldeten Zustands + Wiederholung ---
  {
    const vEngine = new RuleEngine({ onLog: () => {}, verifyDelayMs: 20, maxRetries: 2 });
    for (const r of [...vEngine.getRules()]) vEngine.deleteRule(r.id);
    const ch = systemState.devices["WRC6-DEVICE"].functionalChannels["10"];
    ch.dimLevel = 0;
    ch.opticalSignalBehaviour = "OFF";
    const vRule = vEngine.addRule(
      { sources: [{ deviceId: "LIGHT-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, onColor: "RED", onDimLevel: 1 },
      systemState
    );
    vEngine.initFromSystemState(systemState);
    const sends = [];
    const send = async (p, b) => {
      sends.push(b);
      // Simuliert das beobachtete Fehlerbild: HCU meldet dimLevel 1, aber
      // opticalSignalBehaviour "OFF" (LED dunkel) - erst beim 2. Versuch "ON".
      ch.dimLevel = b.dimLevel;
      ch.opticalSignalBehaviour = sends.length >= 2 ? "ON" : "OFF";
      return {};
    };
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = true;
    await vEngine.onDevicesChanged(["LIGHT-DEVICE"], systemState, send);
    await new Promise((r) => setTimeout(r, 150));
    assert(sends.length === 2, "Abweichender gemeldeter Zustand (opticalSignalBehaviour OFF) fuehrt zu genau einer Wiederholung: " + sends.length);

    // Bleibt der Zustand dauerhaft falsch: hoechstens maxRetries Wiederholungen
    const sends2 = [];
    const badSend = async (p, b) => {
      sends2.push(b);
      ch.dimLevel = b.dimLevel;
      ch.opticalSignalBehaviour = "OFF";
      return {};
    };
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
    await vEngine.onDevicesChanged(["LIGHT-DEVICE"], systemState, badSend); // aus -> dimLevel 0 passt
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = true;
    await vEngine.onDevicesChanged(["LIGHT-DEVICE"], systemState, badSend);
    await new Promise((r) => setTimeout(r, 250));
    assert(sends2.length === 1 + 1 + 2, "Dauerhaft falscher Zustand: 1x aus, 1x an + maximal 2 Wiederholungen: " + sends2.length);

    // Manuelle Steuerung bricht laufende Pruefung ab
    const sends3 = [];
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
    await vEngine.onDevicesChanged(["LIGHT-DEVICE"], systemState, async (p, b) => {
      sends3.push(b);
      ch.dimLevel = 0.7; // haelt sich (scheinbar) nicht an "aus"
      return {};
    });
    vEngine.forgetTargetState("WRC6-DEVICE", 10);
    await new Promise((r) => setTimeout(r, 100));
    assert(sends3.length === 1, "Nach manueller Steuerung wird die geplante Wiederholung verworfen: " + sends3.length);

    vEngine.deleteRule(vRule.id);
    delete ch.opticalSignalBehaviour;
    systemState.devices["LIGHT-DEVICE"].functionalChannels["1"].on = false;
  }

  // --- v0.20.0: Ziel-LED darf nicht eigene Quelle sein ---
  {
    let selfRejected = false;
    try {
      engine.addRule({ sources: [{ deviceId: "WRC6-DEVICE", channelIndex: 10 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 } }, systemState);
    } catch (err) {
      selfRejected = /nicht gleichzeitig Auslöser/.test(err.message);
    }
    assert(selfRejected, "Regel mit Ziel-LED als eigener Quelle wird abgelehnt");
    const r2 = engine.addRule({ sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 } }, systemState);
    let selfPatchRejected = false;
    try {
      engine.updateRule(r2.id, { sources: [{ deviceId: "WRC6-DEVICE", channelIndex: 10 }] }, systemState);
    } catch (err) {
      selfPatchRejected = true;
    }
    assert(selfPatchRejected && r2.sources[0].deviceId === "WINDOW-DEVICE", "Quellen bearbeiten lehnt Ziel-LED als Quelle ab, Regel bleibt unveraendert");
    const r2b = engine.updateRule(r2.id, { sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }, { deviceId: "LIGHT-DEVICE", channelIndex: 1 }], sourceLogic: "AND" }, systemState);
    assert(r2b.sources.length === 2 && r2b.sourceLogic === "AND", "Quellen + Verknuepfung lassen sich per updateRule aendern");
    engine.deleteRule(r2.id);
  }

  // --- v0.21.0: weitere Ausloeser (Feldnamen aus einer echten channel-fields.json) ---
  {
    Object.assign(systemState.devices, {
      "MOTION-DEV": { id: "MOTION-DEV", label: "BWM Flur", modelType: "HmIP-SMI", functionalChannels: {
        "0": { functionalChannelType: "DEVICE_SABOTAGE", lowBat: false, unreach: false, sabotage: false, groups: [] },
        "1": { functionalChannelType: "MOTION_DETECTION_CHANNEL", motionDetected: false, illumination: 120.5, groups: [] } } },
      "SMOKE-DEV": { id: "SMOKE-DEV", label: "Rauchmelder KZ", modelType: "HmIP-SWSD-2", functionalChannels: {
        "0": { functionalChannelType: "DEVICE_BASE", lowBat: null, unreach: false },
        "1": { functionalChannelType: "SMOKE_DETECTOR_CHANNEL", smokeDetectorAlarmType: "IDLE_OFF" } } },
      "WATER-DEV": { id: "WATER-DEV", label: "Wassermelder HWR", modelType: "HmIP-SWD", functionalChannels: {
        "1": { functionalChannelType: "WATER_SENSOR_CHANNEL", waterlevelDetected: false, moistureDetected: false } } },
      "LOCK-DEV": { id: "LOCK-DEV", label: "Türschloss", modelType: "HmIP-DLP-A", functionalChannels: {
        "1": { functionalChannelType: "DOOR_LOCK_PRO_CHANNEL", lockState: "UNLOCKED" } } },
      "THERMO-DEV": { id: "THERMO-DEV", label: "Thermostat Bad", modelType: "HmIP-WTH-1", functionalChannels: {
        "1": { functionalChannelType: "WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL", actualTemperature: 22.0, humidity: 55 } } },
      "PLUG-DEV": { id: "PLUG-DEV", label: "Waschmaschine", modelType: "HmIP-PSMCO", functionalChannels: {
        "1": { functionalChannelType: "SWITCH_MEASURING_CHANNEL", on: true, currentPowerConsumption: 0.5 } } },
      "SYSHEALTH": { id: "SYSHEALTH", label: "SystemHealth", modelType: "SystemHealthDutyCycle", functionalChannels: {
        "1": { functionalChannelType: "GENERIC_CLIMATE_SENSOR_CHANNEL", humidity: 15 } } },
    });
    const opts = RuleEngine.listSourceOptions(systemState);
    const has = (k) => opts.some((o) => o.key === k);
    assert(has("MOTION-DEV::1::motion") && has("MOTION-DEV::1::illumination") && has("MOTION-DEV::0::lowBat") && has("MOTION-DEV::0::sabotage"), "Bewegung, Helligkeit, Batterie, Sabotage werden als Ausloeser angeboten");
    assert(has("SMOKE-DEV::1::smokeAlarm") && !has("SMOKE-DEV::0::lowBat"), "Rauchalarm angeboten; lowBat=null (Netzgeraet) wird NICHT angeboten");
    assert(has("WATER-DEV::1::water") && has("LOCK-DEV::1::unlocked"), "Wasser und Schloss werden angeboten");
    assert(has("THERMO-DEV::1::temperature") && has("THERMO-DEV::1::humidity") && has("PLUG-DEV::1::power") && has("PLUG-DEV::1::on"), "Temperatur, Luftfeuchte, Leistung, an/aus werden angeboten");
    assert(!has("SYSHEALTH::1::humidity"), "SystemHealth-Pseudogeraet wird nicht als Luftfeuchte angeboten");

    const e = new RuleEngine({ onLog: () => {}, verifyDelayMs: 0 });
    for (const r of [...e.getRules()]) e.deleteRule(r.id);
    let missingThreshold = false;
    try { e.addRule({ sources: [{ deviceId: "PLUG-DEV", channelIndex: 1, condition: "power" }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 } }, systemState); }
    catch (err) { missingThreshold = /Grenzwert/.test(err.message); }
    assert(missingThreshold, "Schwellwert-Quelle ohne Grenzwert wird abgelehnt");
    let wrongCond = false;
    try { e.addRule({ sources: [{ deviceId: "LOCK-DEV", channelIndex: 1, condition: "motion" }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 } }, systemState); }
    catch (err) { wrongCond = /passt nicht/.test(err.message); }
    assert(wrongCond, "Bedingung, die nicht zum Kanal passt, wird abgelehnt");

    const sends = [];
    const send = async (p, b) => { sends.push(b); return {}; };
    const powerRule = e.addRule({ sources: [{ deviceId: "PLUG-DEV", channelIndex: 1, condition: "power", op: ">", threshold: 5 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, onColor: "BLUE" }, systemState);
    e.initFromSystemState(systemState);
    const plug = systemState.devices["PLUG-DEV"].functionalChannels["1"];
    plug.currentPowerConsumption = 40; await e.onDevicesChanged(["PLUG-DEV"], systemState, send);
    assert(sends.length === 1 && sends[0].dimLevel === 1, "Leistung 40 W > 5 W schaltet LED an");
    plug.currentPowerConsumption = 4.8; await e.onDevicesChanged(["PLUG-DEV"], systemState, send);
    assert(sends.length === 1, "Hysterese: 4,8 W (knapp unter 5 W) schaltet NICHT sofort aus");
    plug.currentPowerConsumption = 1; await e.onDevicesChanged(["PLUG-DEV"], systemState, send);
    assert(sends.length === 2 && sends[1].dimLevel === 0, "1 W schaltet LED aus");
    plug.currentPowerConsumption = 4.8; await e.onDevicesChanged(["PLUG-DEV"], systemState, send);
    assert(sends.length === 2, "4,8 W von unten: bleibt aus (Grenze 5 W)");
    const status = e.getRulesWithStatus(systemState).find((r) => r.id === powerRule.id);
    assert(status.sources[0].conditionText === "Leistung > 5 W", "Regel-Anzeige: " + status.sources[0].conditionText);
    e.deleteRule(powerRule.id);

    const tempRule = e.addRule({ sources: [{ deviceId: "THERMO-DEV", channelIndex: 1, condition: "temperature", op: "<", threshold: 19 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 } }, systemState);
    e.initFromSystemState(systemState);
    sends.length = 0;
    systemState.devices["THERMO-DEV"].functionalChannels["1"].actualTemperature = 18.5;
    await e.onDevicesChanged(["THERMO-DEV"], systemState, send);
    assert(sends.length === 1 && sends[0].dimLevel === 1, "Temperatur 18,5 < 19 °C schaltet an");
    e.deleteRule(tempRule.id);

    const multi = e.addRule({
      sources: [
        { deviceId: "MOTION-DEV", channelIndex: 1, condition: "motion" },
        { deviceId: "SMOKE-DEV", channelIndex: 1, condition: "smokeAlarm" },
        { deviceId: "WATER-DEV", channelIndex: 1, condition: "water" },
        { deviceId: "MOTION-DEV", channelIndex: 0, condition: "lowBat" },
      ],
      target: { deviceId: "WRC6-DEVICE", channelIndex: 10 },
    }, systemState);
    e.initFromSystemState(systemState);
    sends.length = 0;
    systemState.devices["SMOKE-DEV"].functionalChannels["1"].smokeDetectorAlarmType = "PRIMARY_ALARM";
    await e.onDevicesChanged(["SMOKE-DEV"], systemState, send);
    assert(sends.length === 1 && sends[0].dimLevel === 1, "Rauchalarm (Wert != IDLE_OFF) schaltet an");
    systemState.devices["SMOKE-DEV"].functionalChannels["1"].smokeDetectorAlarmType = "IDLE_OFF";
    systemState.devices["MOTION-DEV"].functionalChannels["0"].lowBat = true;
    await e.onDevicesChanged(["SMOKE-DEV", "MOTION-DEV"], systemState, send);
    assert(sends.length === 1, "Batterie schwach haelt die LED an (ODER), kein neuer Befehl");
    systemState.devices["MOTION-DEV"].functionalChannels["0"].lowBat = false;
    systemState.devices["WATER-DEV"].functionalChannels["1"].moistureDetected = true;
    await e.onDevicesChanged(["MOTION-DEV", "WATER-DEV"], systemState, send);
    assert(sends.length === 1, "Feuchtigkeit haelt die LED an");
    systemState.devices["WATER-DEV"].functionalChannels["1"].moistureDetected = false;
    await e.onDevicesChanged(["WATER-DEV"], systemState, send);
    assert(sends.length === 2 && sends[1].dimLevel === 0, "Alle Ausloeser in Ruhe -> LED aus");
    e.deleteRule(multi.id);

    // Alte Regel ohne condition (wie in aelteren Sicherungen) bleibt auswertbar
    // und bekommt in der Anzeige die abgeleitete Bedingung.
    const legacy = e.addRule({ sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 } }, systemState);
    delete legacy.sources[0].condition; // simuliert eine vor v0.21.0 gespeicherte Regel
    const legacyStatus = e.getRulesWithStatus(systemState).find((r) => r.id === legacy.id);
    assert(legacyStatus.sources[0].effectiveCondition === "windowOpen", "Alte Fenster-Regel ohne condition wird als 'offen/gekippt' erkannt");
    e.initFromSystemState(systemState);
    sends.length = 0;
    systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "TILTED";
    await e.onDevicesChanged(["WINDOW-DEVICE"], systemState, send);
    assert(sends.length === 1 && sends[0].dimLevel === 1, "Alte Regel ohne condition schaltet weiterhin bei gekipptem Fenster");
    systemState.devices["WINDOW-DEVICE"].functionalChannels["1"].windowState = "CLOSED";
    e.deleteRule(legacy.id);

    for (const id of ["MOTION-DEV", "SMOKE-DEV", "WATER-DEV", "LOCK-DEV", "THERMO-DEV", "PLUG-DEV", "SYSHEALTH"]) delete systemState.devices[id];
  }

  // --- v0.23.0: HCUweb-Einstellungsseite mit Adresse der Weboberflaeche ---
  {
    const { resolveWebUrl, buildConfigTemplate } = require("./src/hcuConfig");
    const sg = path.join(process.env.WRC6_DATA_DIR, "SGTIN");
    fs.writeFileSync(sg, "0000000000000000000ABCD\n");
    const url = resolveWebUrl({ webPort: 8099, sgtinFile: sg, env: {} });
    assert(url === "http://hcu1-ABCD.local:8099", "Adresse aus SGTIN: " + url);
    assert(resolveWebUrl({ webPort: 8099, sgtinFile: sg, env: { WEB_PUBLIC_URL: "http://192.168.1.50:8099" } }) === "http://192.168.1.50:8099", "WEB_PUBLIC_URL ueberschreibt die Adresse");
    assert(resolveWebUrl({ webPort: 8099, sgtinFile: "/gibt/es/nicht", env: {} }) === "http://localhost:8099", "Ohne SGTIN: localhost");
    const tpl = buildConfigTemplate("de", url);
    assert(tpl.properties && tpl.properties.webUrl.dataType === "READONLY" && tpl.properties.webUrl.currentValue === url, "Template: READONLY-Feld mit Adresse (Pflichtfeld 'properties')");
    assert(tpl.properties.webQr.dataType === "QRCODE" && tpl.groups.web.friendlyName === "Weboberfläche", "Template: QR-Code und Gruppe");
    assert(tpl.properties.webLink.dataType === "WEBLINK" && tpl.properties.webLink.currentValue === url, "Template: WEBLINK mit Adresse");
    assert(!tpl.properties.webLinkHtml && !tpl.properties.webLinkMd, "Testvarianten A/B entfernt");
    // SystemInfoRequest/-Response: IP-Adresse der HCU fuer den Link
    const { ConnectApiClient } = require("./src/connectApi");
    const c = new ConnectApiClient({ pluginId: "p", host: "x", authToken: "t", onLog: () => {} });
    const sent = [];
    c._send = (m) => {
      sent.push(m);
      if (m.type === "SYSTEM_INFO_REQUEST") setTimeout(() => c._handleMessage({ id: m.id, type: "SYSTEM_INFO_RESPONSE", body: { isOnlineMode: true, success: true, ipAddress: "192.168.1.50" } }), 10);
      return true;
    };
    c.setConfigTemplateProvider((l) => buildConfigTemplate(l, c.hcuIpAddress ? `http://${c.hcuIpAddress}:8099` : url));
    c._handleMessage({ id: "t1", type: "CONFIG_TEMPLATE_REQUEST", body: { languageCode: "de" } });
    await new Promise((r) => setTimeout(r, 100));
    const resp = sent.find((m) => m.id === "t1");
    assert(sent[0].type === "SYSTEM_INFO_REQUEST" && resp && resp.body.properties.webLink.currentValue === "http://192.168.1.50:8099", "Link nutzt die IP-Adresse aus der SystemInfoResponse");
    c._handleMessage({ id: "u1", type: "CONFIG_UPDATE_REQUEST", body: {} });
    assert(sent.find((m) => m.id === "u1").body.status === "APPLIED", "Speichern wird mit APPLIED bestaetigt");
    assert(buildConfigTemplate("en", url).groups.web.friendlyName === "Web interface", "Template englisch");
  }

  // --- v0.28.0: Relais-Kanal 8 des WRC6-230 ist keine LED ---
  {
    systemState.devices["WRC6-DEVICE"].functionalChannels["8"] = { functionalChannelType: "SWITCH_CHANNEL", index: 8, label: "LED Relais", on: false };
    let relayRejected = false;
    try {
      engine.addRule({ sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 8 } }, systemState);
    } catch (err) {
      relayRejected = /keine LED/.test(err.message);
    }
    assert(relayRejected, "Relais-Kanal 8 (SWITCH_CHANNEL) wird als LED-Ziel abgelehnt");
    const dev = systemState.devices["WRC6-DEVICE"];
    assert(!RuleEngine.isTargetChannel(dev, dev.functionalChannels["8"]) && RuleEngine.isTargetChannel(dev, dev.functionalChannels["10"]), "isTargetChannel: Relais nein, LED ja");
    const relaySrc = RuleEngine.listSourceOptions(systemState).some((o) => o.key === "WRC6-DEVICE::8::on");
    assert(relaySrc, "Relais bleibt als Ausloeser waehlbar");
    delete dev.functionalChannels["8"];
  }

  // --- v0.30.0: Regeln sichern / laden ---
  {
    const src = new RuleEngine({ onLog: () => {}, verifyDelayMs: 0 });
    for (const r of [...src.getRules()]) src.deleteRule(r.id);
    const r1 = src.addRule({ sources: [{ deviceId: "WINDOW-DEVICE", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 }, onColor: "RED", onDimLevel: 0.7 }, systemState);
    src.updateRule(r1.id, { enabled: false }, systemState);
    const exported = JSON.parse(JSON.stringify(src.exportRules()));
    assert(exported.format === "wrc6-led-rules" && exported.rules.length === 1, "Export im eigenen Format");
    for (const r of [...src.getRules()]) src.deleteRule(r.id);
    const res1 = src.importRules(exported, systemState);
    const back = src.getRules()[0];
    assert(res1.imported === 1 && back.target.onColor === "RED" && back.target.onDimLevel === 0.7 && back.enabled === false && back.sources[0].condition === "windowOpen", "Import stellt Regel inkl. Farbe, Helligkeit, ausgeschaltet und Bedingung wieder her");
    // Altes Format: Antwort von GET /api/rules (mit Zusatzfeldern) + unbekanntes Geraet
    const old = [{ ...exported.rules[0], matches: true, active: false, sources: [{ ...exported.rules[0].sources[0], effectiveCondition: "windowOpen", conditionText: "offen/gekippt" }] },
                 { enabled: true, sources: [{ deviceId: "GIBT-ES-NICHT", channelIndex: 1 }], target: { deviceId: "WRC6-DEVICE", channelIndex: 10 } }];
    const res2 = src.importRules(old, systemState);
    assert(res2.imported === 1 && res2.skipped.length === 1 && res2.skipped[0].index === 2, "Import alter /api/rules-Antwort; unbekanntes Geraet wird mit Grund uebersprungen: " + JSON.stringify(res2.skipped));
    let bad = false;
    try { src.importRules({ foo: 1 }, systemState); } catch (err) { bad = /keine Regeln/.test(err.message); }
    assert(bad, "Datei ohne Regeln wird abgelehnt");
    for (const r of [...src.getRules()]) src.deleteRule(r.id);
  }

  // --- v0.19.0: Tests laufen in eigenem Datenverzeichnis ---
  assert(RuleEngine.DATA_DIR === process.env.WRC6_DATA_DIR && !RuleEngine.DATA_DIR.endsWith(path.join("hcu-wrc6-plugin", "data")), "Smoketest nutzt ein temporaeres Datenverzeichnis, nicht die echte data/rules.json");

  server.close();
  console.log("\nAlle Smoke-Tests erfolgreich.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
