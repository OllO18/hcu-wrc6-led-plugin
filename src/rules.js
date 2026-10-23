"use strict";

/**
 * Regel-Engine: "Wenn Quell-Kanal einen bestimmten Zustand annimmt, dann
 * Ziel-Kanal (eine WRC6-230-LED) auf denselben (oder invertierten) Zustand
 * bringen."
 *
 * Ziel-Kanaele sind bewusst auf Geraete vom Modell "HmIP-WRC6-230"
 * beschraenkt (siehe TARGET_MODEL_TYPE) - dieses Plugin dient ausschliesslich
 * dazu, WRC6-230-LEDs anzusteuern, nicht beliebige andere Aktoren.
 *
 * Quell-Kanaele koennen dagegen von jedem Geraetetyp kommen, dessen Kanal
 * einen der folgenden, tatsaechlich in der Connect-API-Dokumentation
 * belegten Zustandsfelder besitzt:
 *   - "on" (boolean)                    - Schalter/Steckdosen etc.
 *   - "dimLevel" (0.0-1.0)              - dimmbare Kanaele (Lampen, LEDs)
 *   - "windowState" ("OPEN"/"CLOSED"/"TILTED") - Fenster-/Tuerkontakte
 * Weitere Feldnamen werden bewusst NICHT geraten, sondern erst ergaenzt,
 * sobald sie an einem echten Geraet bestaetigt sind (siehe readBooleanState).
 * (Die Feldnamen aus Kapitel 6.7 der Doku, z.B. presenceDetected,
 * actualTemperature, gehoeren zum Feature-Schema fuer virtuelle
 * "Include devices" eines Plugins, NICHT zu den nativen functionalChannels,
 * die getSystemState fuer bereits vorhandene Geraete liefert - deshalb
 * bewusst nicht uebernommen, ohne das an einem echten Geraet zu verifizieren.)
 *
 * Eine Regel kann MEHRERE Quell-Kanaele haben (sources: Array), verknuepft
 * per rule.sourceLogic entweder ODER (Standard: "LED an, wenn Fenster 1
 * ODER Fenster 2 offen ist") oder UND ("LED an, NUR wenn Fenster 1 UND
 * Fenster 2 GLEICHZEITIG offen sind"). Zur Abwaertskompatibilitaet mit vor
 * dieser Aenderung gespeicherten Regeln (einzelnes Feld "source", fehlendes
 * "sourceLogic") wird beim Laden automatisch migriert (siehe _load).
 *
 * PRIORITAET/Konfliktfall: mehrere aktivierte Regeln koennen dasselbe Ziel
 * haben (z.B. "Fenster OG offen" -> rot, "Fenster UG offen" -> gruen,
 * "Fenster OG UND UG offen" -> gelb). Treffen mehrere davon gleichzeitig zu,
 * gewinnt IMMER die Regel mit der hoechsten Prioritaet - das ist schlicht
 * ihre Position in der Regel-Liste (this.rules), oben = hoechste Prioritaet,
 * per moveRule() verschiebbar. So bleibt es immer eindeutig, welche Farbe
 * tatsaechlich anliegt, statt dass sich mehrere gleichzeitig zutreffende
 * Regeln in zufaelliger Reihenfolge gegenseitig ueberschreiben. Siehe
 * _evaluateGroup/_groupRulesByTarget/_dispatchTarget.
 *
 * Quellen lassen sich in der Oberflaeche nach Kanal-Typ und nach Raum
 * filtern. Der Raum eines Kanals wird aus dessen "groups"-Array ermittelt:
 * jede darin referenzierte Gruppen-ID wird im "groups"-Objekt des
 * Systemzustands nachgeschlagen; die Gruppe mit type "META" ist die
 * Raum-Zuordnung, ihr "label" der Raumname (Beispiel in Kapitel 6.8.6.4 der
 * Doku, "getSystemState": Kanal-Feld "groups": [...], Gruppen-Feld "type":
 * "META", "label": "<Raumname>").
 *
 * Der Kanal-Typ des Ziels (schaltbar, dimmbar oder farbig) wird beim
 * Anlegen der Regel anhand des aktuellen Systemzustands ermittelt und in
 * der Regel gespeichert, damit zur Laufzeit der richtige Connect-API-Pfad
 * verwendet wird:
 *   - Kanal hat Felder "dimLevel" + "simpleRGBColorState" -> RGB_DIM,
 *     Pfad /hmip/device/control/setSimpleRGBColorDimLevel (Farbe + Helligkeit)
 *   - Kanal hat nur ein Feld "dimLevel"  -> DIM, /hmip/device/control/setDimLevel
 *   - Kanal hat ein Feld "on"            -> SWITCH, /hmip/device/control/setSwitchState
 *
 * Die WRC6-230-Signal-LEDs unterstuetzen laut Connect-API-Dokumentation
 * (setSimpleRGBColorDimLevel) genau 8 feste Farben, keine frei waehlbare
 * RGB-Palette: BLACK, BLUE, GREEN, TURQUOISE, RED, PURPLE, YELLOW, WHITE.
 *
 * Persistiert wird als JSON-Datei. Im installierten Plugin liegt das
 * Verzeichnis /data (siehe Containerization-Kapitel der Doku: Inhalte dort
 * ueberleben Updates und Neustarts). Fuer lokale Tests wird ersatzweise
 * ./data verwendet.
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const {
  CONDITIONS,
  OPERATORS,
  legacyCondition,
  conditionsForChannel,
  normalizeSourceCondition,
  describeCondition,
} = require("./conditions");

// WRC6_DATA_DIR erlaubt ein abweichendes Datenverzeichnis - wird von
// smoketest.js/dev-test-server.js genutzt, damit Tests NIE die echte
// data/rules.json ueberschreiben oder leeren (Fehler bis v0.18.5).
const DATA_DIR =
  process.env.WRC6_DATA_DIR || (fs.existsSync("/data") ? "/data" : path.join(__dirname, "..", "data"));
const RULES_FILE = path.join(DATA_DIR, "rules.json");

/** Einziges erlaubtes Ziel-Geraetemodell - siehe Modul-Kommentar oben. */
const TARGET_MODEL_TYPE = "HmIP-WRC6-230";

/**
 * Nur diese Kanaltypen sind LEDs und duerfen Ziel einer Regel sein.
 * Der HmIP-WRC6-230 hat ausserdem ein eingebautes Relais (Schaltkanal 8,
 * SWITCH_CHANNEL, laut Anleitung "Relais 1x Schliesser", Klemme 1 "Lampe")
 * und einen Nebenstelleneingang (Kanal 7). Bis v0.27.1 wurde Kanal 8
 * faelschlich als "LED" angeboten - eine Regel darauf haette das Relais
 * geschaltet. NOTIFICATION_LIGHT_CHANNEL ist fuer die Testdaten enthalten
 * (beim echten WRC6-230 nicht beobachtet).
 */
const TARGET_CHANNEL_TYPES = ["OPTICAL_SIGNAL_CHANNEL", "OPTICAL_SIGNAL_GROUP_CHANNEL", "NOTIFICATION_LIGHT_CHANNEL"];

/**
 * Exakt die von der Connect API (Feld "simpleRGBColorState" in
 * setSimpleRGBColorDimLevel) erlaubten Werte - nicht erweitern, ohne das
 * in der Doku zu pruefen.
 */
const SIMPLE_RGB_COLORS = ["BLACK", "BLUE", "GREEN", "TURQUOISE", "RED", "PURPLE", "YELLOW", "WHITE"];

/**
 * Erlaubte Werte fuer "opticalSignalBehaviour" beim Connect-API-Endpunkt
 * /hmip/device/control/setOpticalSignal (Doku Kapitel 6.8.1.21) - wortwoertlich
 * aus der offiziellen Doku uebernommen, nicht erraten. OFF/ON kommen in
 * diesem Plugin nicht zum Einsatz (dafuer gibt es bereits setDimLevel/
 * setSimpleRGBColorDimLevel), stehen hier aber vollstaendigkeitshalber mit.
 */
const OPTICAL_SIGNAL_BEHAVIOURS = ["OFF", "ON", "BLINKING_MIDDLE", "FLASH_MIDDLE", "BILLOW_MIDDLE"];

/** Pruefung nach dem Senden: nach VERIFY_DELAY_MS wird der von der HCU
 * zurueckgemeldete Kanalzustand mit dem gesendeten Befehl verglichen und
 * bei Abweichung bis zu MAX_RETRIES mal erneut gesendet (siehe
 * RuleEngine._scheduleVerify). */
const DEFAULT_VERIFY_DELAY_MS = 5000;
const DEFAULT_MAX_RETRIES = 2;

const PATH_SET_SIMPLE_RGB = "/hmip/device/control/setSimpleRGBColorDimLevel";
const PATH_SET_OPTICAL_SIGNAL = "/hmip/device/control/setOpticalSignal";
const PATH_SET_DIM_LEVEL = "/hmip/device/control/setDimLevel";
const PATH_SET_SWITCH_STATE = "/hmip/device/control/setSwitchState";

/** Dokumentierte Obergrenze fuer "onTime"/"rampTime" bei den "...WithTime"-
 * Endpunkten (0.1 - 16383 Sekunden, siehe z.B. Kapitel 6.8.1.11). */
const MAX_ON_TIME_SECONDS = 16383;

/**
 * Verknuepfung der Quellen EINER Regel untereinander. "OR" (Standard, siehe
 * Modul-Kommentar) loest aus, sobald IRGENDEINE Quelle an ist. "AND" loest
 * erst aus, wenn WIRKLICH ALLE Quellen gleichzeitig an sind - z.B. "Fenster
 * OG UND Fenster UG offen -> LED gelb", als eigene, praezisere Regel neben
 * zwei einfacheren ODER-Regeln fuer je ein Fenster alleine (siehe
 * PRIORITAET/moveRule weiter unten fuer den Fall, dass mehrere Regeln fuer
 * dasselbe Ziel gleichzeitig zutreffen).
 */
const SOURCE_LOGIC_VALUES = ["OR", "AND"];

class RuleEngine {
  /**
   * @param {object} opts
   * @param {Function} opts.onLog
   * @param {number} [opts.verifyDelayMs]  Wartezeit bis zur Pruefung des
   *   zurueckgemeldeten Zustands (Standard 5000 ms). 0 = Pruefung aus
   *   (fuer Tests).
   * @param {number} [opts.maxRetries]  maximale Wiederholungen je Befehl
   *   (Standard 2, Duty-Cycle-Schonung).
   */
  constructor({ onLog, verifyDelayMs, maxRetries } = {}) {
    this.onLog = onLog || (() => {});
    this.verifyDelayMs = typeof verifyDelayMs === "number" ? verifyDelayMs : DEFAULT_VERIFY_DELAY_MS;
    this.maxRetries = typeof maxRetries === "number" ? maxRetries : DEFAULT_MAX_RETRIES;
    /**
     * Alle Auswertungen/Befehle laufen strikt nacheinander durch diese
     * Warteschlange (siehe _enqueue) - vorher konnten sich schnell
     * aufeinanderfolgende HCU-Events und Aktionen aus der Oberflaeche
     * zeitlich ueberlappen.
     */
    this._queue = Promise.resolve();
    /** targetKey -> laufende Nummer des zuletzt gesendeten Befehls. Eine
     * Pruefung/Wiederholung gilt nur, solange seither kein neuerer Befehl
     * (oder eine manuelle Steuerung) fuer dieses Ziel kam. */
    this.sendSeq = new Map();
    this.rules = this._load();
    /** ruleId -> zuletzt bekannter boolescher Zustand der Quelle(n) dieser Regel */
    this.lastSourceState = new Map();
    /**
     * targetKey ("deviceId::channelIndex") -> id der Regel, die dieses Ziel
     * zuletzt tatsaechlich gesteuert hat (oder null, wenn zuletzt "aus").
     * Dient dazu, bei onDevicesChanged unnoetige Wiederholungs-Funkbefehle zu
     * vermeiden (Duty-Cycle, siehe enforceAllRules-Kommentar), jetzt aber pro
     * ZIEL statt pro Regel, weil mehrere Regeln dasselbe Ziel teilen koennen
     * (siehe PRIORITAET unten).
     */
    this.lastTargetWinner = new Map();
    /** "ruleId|quellenIndex" -> letzter Ergebnis einer Schwellwert-Quelle (Hysterese). */
    this.numericLatch = new Map();
    this.logBuffer = []; // Ring-Buffer der letzten Aktionen fuer die Web-UI
  }

  log(level, message, meta) {
    this.onLog({ level, message, meta, ts: Date.now() });
  }

  /**
   * Nach einer manuellen Direktsteuerung eines WRC6-Kanals (POST
   * /api/control, siehe webServer.js) den internen Duty-Cycle-Cache
   * (lastTargetWinner) fuer GENAU dieses Ziel verwerfen.
   *
   * Hintergrund (Nutzer-Feedback: "nach Nutzung der manuellen Schaltung
   * laeuft die Automatik gar nicht mehr"): /api/control steuert das
   * Geraet direkt ueber die Connect API, OHNE ueber die Regel-Engine zu
   * gehen - lastTargetWinner (siehe oben) weiss davon nichts und bleibt
   * auf dem Stand VOR der manuellen Aktion stehen. Beim naechsten echten
   * Quellen-Ereignis vergleicht onDevicesChanged den neu berechneten
   * Gewinner dann faelschlicherweise gegen diesen veralteten Stand - wenn
   * beide zufaellig uebereinstimmen, denkt die Pruefung "kein echter
   * Wechsel" (Duty-Cycle-Schutz) und sendet GAR KEINEN Befehl mehr, obwohl
   * sich der tatsaechliche Geraetezustand durch die manuelle Aktion
   * veraendert hat. Die Automatik "haengt" dann fest, bis zufaellig wieder
   * ein Gewinner-Wechsel eintritt, der vom alten Cache-Stand abweicht.
   *
   * Das Verwerfen hier loest KEINEN sofortigen Befehl aus (die manuelle
   * Aktion bleibt zunaechst wirksam, wird nicht sofort ueberschrieben) -
   * es sorgt nur dafuer, dass die naechste echte Quellen-Aenderung
   * garantiert wieder einen Befehl ausloest, egal was der alte Cache-Stand
   * war.
   */
  forgetTargetState(deviceId, channelIndex) {
    const key = `${deviceId}::${channelIndex}`;
    this.lastTargetWinner.delete(key);
    // Laufende Pruefung/Wiederholung fuer dieses Ziel verwerfen - sonst
    // koennte sie die manuelle Einstellung kurz darauf wieder ueberschreiben.
    this.sendSeq.set(key, (this.sendSeq.get(key) || 0) + 1);
  }

  _pushLogEntry(entry) {
    this.logBuffer.unshift({ ts: Date.now(), ...entry });
    if (this.logBuffer.length > 200) this.logBuffer.length = 200;
  }

  getLog() {
    return this.logBuffer;
  }

  _load() {
    // Erste Installation auf der HCU: /data ist noch leer -> mitgelieferte
    // Startregeln (seed/rules.json im Image) einmalig uebernehmen. Danach
    // gilt ausschliesslich /data/rules.json (bleibt bei Updates erhalten).
    // Bewusst nur fuer /data, damit lokale Tests (WRC6_DATA_DIR) leer starten.
    const seedFile = path.join(__dirname, "..", "seed", "rules.json");
    if (DATA_DIR === "/data" && !fs.existsSync(RULES_FILE) && fs.existsSync(seedFile)) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.copyFileSync(seedFile, RULES_FILE);
        this.log("info", "Startregeln aus seed/rules.json uebernommen.");
      } catch (err) {
        this.log("warn", "Startregeln konnten nicht uebernommen werden", { error: err.message });
      }
    }
    let rules;
    try {
      const raw = fs.readFileSync(RULES_FILE, "utf8");
      rules = JSON.parse(raw);
    } catch (err) {
      return [];
    }
    // Migration: vor der Mehrfachauswahl gespeicherte Regeln hatten ein
    // einzelnes Feld "source" statt eines "sources"-Arrays.
    for (const rule of rules) {
      if (!rule.sources && rule.source) {
        rule.sources = [rule.source];
        delete rule.source;
      }
      // Migration: vor der UND/ODER-Auswahl gespeicherte Regeln kannten nur
      // ODER - Standardwert ergaenzen, damit sich am Verhalten nichts aendert.
      if (!rule.sourceLogic) rule.sourceLogic = "OR";
    }
    return rules;
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(RULES_FILE, JSON.stringify(this.rules, null, 2), "utf8");
    } catch (err) {
      this.log("error", "Konnte Regeln nicht speichern", { error: err.message });
    }
  }

  getRules() {
    return this.rules;
  }

  /**
   * Liest einen booleschen Zustand ("ausgeloest"/"an") eines Funktionskanals
   * aus dem gecachten Systemzustand. Gibt null zurueck, wenn der Kanal
   * keines der unterstuetzten Zustandsfelder besitzt (siehe Modul-Kommentar
   * fuer die Quelle jedes Feldnamens in der Doku).
   */
  static readBooleanState(channel) {
    if (!channel) return null;
    if (typeof channel.on === "boolean") return channel.on;
    if (typeof channel.dimLevel === "number") return channel.dimLevel > 0;
    if (typeof channel.windowState === "string") {
      // OPEN oder TILTED (gekippt) gelten als "ausgeloest"; CLOSED als "aus".
      return channel.windowState === "OPEN" || channel.windowState === "TILTED";
    }
    return null;
  }

  /** Menschlich lesbare Beschriftung des aktuellen Zustands fuer die UI. */
  static describeState(channel) {
    if (typeof channel.windowState === "string") {
      return channel.windowState === "CLOSED" ? "GESCHLOSSEN" : "OFFEN";
    }
    const isOn = RuleEngine.readBooleanState(channel);
    if (isOn === null) return null;
    return isOn ? "AN" : "AUS";
  }

  static resolveControlType(channel) {
    if (!channel) return null;
    if (typeof channel.dimLevel === "number" && typeof channel.simpleRGBColorState === "string") {
      return "RGB_DIM";
    }
    if (typeof channel.dimLevel === "number") return "DIM";
    if (typeof channel.on === "boolean") return "SWITCH";
    // windowState ist rein lesbar (ein Fenster laesst sich nicht per API
    // "setzen") - daher hier bewusst kein controlType, damit solche Kanaele
    // nur als Quelle, nie als Ziel waehlbar sind.
    return null;
  }

  /**
   * Ermittelt den Raumnamen eines Kanals. Laut Beispiel in Kapitel 6.8.6.3
   * der Doku ("getStateForClient") haengt die META-Raumgruppe meist am
   * Basiskanal (Index 0) eines Geraets, WAEHREND der eigentliche
   * Funktionskanal (z.B. der Schalter- oder Fensterkontakt-Kanal) oft nur
   * eine andere Gruppe referenziert (z.B. eine SECURITY-Gruppe), die
   * ihrerseits ein Feld "metaGroupId" besitzt, das auf die META-Gruppe
   * zeigt. Es werden daher drei Wege probiert, in dieser Reihenfolge:
   *   1. Der Kanal selbst referenziert direkt eine META-Gruppe.
   *   2. Eine vom Kanal referenzierte Gruppe hat ein "metaGroupId"-Feld.
   *   3. Der Basiskanal (Index 0) desselben Geraets referenziert eine
   *      META-Gruppe (haeufigster Fall laut Doku-Beispiel).
   * Liefert "", wenn sich auf keinem dieser Wege ein Raum ermitteln laesst.
   */
  static resolveRoomLabel(systemState, channel, device) {
    if (!systemState.groups) return "";

    const tryChannelGroups = (groupIds) => {
      if (!Array.isArray(groupIds)) return "";
      for (const groupId of groupIds) {
        const group = systemState.groups[groupId];
        if (!group) continue;
        if (group.type === "META") return group.label || "";
      }
      for (const groupId of groupIds) {
        const group = systemState.groups[groupId];
        if (group && group.metaGroupId) {
          const meta = systemState.groups[group.metaGroupId];
          if (meta) return meta.label || "";
        }
      }
      return "";
    };

    let label = tryChannelGroups(channel && channel.groups);
    if (!label && device && device.functionalChannels) {
      const baseChannel = device.functionalChannels["0"];
      if (baseChannel) label = tryChannelGroups(baseChannel.groups);
    }
    return label;
  }

  static describeChannel(systemState, deviceId, channelIndex) {
    const device = systemState.devices[deviceId];
    if (!device) return null;
    const channel = device.functionalChannels && device.functionalChannels[String(channelIndex)];
    if (!channel) return null;
    const controlType = RuleEngine.resolveControlType(channel);
    return {
      deviceId,
      channelIndex: Number(channelIndex),
      deviceLabel: device.label || device.modelType || deviceId,
      modelType: device.modelType || "",
      channelLabel: channel.label || "",
      channelType: channel.functionalChannelType || "",
      roomLabel: RuleEngine.resolveRoomLabel(systemState, channel, device),
      controlType,
      isOn: RuleEngine.readBooleanState(channel),
      stateLabel: RuleEngine.describeState(channel),
      supportsColor: controlType === "RGB_DIM",
      currentDimLevel: typeof channel.dimLevel === "number" ? channel.dimLevel : null,
      currentColor: typeof channel.simpleRGBColorState === "string" ? channel.simpleRGBColorState : null,
    };
  }

  /**
   * Prueft, dass deviceId/channelIndex ein steuerbarer Kanal eines
   * HmIP-WRC6-230 ist, und liefert dessen describeChannel()-Info. Wirft
   * andernfalls einen Fehler mit verstaendlicher Meldung. Wird sowohl beim
   * Anlegen von Regeln als auch bei der manuellen Direktsteuerung genutzt,
   * damit beide Wege dieselbe Beschraenkung durchsetzen.
   */
  static assertWrc6Target(systemState, deviceId, channelIndex) {
    const info = RuleEngine.describeChannel(systemState, deviceId, channelIndex);
    if (!info || !info.controlType) {
      throw new Error("Die gewählte LED wurde nicht gefunden oder lässt sich nicht schalten.");
    }
    if (info.modelType !== TARGET_MODEL_TYPE) {
      throw new Error(`Als LED ist nur ein Wandtaster ${TARGET_MODEL_TYPE} möglich (gewählt: ${info.modelType || "unbekannt"}).`);
    }
    if (!TARGET_CHANNEL_TYPES.includes(info.channelType)) {
      throw new Error(`Kanal ${info.channelIndex} ist keine LED (z. B. das eingebaute Relais) und kann nicht als LED gewählt werden.`);
    }
    return info;
  }

  /** Ist dieser Kanal eine waehlbare LED? (fuer Oberflaeche/API) */
  static isTargetChannel(device, channel) {
    return (
      !!device &&
      !!channel &&
      device.modelType === TARGET_MODEL_TYPE &&
      TARGET_CHANNEL_TYPES.includes(channel.functionalChannelType) &&
      RuleEngine.resolveControlType(channel) !== null
    );
  }

  /**
   * Legt eine neue Regel an. Wirft einen Fehler, wenn eine der Quellen oder
   * das Ziel anhand des aktuellen Systemzustands nicht auswertbar/steuerbar
   * sind.
   *
   * sources: Array von {deviceId, channelIndex}, mindestens ein Eintrag.
   * Die Regel loest aus, sobald IRGENDEINE Quelle "an"/ausgeloest ist
   * (ODER-Verknuepfung, siehe Modul-Kommentar) - z.B. mehrere Fenster als
   * Quelle fuer dieselbe LED.
   *
   * Bei einem RGB_DIM-Ziel (WRC6-230-LED mit Farbunterstuetzung) koennen
   * optional onDimLevel (0.0-1.0, Standard 1.0) und onColor (einer von
   * SIMPLE_RGB_COLORS, Standard "WHITE") angegeben werden - das ist der
   * Zustand, der beim Ausloesen gesetzt wird. Beim Zurueckwechseln (keine
   * Quelle mehr ausgeloest) wird die LED schlicht ausgeschaltet (dimLevel 0).
   */
  addRule({ source, sources, target, invert, onDimLevel, onColor, onBehaviour, sourceLogic }, systemState) {
    // Abwaertskompatibel: ein einzelnes "source"-Objekt wird wie ein
    // Array mit einem Eintrag behandelt.
    const sourceList = Array.isArray(sources) && sources.length > 0 ? sources : source ? [source] : [];
    if (sourceList.length === 0) {
      throw new Error("Bitte mindestens einen Auslöser auswählen.");
    }

    const sourceInfos = sourceList.map((s) => RuleEngine._buildSource(systemState, s));

    const targetInfo = RuleEngine.assertWrc6Target(systemState, target.deviceId, target.channelIndex);
    RuleEngine._assertNoSelfSource(sourceInfos, targetInfo);

    const targetRule = {
      deviceId: targetInfo.deviceId,
      channelIndex: targetInfo.channelIndex,
      deviceLabel: targetInfo.deviceLabel,
      channelLabel: targetInfo.channelLabel,
      controlType: targetInfo.controlType,
    };

    if (targetInfo.controlType === "RGB_DIM") {
      targetRule.onDimLevel = RuleEngine._clampDimLevel(onDimLevel, 1.0);
      targetRule.onColor = RuleEngine._validateColor(onColor, "WHITE");
      // Optionaler Signaleffekt (Blinken/Blitzen/Wallend) beim Ausloesen -
      // "" heisst "dauerhaft an", wie bisher ueber setSimpleRGBColorDimLevel.
      targetRule.onBehaviour = RuleEngine._validateBehaviour(onBehaviour);
    }

    const rule = {
      id: uuidv4(),
      enabled: true,
      invert: !!invert,
      sourceLogic: RuleEngine._validateSourceLogic(sourceLogic),
      sources: sourceInfos,
      target: targetRule,
      createdAt: Date.now(),
    };

    // Neue Regeln landen bewusst am ENDE der Liste = niedrigste Prioritaet
    // (siehe moveRule/PRIORITAET-Kommentar bei _evaluateGroup) - falls sie
    // eine bestehende Regel fuer dasselbe Ziel uebersteuern soll, muss sie
    // in der Oberflaeche explizit nach oben verschoben werden.
    this.rules.push(rule);
    this._save();
    return rule;
  }

  /**
   * Prueft eine Quelle gegen den Systemzustand und liefert die gespeicherte
   * Form: {deviceId, channelIndex, deviceLabel, channelLabel, condition,
   * op?, threshold?} - siehe conditions.js. Ohne Angabe von condition wird
   * wie vor v0.21.0 automatisch an/aus bzw. Fensterzustand gewaehlt.
   */
  static _buildSource(systemState, s) {
    const device = systemState && systemState.devices && systemState.devices[s.deviceId];
    const channel = device && device.functionalChannels && device.functionalChannels[String(s.channelIndex)];
    if (!channel || (!s.condition && !legacyCondition(channel))) {
      throw new Error("Ein gewählter Auslöser wurde nicht gefunden oder meldet keinen auswertbaren Zustand.");
    }
    return {
      deviceId: s.deviceId,
      channelIndex: Number(s.channelIndex),
      deviceLabel: device.label || device.modelType || s.deviceId,
      channelLabel: channel.label || "",
      ...normalizeSourceCondition(s, channel, device),
    };
  }

  _clearNumericLatch(ruleId) {
    for (const key of [...this.numericLatch.keys()]) {
      if (key.startsWith(ruleId + "|")) this.numericLatch.delete(key);
    }
  }

  /**
   * Wertet EINE Quelle einer Regel aus: true/false, oder null wenn nicht
   * auswertbar. Schwellwert-Bedingungen nutzen eine Hysterese (siehe
   * conditions.js), damit z.B. eine um 5 W schwankende Leistung die LED
   * nicht dauernd an/aus schaltet (Duty Cycle): einmal "erfuellt", bleibt
   * die Bedingung erfuellt, bis der Wert um die Hysterese zurueckgeht.
   */
  _evaluateSource(rule, index, systemState, updateCache) {
    const s = rule.sources[index];
    const device = systemState && systemState.devices && systemState.devices[s.deviceId];
    const channel = device && device.functionalChannels && device.functionalChannels[String(s.channelIndex)];
    if (!channel) return null;
    const def = CONDITIONS[s.condition || legacyCondition(channel)];
    if (!def) return null;
    if (!def.numeric) return def.evaluate(channel);
    const value = def.numeric.read(channel);
    const t = Number(s.threshold);
    if (value === null || !Number.isFinite(t)) return null;
    const latchKey = `${rule.id}|${index}`;
    const prev = this.numericLatch.get(latchKey) === true;
    const h = def.numeric.hysteresis(t);
    const result = (s.op || ">") === "<" ? (prev ? value < t + h : value < t) : prev ? value > t - h : value > t;
    if (updateCache) this.numericLatch.set(latchKey, result);
    return result;
  }

  /**
   * Alle waehlbaren Quellen (Kanal + Bedingung) fuer die Oberflaeche,
   * inkl. Kategorie, Raum und aktuellem Zustand.
   */
  static listSourceOptions(systemState) {
    const out = [];
    const devices = (systemState && systemState.devices) || {};
    for (const [deviceId, device] of Object.entries(devices)) {
      for (const [idx, channel] of Object.entries(device.functionalChannels || {})) {
        for (const condition of conditionsForChannel(channel, device)) {
          const def = CONDITIONS[condition];
          out.push({
            key: `${deviceId}::${idx}::${condition}`,
            deviceId,
            channelIndex: Number(idx),
            condition,
            conditionLabel: def.label,
            category: def.category,
            numeric: !!def.numeric,
            unit: def.numeric ? def.numeric.unit : null,
            currentValue: def.numeric ? def.numeric.read(channel) : def.evaluate(channel),
            stateLabel: def.stateLabel(channel),
            deviceLabel: device.label || device.modelType || deviceId,
            modelType: device.modelType || "",
            channelLabel: channel.label || "",
            channelType: channel.functionalChannelType || "",
            roomLabel: RuleEngine.resolveRoomLabel(systemState, channel, device),
          });
        }
      }
    }
    out.sort((a, b) => a.deviceLabel.localeCompare(b.deviceLabel) || a.channelIndex - b.channelIndex || a.conditionLabel.localeCompare(b.conditionLabel));
    return out;
  }

  /** Die Ziel-LED darf nicht zugleich Quelle derselben Regel sein - sonst
   * wuerde die Regel sich selbst an-/ausschalten (Rueckkopplung). */
  static _assertNoSelfSource(sourceInfos, target) {
    const hit = sourceInfos.some((s) => s.deviceId === target.deviceId && Number(s.channelIndex) === Number(target.channelIndex));
    if (hit) throw new Error("Die LED kann nicht gleichzeitig Auslöser ihrer eigenen Regel sein.");
  }

  static _clampDimLevel(value, fallback) {
    const n = typeof value === "number" ? value : fallback;
    if (Number.isNaN(n)) return fallback;
    return Math.min(1, Math.max(0, n));
  }

  static _validateColor(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (!SIMPLE_RGB_COLORS.includes(value)) {
      throw new Error(`Ungültige Farbe "${value}". Erlaubt: ${SIMPLE_RGB_COLORS.join(", ")}.`);
    }
    return value;
  }

  /** "" (kein Signaleffekt, Standard) oder einer von OPTICAL_SIGNAL_BEHAVIOURS. */
  static _validateBehaviour(value) {
    if (value === undefined || value === null || value === "") return "";
    if (!OPTICAL_SIGNAL_BEHAVIOURS.includes(value)) {
      throw new Error(`Ungültige Leuchtart "${value}". Erlaubt: ${OPTICAL_SIGNAL_BEHAVIOURS.join(", ")}.`);
    }
    return value;
  }

  /** "OR" (Standard) oder "AND", siehe SOURCE_LOGIC_VALUES weiter oben. */
  static _validateSourceLogic(value) {
    if (value === undefined || value === null || value === "") return "OR";
    if (!SOURCE_LOGIC_VALUES.includes(value)) {
      throw new Error(`Ungültige Verknüpfung "${value}". Erlaubt: ${SOURCE_LOGIC_VALUES.join(", ")}.`);
    }
    return value;
  }

  /**
   * systemState ist optional, wird aber gebraucht, wenn patch.sources
   * gesetzt ist (zur Validierung der neuen Quellenliste).
   */
  updateRule(id, patch, systemState) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error("Regel nicht gefunden.");
    if (typeof patch.enabled === "boolean") rule.enabled = patch.enabled;
    if (typeof patch.invert === "boolean") rule.invert = patch.invert;
    if (patch.sourceLogic !== undefined) rule.sourceLogic = RuleEngine._validateSourceLogic(patch.sourceLogic);
    if (Array.isArray(patch.sources)) {
      if (patch.sources.length === 0) throw new Error("Bitte mindestens einen Auslöser auswählen.");
      if (!systemState) throw new Error("Keine Verbindung zur HCU – die Auslöser können gerade nicht geprüft werden.");
      const sourceInfos = patch.sources.map((s) => RuleEngine._buildSource(systemState, s));
      RuleEngine._assertNoSelfSource(sourceInfos, rule.target);
      rule.sources = sourceInfos;
      this.lastSourceState.delete(rule.id);
      this._clearNumericLatch(rule.id);
    }
    if (rule.target.controlType === "RGB_DIM") {
      if (patch.onDimLevel !== undefined) rule.target.onDimLevel = RuleEngine._clampDimLevel(patch.onDimLevel, rule.target.onDimLevel);
      if (patch.onColor !== undefined) rule.target.onColor = RuleEngine._validateColor(patch.onColor, rule.target.onColor);
      if (patch.onBehaviour !== undefined) rule.target.onBehaviour = RuleEngine._validateBehaviour(patch.onBehaviour);
    }
    this._save();
    return rule;
  }

  /**
   * Regeln sichern: gespeicherte Regeln in einem eigenen, versionierten
   * Format (fuer Datei-Download, siehe GET /api/rules/export).
   */
  exportRules() {
    return { format: "wrc6-led-rules", formatVersion: 1, exportedAt: new Date().toISOString(), rules: this.rules };
  }

  /**
   * Regeln laden: nimmt das Export-Format ODER ein einfaches Regel-Array
   * (z. B. die Antwort von GET /api/rules aelterer Versionen). Jede Regel
   * wird wie beim Anlegen geprueft (Ausloeser vorhanden, LED gueltig) und
   * HINTEN angehaengt. Regeln, die sich im aktuellen System nicht
   * aufloesen lassen (z. B. Geraet nicht vorhanden), werden mit Grund
   * uebersprungen. Liefert { imported, skipped: [{ index, reason }] }.
   */
  importRules(data, systemState) {
    const list = Array.isArray(data) ? data : data && Array.isArray(data.rules) ? data.rules : null;
    if (!list) throw new Error("Die Datei enthält keine Regeln (erwartet: Sicherung aus „Regeln sichern“).");
    const result = { imported: 0, skipped: [] };
    list.forEach((r, index) => {
      try {
        if (!r || typeof r !== "object" || !r.target) throw new Error("Eintrag ist keine Regel.");
        const sources = (Array.isArray(r.sources) ? r.sources : r.source ? [r.source] : []).map((s) => ({
          deviceId: s.deviceId,
          channelIndex: s.channelIndex,
          condition: s.condition || undefined,
          op: s.op,
          threshold: s.threshold,
        }));
        const rule = this.addRule(
          {
            sources,
            target: { deviceId: r.target.deviceId, channelIndex: r.target.channelIndex },
            invert: !!r.invert,
            sourceLogic: r.sourceLogic,
            onDimLevel: r.target.onDimLevel,
            onColor: r.target.onColor,
            onBehaviour: r.target.onBehaviour,
          },
          systemState
        );
        if (r.enabled === false) {
          rule.enabled = false;
          this._save();
        }
        result.imported++;
      } catch (err) {
        result.skipped.push({ index: index + 1, reason: err.message });
      }
    });
    return result;
  }

  deleteRule(id) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    this.lastSourceState.delete(id);
    this._clearNumericLatch(id);
    this._save();
    return this.rules.length < before;
  }

  /**
   * PRIORITAET zwischen Regeln: die Position in dieser Liste (this.rules)
   * ist zugleich die Rangfolge - Index 0 (oben in der Oberflaeche) hat die
   * HOECHSTE Prioritaet. Teilen sich mehrere aktivierte Regeln dasselbe
   * Ziel und treffen gleichzeitig zu, gewinnt immer die oberste (siehe
   * _evaluateGroup) - z.B. eine spezifischere UND-Regel ("OG UND UG offen")
   * oberhalb zweier einfacherer ODER-Regeln platzieren, damit sie diese im
   * Konfliktfall uebersteuert.
   *
   * direction: "up" (naeher an Index 0, hoehere Prioritaet) oder "down".
   * Ist die Regel schon am jeweiligen Rand, passiert nichts (kein Fehler).
   */
  moveRule(id, direction) {
    const idx = this.rules.findIndex((r) => r.id === id);
    if (idx === -1) throw new Error("Regel nicht gefunden.");
    const swapWith = direction === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= this.rules.length) return this.rules;
    [this.rules[idx], this.rules[swapWith]] = [this.rules[swapWith], this.rules[idx]];
    this._save();
    return this.rules;
  }

  /**
   * Initialisiert lastSourceState/lastTargetWinner fuer alle Regeln anhand
   * des aktuellen Systemzustands, OHNE dabei einen Steuerbefehl zu senden.
   * Nur fuer Faelle gedacht, in denen der interne Zustand synchronisiert
   * werden soll, ohne das Zielgeraet anzufassen (z.B. in Tests). Fuer den
   * Start des Plugins NICHT verwenden - siehe enforceAllRules.
   */
  initFromSystemState(systemState) {
    const groups = RuleEngine._groupRulesByTarget(this.rules);
    for (const [key, group] of groups) {
      const { winner } = this._evaluateGroup(group, systemState);
      this.lastTargetWinner.set(key, winner ? winner.id : null);
    }
  }

  /**
   * Wertet ALLE aktivierten Regeln anhand des aktuellen Systemzustands aus
   * und sendet je Ziel-Kanal genau EINEN Steuerbefehl - unabhaengig davon,
   * ob sich seit zuletzt etwas geaendert hat. Wird einmalig direkt nach dem
   * ersten getSystemState beim Start des Plugins aufgerufen, damit der
   * tatsaechliche Zustand der Quellen sofort auf das Ziel angewendet wird
   * (Beispiel: ein Fenster ist beim Start des Plugins bereits offen - die
   * LED soll dann sofort angehen, statt erst auf ein zukuenftiges
   * Schliessen+Oeffnen zu warten). Ausgeloest wird also bewusst der
   * AKTUELLE ZUSTAND, nicht nur eine seither beobachtete ZUSTANDSAeNDERUNG.
   *
   * Fuer den laufenden Betrieb (onDevicesChanged) bleibt es bei der
   * Aenderungs-Erkennung: Homematic IP unterliegt als Funktechnik einer
   * Duty-Cycle-Begrenzung (siehe "dutyCycle" im getState-Beispiel der Doku),
   * d.h. unnoetig oft wiederholte Funkbefehle sollten vermieden werden.
   * Bei jedem Geraete-Event pauschal erneut zu senden, auch wenn sich am
   * berechneten Ziel-Zustand nichts geaendert hat, wuerde dem entgegenlaufen.
   */
  enforceAllRules(systemState, sendControl) {
    return this._enqueue(async () => {
      const groups = RuleEngine._groupRulesByTarget(this.rules);
      for (const [key, group] of groups) {
        const { winner } = this._evaluateGroup(group, systemState);
        this.lastTargetWinner.set(key, winner ? winner.id : null);
        await this._sendTarget(key, group[0].target, winner, systemState, sendControl);
      }
    });
  }

  /**
   * Haengt fn an die interne Warteschlange an (strikt nacheinander, ein
   * Fehler in einem Schritt blockiert die folgenden nicht). Liefert ein
   * Promise mit dem Ergebnis von fn.
   */
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * Gruppiert alle Regeln nach Ziel-Kanal ("deviceId::channelIndex"). Die
   * Reihenfolge innerhalb jeder Gruppe entspricht der Reihenfolge in
   * this.rules, also der PRIORITAET (siehe moveRule) - Regeln werden hier
   * bewusst der Reihe nach eingefuegt (kein sort()), damit das erhalten
   * bleibt.
   */
  static _groupRulesByTarget(rules) {
    const groups = new Map();
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const key = `${rule.target.deviceId}::${rule.target.channelIndex}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rule);
    }
    return groups;
  }

  /**
   * Ermittelt den kombinierten Zustand aller Quellen EINER Regel -
   * ODER-verknuepft (Standard) oder UND-verknuepft (rule.sourceLogic
   * === "AND", siehe SOURCE_LOGIC_VALUES). Liefert null, wenn sich KEINE
   * der Quellen aufloesen laesst (z.B. Geraet entfernt) - in dem Fall bleibt
   * der zuletzt bekannte Wert unveraendert, statt faelschlich auf "aus" zu
   * springen. Bei UND wird eine nicht aufloesbare Quelle sicherheitshalber
   * wie "nicht an" behandelt (die Bedingung kann dann nie "erfuellt" sein) -
   * eine UND-Regel soll nicht faelschlich auslösen, nur weil eine ihrer
   * Quellen gerade nicht ausgelesen werden kann.
   */
  _evaluateRuleSources(rule, systemState, updateCache) {
    const total = rule.sources.length;
    let resolvedCount = 0;
    let onCount = 0;
    for (let i = 0; i < total; i++) {
      const v = this._evaluateSource(rule, i, systemState, updateCache);
      if (v === null) continue;
      resolvedCount++;
      if (v) onCount++;
    }
    if (resolvedCount === 0) return null;
    if (rule.sourceLogic === "AND") {
      return resolvedCount === total && onCount === total;
    }
    return onCount > 0; // OR (Standard)
  }

  /**
   * Wertet eine Gruppe von Regeln aus, die ALLE dasselbe Ziel haben, und
   * ermittelt die "gewinnende" Regel: die erste (=Prioritaets-hoechste,
   * siehe moveRule) Regel in der Gruppe, deren Bedingung gerade erfuellt
   * ist (inkl. invert). Faellt keine Regel auf "erfuellt", ist winner null
   * (Ziel soll aus sein). Damit kann fuer dasselbe Ziel immer nur GENAU EINE
   * Regel gleichzeitig gewinnen, statt dass mehrere gleichzeitig zutreffende
   * Regeln sich in nicht vorhersehbarer Reihenfolge gegenseitig
   * ueberschreiben (das urspruengliche Problem, das zu dieser Aenderung
   * gefuehrt hat).
   *
   * Aktualisiert nebenbei this.lastSourceState je Regel, damit eine
   * spaeter voruebergehend nicht aufloesbare Quelle auf den zuletzt
   * bekannten Wert zurueckfallen kann (siehe _evaluateSources).
   *
   * Liefert zusaetzlich "matches": Map ruleId -> ob die Regel fuer sich
   * genommen gerade erfuellt waere (auch wenn sie nicht gewinnt) - fuer die
   * Live-Statusanzeige in der Oberflaeche (siehe getRulesWithStatus).
   */
  _evaluateGroup(group, systemState, { updateCache = true } = {}) {
    let winner = null;
    const matches = new Map();
    for (const rule of group) {
      const combined = this._evaluateRuleSources(rule, systemState, updateCache);
      if (combined !== null && updateCache) this.lastSourceState.set(rule.id, combined);
      // Ohne aktuell aufloesbare Quelle: letzten bekannten Wert verwenden
      // (oder false, falls noch nie bekannt) statt faelschlich "aus" anzunehmen.
      const effective = combined !== null ? combined : this.lastSourceState.get(rule.id) ?? false;
      const desired = rule.invert ? !effective : effective;
      matches.set(rule.id, desired);
      if (desired && !winner) winner = rule;
    }
    return { winner, matches };
  }

  /**
   * Wird bei jeder Aenderung eines oder mehrerer Geraete aufgerufen.
   * sendControl: (path, body) => Promise  (siehe ConnectApiClient.sendSystemRequest)
   *
   * Wertet nur die Ziel-Gruppen neu aus, die von den geaenderten Geraeten
   * ueberhaupt betroffen sind (mindestens eine Regel-Quelle in der Gruppe
   * gehoert zu einem der geaenderten Geraete) - und sendet je Gruppe nur
   * dann einen Befehl, wenn sich die GEWINNENDE Regel tatsaechlich
   * geaendert hat (Duty-Cycle, siehe enforceAllRules-Kommentar).
   */
  onDevicesChanged(changedDeviceIds, systemState, sendControl) {
    return this._enqueue(async () => {
      const groups = RuleEngine._groupRulesByTarget(this.rules);
      for (const [key, group] of groups) {
        const affected = group.some((rule) => rule.sources.some((s) => changedDeviceIds.includes(s.deviceId)));
        if (!affected) continue;

        const { winner } = this._evaluateGroup(group, systemState);
        const winnerId = winner ? winner.id : null;
        const previousWinnerId = this.lastTargetWinner.has(key) ? this.lastTargetWinner.get(key) : undefined;

        this.log("debug", `Ziel ${key} von Event betroffen`, {
          geaenderteGeraeteIds: changedDeviceIds,
          vorherigerGewinner: previousWinnerId,
          neuerGewinner: winnerId,
          wirdGesendet: previousWinnerId !== winnerId,
        });

        if (previousWinnerId === winnerId) continue; // kein echter Wechsel -> nichts tun

        this.lastTargetWinner.set(key, winnerId);
        await this._sendTarget(key, group[0].target, winner, systemState, sendControl);
      }
    });
  }

  /**
   * Erzwingt eine sofortige Neubewertung + Steuerbefehl fuer GENAU EIN
   * Ziel, unabhaengig vom bisher bekannten lastTargetWinner - fuer
   * Aenderungen aus der Oberflaeche (Regel anlegen/loeschen/umsortieren/
   * de-aktivieren/Quellen aendern). Wurde gerade die letzte Regel fuer das
   * Ziel geloescht, werden die Kanal-Stammdaten direkt aus dem
   * Systemzustand ermittelt, damit die LED trotzdem ausgeschaltet wird.
   */
  syncTarget(deviceId, channelIndex, systemState, sendControl) {
    return this._enqueue(async () => {
      const key = `${deviceId}::${channelIndex}`;
      const group = RuleEngine._groupRulesByTarget(this.rules).get(key) || [];
      const { winner } = this._evaluateGroup(group, systemState);
      this.lastTargetWinner.set(key, winner ? winner.id : null);
      const target = group.length > 0 ? group[0].target : RuleEngine.describeChannel(systemState, deviceId, channelIndex);
      if (!target || !target.controlType) return; // Ziel nicht (mehr) vorhanden/steuerbar
      await this._sendTarget(key, target, winner, systemState, sendControl);
    });
  }

  /**
   * Sendet den Befehl fuer ein Ziel und plant danach die Pruefung des von
   * der HCU zurueckgemeldeten Zustands (siehe _scheduleVerify). Schlaegt
   * das Senden fehl (Fehlercode/Zeitueberschreitung), wird der
   * Duty-Cycle-Cache fuer dieses Ziel verworfen, damit das naechste Event
   * garantiert erneut sendet (bis v0.18.5 blieb die LED dann falsch, bis
   * sich der Gewinner zufaellig wieder aenderte).
   */
  async _sendTarget(key, target, winner, systemState, sendControl) {
    const seq = (this.sendSeq.get(key) || 0) + 1;
    this.sendSeq.set(key, seq);
    const command = RuleEngine.buildTargetCommand(target, winner);
    const ok = await RuleEngine._dispatchTarget(this, target, winner, command, sendControl);
    if (!ok) this.lastTargetWinner.delete(key);
    this._scheduleVerify({ key, seq, target, winner, command, systemState, sendControl, attempt: 0 });
  }

  /**
   * Nach verifyDelayMs: stimmt der von der HCU gemeldete Kanalzustand mit
   * dem gesendeten Befehl ueberein? Wenn nicht (und seither kein neuerer
   * Befehl fuer dieses Ziel kam), wird derselbe Befehl erneut gesendet -
   * hoechstens maxRetries mal. Kann der Zustand nicht beurteilt werden
   * (Feld fehlt), passiert nichts.
   */
  _scheduleVerify(ctx) {
    if (!this.verifyDelayMs || !ctx.systemState) return;
    const timer = setTimeout(() => {
      this._enqueue(async () => {
        if (this.sendSeq.get(ctx.key) !== ctx.seq) return; // inzwischen neuerer Befehl / manuelle Steuerung
        const check = RuleEngine._checkReportedState(ctx.systemState, ctx.target, ctx.command);
        if (check !== false) {
          if (check === true) this.log("debug", `Zustand von ${ctx.key} von der HCU bestaetigt`);
          return;
        }
        const label = `${ctx.target.deviceLabel} – ${ctx.target.channelLabel || "LED " + ctx.target.channelIndex}`;
        if (ctx.attempt >= this.maxRetries) {
          this.log("warn", `LED ${label} meldet nach ${ctx.attempt} Wiederholung(en) weiterhin einen abweichenden Zustand - gebe auf`, {
            gesendet: ctx.command.body,
            gemeldet: RuleEngine._reportedChannel(ctx.systemState, ctx.target),
          });
          this._pushLogEntry({ rule: label, sourceOn: !!ctx.winner, action: ctx.winner ? "AN" : "AUS", result: "FEHLER: LED hat den Befehl nicht übernommen" });
          return;
        }
        this.log("warn", `LED ${label} meldet abweichenden Zustand - sende erneut (Wiederholung ${ctx.attempt + 1}/${this.maxRetries})`, {
          gesendet: ctx.command.body,
          gemeldet: RuleEngine._reportedChannel(ctx.systemState, ctx.target),
        });
        const ok = await RuleEngine._dispatchTarget(this, ctx.target, ctx.winner, ctx.command, ctx.sendControl, `Wiederholung ${ctx.attempt + 1}`);
        if (ok) this.lastTargetWinner.set(ctx.key, ctx.winner ? ctx.winner.id : null);
        else this.lastTargetWinner.delete(ctx.key);
        this._scheduleVerify({ ...ctx, attempt: ctx.attempt + 1 });
      }).catch((err) => this.log("error", "Fehler bei der Zustandspruefung", { error: err.message }));
    }, this.verifyDelayMs);
    if (timer.unref) timer.unref();
  }

  static _reportedChannel(systemState, target) {
    const device = systemState && systemState.devices && systemState.devices[target.deviceId];
    return (device && device.functionalChannels && device.functionalChannels[String(target.channelIndex)]) || null;
  }

  /**
   * true = gemeldeter Zustand passt zum gesendeten Befehl, false = passt
   * nicht, null = nicht beurteilbar (Kanal/Feld fehlt).
   * Beim Einschalten zaehlt zusaetzlich opticalSignalBehaviour, sofern die
   * HCU das Feld meldet: genau dieses Feld stand in Logs eines echten Geraets
   * bei den dunkel gebliebenen Einschaltvorgaengen auf "OFF".
   */
  static _checkReportedState(systemState, target, command) {
    const ch = RuleEngine._reportedChannel(systemState, target);
    if (!ch) return null;
    const b = command.body;
    if (typeof b.dimLevel === "number") {
      if (typeof ch.dimLevel !== "number") return null;
      if (b.dimLevel === 0) return ch.dimLevel === 0;
      if (ch.dimLevel <= 0) return false;
      if (typeof ch.opticalSignalBehaviour === "string") {
        if (b.opticalSignalBehaviour) return ch.opticalSignalBehaviour === b.opticalSignalBehaviour;
        return ch.opticalSignalBehaviour !== "OFF";
      }
      return true;
    }
    if (typeof b.on === "boolean") {
      if (typeof ch.on !== "boolean") return null;
      return ch.on === b.on;
    }
    return null;
  }

  /**
   * Baut den lesbaren "Quelle(n) -> Ziel"-Text fuer Log/Verlauf, inkl. der
   * tatsaechlich verwendeten Verknuepfung (UND/ODER).
   */
  static _describeSources(rule) {
    const joiner = rule.sourceLogic === "AND" ? " UND " : " ODER ";
    // Bei vielen Auslösern (z. B. 21 Fensterkontakte) wird der Verlaufstext
    // sonst unlesbar lang: die ersten zwei nennen, Rest zusammenfassen.
    const texts = rule.sources.map(
      (s) => `${s.deviceLabel}${s.channelLabel ? " – " + s.channelLabel : ""}${s.condition ? ": " + describeCondition(s) : ""}`
    );
    if (texts.length > 3) return `${texts.slice(0, 2).join(joiner)}${joiner}${texts.length - 2} weitere`;
    return texts.join(joiner);
  }

  /**
   * Baut Pfad + Body des Steuerbefehls fuer ein Ziel. "winner" ist die
   * gewinnende Regel (deren Farbe/Helligkeit/Effekt gilt) oder null (aus).
   *
   * RGB_DIM (WRC6-230-LED) nutzt bewusst EXAKT dieselben Befehle wie die
   * manuelle Steuerung in der Oberflaeche, die nachweislich zuverlaessig
   * funktioniert (am echten Geraet getestet):
   *   - an, "Dauerhaft an": setSimpleRGBColorDimLevel(Farbe, Helligkeit)
   *   - an, mit Effekt:     setOpticalSignal(Effekt, Farbe, Helligkeit)
   *   - aus:                setSimpleRGBColorDimLevel(Farbe, 0.0)
   * Bis v0.18.5 schaltete die Automatik per setDimLevel(0.0) aus - danach
   * meldete die HCU bei jedem zweiten Einschalten opticalSignalBehaviour
   * "OFF" und die LED blieb dunkel. Der "Fix" aus v0.18.3 griff bei
   * "Dauerhaft an"-Regeln nie, weil "Dauerhaft an" intern onBehaviour ""
   * ist.
   */
  static buildTargetCommand(target, winner) {
    const base = { deviceId: target.deviceId, channelIndex: target.channelIndex };
    if (target.controlType === "RGB_DIM") {
      if (winner) {
        const t = winner.target;
        const color = t.onColor || "WHITE";
        const level = typeof t.onDimLevel === "number" ? t.onDimLevel : 1.0;
        if (t.onBehaviour) {
          return {
            path: PATH_SET_OPTICAL_SIGNAL,
            body: { ...base, opticalSignalBehaviour: t.onBehaviour, simpleRGBColorState: color, dimLevel: level },
          };
        }
        return { path: PATH_SET_SIMPLE_RGB, body: { ...base, simpleRGBColorState: color, dimLevel: level } };
      }
      const offColor = target.onColor || target.currentColor || "WHITE";
      return { path: PATH_SET_SIMPLE_RGB, body: { ...base, simpleRGBColorState: offColor, dimLevel: 0.0 } };
    }
    if (target.controlType === "DIM") {
      return { path: PATH_SET_DIM_LEVEL, body: { ...base, dimLevel: winner ? 1.0 : 0.0 } };
    }
    return { path: PATH_SET_SWITCH_STATE, body: { ...base, on: !!winner } };
  }

  /**
   * Sendet einen fertig gebauten Befehl und protokolliert das Ergebnis.
   * Liefert true bei Erfolg, false bei Fehler/Zeitueberschreitung.
   */
  static async _dispatchTarget(engine, target, winner, command, sendControl, note) {
    const desired = !!winner;
    const label = `${target.deviceLabel} – ${target.channelLabel || "LED " + target.channelIndex}`;
    const ruleName = (winner ? `${RuleEngine._describeSources(winner)} → ${label}` : `Kein Auslöser aktiv → ${label}`) + (note ? ` [${note}]` : "");

    engine.log("debug", "Sende Steuerbefehl", { pfad: command.path, body: command.body });

    try {
      await sendControl(command.path, command.body);
      engine._pushLogEntry({ rule: ruleName, sourceOn: desired, action: desired ? "AN" : "AUS", result: "OK" });
      engine.log("info", `Regel ausgeloest: ${ruleName} -> ${desired ? "AN" : "AUS"}`);
      return true;
    } catch (err) {
      engine._pushLogEntry({ rule: ruleName, sourceOn: desired, action: desired ? "AN" : "AUS", result: "FEHLER: " + err.message });
      engine.log("error", `Regel fehlgeschlagen: ${ruleName}`, { error: err.message });
      return false;
    }
  }

  /**
   * Wie getRules(), aber jede Regel wird zusaetzlich um zwei Live-Felder
   * ergaenzt, ausgewertet anhand des uebergebenen Systemzustands - fuer die
   * Statusanzeige in der Oberflaeche (siehe PRIORITAET/_evaluateGroup):
   *   - matches: erfuellt die Regel FUER SICH GENOMMEN gerade ihre
   *     Bedingung (ODER/UND, invertiert beruecksichtigt)? Auch true, wenn
   *     eine andere, hoeher priorisierte Regel gerade tatsaechlich das Ziel
   *     steuert.
   *   - active: steuert GENAU DIESE Regel gerade tatsaechlich das Ziel
   *     (matches===true UND keine hoeher priorisierte Regel der Gruppe
   *     trifft ebenfalls zu)?
   * Ohne systemState (Verbindung zur HCU noch nicht bereit) liefert beides
   * false/null, statt zu raten.
   */
  getRulesWithStatus(systemState) {
    if (!systemState) {
      return this.rules.map((r) => ({ ...r, matches: null, active: false }));
    }
    const groups = RuleEngine._groupRulesByTarget(this.rules);
    const winnerByTarget = new Map();
    const matchesById = new Map();
    for (const [key, group] of groups) {
      // updateCache:false - die Statusabfrage der Oberflaeche (alle 3 s)
      // darf den Zustand der Regel-Engine nicht nebenbei veraendern.
      const { winner, matches } = this._evaluateGroup(group, systemState, { updateCache: false });
      winnerByTarget.set(key, winner ? winner.id : null);
      for (const [ruleId, m] of matches) matchesById.set(ruleId, m);
    }
    // Quellen fuer die Anzeige anreichern (ohne die gespeicherte Regel zu
    // veraendern): effectiveCondition = gespeicherte oder (bei Regeln vor
    // v0.21.0) automatisch abgeleitete Bedingung, conditionText = Kurztext.
    const decorate = (r) => ({
      ...r,
      sources: r.sources.map((s) => {
        const device = systemState.devices && systemState.devices[s.deviceId];
        const channel = device && device.functionalChannels && device.functionalChannels[String(s.channelIndex)];
        const effectiveCondition = s.condition || legacyCondition(channel);
        return { ...s, effectiveCondition, conditionText: describeCondition({ ...s, condition: effectiveCondition }) };
      }),
    });
    return this.rules.map((r0) => {
      const r = decorate(r0);
      if (!r.enabled) return { ...r, matches: false, active: false };
      const key = `${r.target.deviceId}::${r.target.channelIndex}`;
      const matches = matchesById.get(r.id) ?? false;
      return { ...r, matches, active: matches && winnerByTarget.get(key) === r.id };
    });
  }

  /**
   * Baut aus einer gewuenschten manuellen Einstellung (Helligkeit 0.0-1.0,
   * optional Farbe, optional reines an/aus) den passenden Connect-API-Pfad
   * + Body fuer die Direktsteuerung eines WRC6-230-Kanals. Wirft einen
   * Fehler, wenn Ziel kein WRC6-230 ist oder die Werte ungueltig sind.
   * Fuehrt den Request NICHT selbst aus (das macht der Aufrufer mit
   * api.sendSystemRequest), damit rules.js keine Abhaengigkeit zum
   * WebSocket-Client braucht.
   */
  /**
   * Prueft/normalisiert eine optionale Einblendzeit (rampTime, Sekunden).
   * Laut Doku (Kapitel 6.8.1.11/6.8.1.27/6.8.1.22) gibt es rampTime NUR bei
   * den "...WithTime"-Endpunkten, und dort immer zusammen mit einem
   * PFLICHT-Feld "onTime" (Sekunden, nach denen der Kanal automatisch
   * AUSGESCHALTET wird - Grenze laut Doku: 0.1 bis 16383, ca. 4,5 Stunden).
   * Es gibt keinen dokumentierten Weg, nur die Einblendzeit ohne einen
   * solchen Auto-Aus-Timer zu setzen. Damit "Einblendzeit" nicht ungefragt
   * zu einem spaeteren automatischen Ausschalten fuehrt, wird onTime auf
   * das dokumentierte Maximum gesetzt - das Licht bleibt dann so lange wie
   * die API es ueberhaupt erlaubt an, schaltet danach aber automatisch aus.
   */
  static _validateRampTime(value) {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (Number.isNaN(n) || n < 0.1 || n > MAX_ON_TIME_SECONDS) {
      throw new Error(`Ungültige Einblendzeit "${value}". Erlaubt: 0,1 bis ${MAX_ON_TIME_SECONDS} Sekunden.`);
    }
    return n;
  }

  static buildManualControlRequest(systemState, deviceId, channelIndex, { dimLevel, color, on, behaviour, rampTime } = {}) {
    const info = RuleEngine.assertWrc6Target(systemState, deviceId, channelIndex);
    const ramp = RuleEngine._validateRampTime(rampTime);

    if (info.controlType === "RGB_DIM") {
      const level = RuleEngine._clampDimLevel(dimLevel, info.currentDimLevel ?? 1.0);
      const validColor = RuleEngine._validateColor(color, info.currentColor || "WHITE");
      // behaviour ist optional (Signaleffekt wie Blinken/Blitzen/Wallend,
      // siehe OPTICAL_SIGNAL_BEHAVIOURS). Ohne Angabe bleibt es beim bereits
      // getesteten setSimpleRGBColorDimLevel-Pfad fuer dauerhaftes Leuchten.
      if (behaviour) {
        if (!OPTICAL_SIGNAL_BEHAVIOURS.includes(behaviour)) {
          throw new Error(`Ungültige Leuchtart "${behaviour}". Erlaubt: ${OPTICAL_SIGNAL_BEHAVIOURS.join(", ")}.`);
        }
        if (ramp !== null) {
          return {
            path: "/hmip/device/control/setOpticalSignalWithTime",
            body: {
              deviceId: info.deviceId,
              channelIndex: info.channelIndex,
              opticalSignalBehaviour: behaviour,
              simpleRGBColorState: validColor,
              dimLevel: level,
              rampTime: ramp,
              onTime: MAX_ON_TIME_SECONDS,
            },
          };
        }
        return {
          path: "/hmip/device/control/setOpticalSignal",
          body: {
            deviceId: info.deviceId,
            channelIndex: info.channelIndex,
            opticalSignalBehaviour: behaviour,
            simpleRGBColorState: validColor,
            dimLevel: level,
          },
        };
      }
      if (ramp !== null) {
        return {
          path: "/hmip/device/control/setSimpleRGBColorDimLevelWithTime",
          body: {
            deviceId: info.deviceId,
            channelIndex: info.channelIndex,
            simpleRGBColorState: validColor,
            dimLevel: level,
            rampTime: ramp,
            onTime: MAX_ON_TIME_SECONDS,
          },
        };
      }
      return {
        path: "/hmip/device/control/setSimpleRGBColorDimLevel",
        body: { deviceId: info.deviceId, channelIndex: info.channelIndex, simpleRGBColorState: validColor, dimLevel: level },
      };
    }
    if (info.controlType === "DIM") {
      const level = RuleEngine._clampDimLevel(dimLevel, info.currentDimLevel ?? 1.0);
      if (ramp !== null) {
        return {
          path: "/hmip/device/control/setDimLevelWithTime",
          body: { deviceId: info.deviceId, channelIndex: info.channelIndex, dimLevel: level, rampTime: ramp, onTime: MAX_ON_TIME_SECONDS },
        };
      }
      return {
        path: "/hmip/device/control/setDimLevel",
        body: { deviceId: info.deviceId, channelIndex: info.channelIndex, dimLevel: level },
      };
    }
    // SWITCH
    return {
      path: "/hmip/device/control/setSwitchState",
      body: { deviceId: info.deviceId, channelIndex: info.channelIndex, on: typeof on === "boolean" ? on : !info.isOn },
    };
  }
}

/**
 * Uebersicht ALLER Kanal-Typen im Systemzustand mit ihren Feldnamen,
 * Wert-Typen und bis zu 4 Beispielwerten - Grundlage, um weitere
 * Sensortypen (Bewegung, Wasser, Rauch, ...) anhand ECHTER Daten zu
 * unterstuetzen statt Feldnamen zu raten. Bewusst ohne Namen/Labels,
 * Gruppen und Geraete-IDs.
 */
RuleEngine.summarizeChannelFields = function summarizeChannelFields(systemState) {
  const SKIP = new Set(["groups", "label", "deviceId", "index", "functionalChannelType"]);
  const out = {};
  const devices = (systemState && systemState.devices) || {};
  for (const device of Object.values(devices)) {
    for (const ch of Object.values(device.functionalChannels || {})) {
      const type = ch.functionalChannelType || "(ohne Typ)";
      const entry = out[type] || (out[type] = { anzahlKanaele: 0, geraeteModelle: [], erkanntAlsQuelle: false, felder: {} });
      entry.anzahlKanaele++;
      if (device.modelType && !entry.geraeteModelle.includes(device.modelType)) entry.geraeteModelle.push(device.modelType);
      if (RuleEngine.readBooleanState(ch) !== null) entry.erkanntAlsQuelle = true;
      for (const [k, v] of Object.entries(ch)) {
        if (SKIP.has(k)) continue;
        const f = entry.felder[k] || (entry.felder[k] = { typen: [], beispiele: [] });
        const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        if (!f.typen.includes(t)) f.typen.push(t);
        if (t !== "object" && t !== "array" && f.beispiele.length < 4 && !f.beispiele.includes(v)) f.beispiele.push(v);
      }
    }
  }
  return out;
};

/** Fuer die Web-Oberflaeche/API auch als statisches Feld verfuegbar. */
RuleEngine.TARGET_MODEL_TYPE = TARGET_MODEL_TYPE;
RuleEngine.OPTICAL_SIGNAL_BEHAVIOURS = OPTICAL_SIGNAL_BEHAVIOURS;
RuleEngine.MAX_ON_TIME_SECONDS = MAX_ON_TIME_SECONDS;
RuleEngine.SIMPLE_RGB_COLORS = SIMPLE_RGB_COLORS;
RuleEngine.SOURCE_LOGIC_VALUES = SOURCE_LOGIC_VALUES;
RuleEngine.DATA_DIR = DATA_DIR;
RuleEngine.OPERATORS = OPERATORS;

module.exports = { RuleEngine };
