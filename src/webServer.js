"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { RuleEngine } = require("./rules");
const { version: PLUGIN_VERSION } = require("../package.json");

/**
 * Baut die kleine REST-API + statische Web-Oberflaeche fuer das Plugin auf.
 *
 * @param {object} deps
 * @param {import('./connectApi').ConnectApiClient} deps.api
 * @param {RuleEngine} deps.ruleEngine
 */
function createWebServer({ api, ruleEngine }) {
  const app = express();

  // Optionaler Passwortschutz (HTTP Basic Auth, Benutzername beliebig).
  // Aktiv, sobald ein Passwort hinterlegt ist: Umgebungsvariable
  // WEB_PASSWORD oder Datei web-password.txt im Datenverzeichnis (auf der
  // HCU: /data/web-password.txt). Ohne Passwort bleibt die Oberflaeche wie
  // bisher fuer jeden im Netz offen - beim Start wird dann gewarnt.
  const password = readWebPassword();
  if (password) {
    app.use(basicAuth(password));
    ruleEngine.log("info", "Weboberflaeche ist passwortgeschuetzt.");
  } else {
    ruleEngine.log("warn", "Weboberflaeche OHNE Passwort - jeder im Netz kann LEDs schalten und Regeln aendern (siehe README: web-password.txt).");
  }

  app.use(express.json({ limit: "2mb" }));
  // Cache-Control "no-cache": der Browser muss bei jedem Laden kurz
  // nachfragen, ob sich app.js/index.html/style.css geaendert haben. Ohne
  // das hat der Browser nach einem Plugin-Update teils noch die alte
  // Oberflaeche aus dem Cache angezeigt (z. B. war "Quellen bearbeiten" nicht
  // zu finden, v0.21.0).
  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      setHeaders: (res) => res.set("Cache-Control", "no-cache"),
    })
  );

  /** Fuer RuleEngine.enforceAllRules/onDevicesChanged/syncTarget - siehe rules.js. */
  const sendControl = (reqPath, body) => api.sendSystemRequest(reqPath, body);

  /**
   * Nach jeder Aenderung an der Regelliste, die den Gewinner eines Ziels
   * beeinflussen kann (Regel anlegen/loeschen/umsortieren/de-aktivieren/
   * Quellen aendern), das betroffene Ziel SOFORT neu abgleichen - sonst
   * wuerde z.B. eine per Pfeil nach oben verschobene Regel erst beim
   * naechsten echten Fenster-/Schalter-Ereignis die LED tatsaechlich
   * uebernehmen (siehe RuleEngine.syncTarget). Fehler hier werden nur
   * geloggt, nicht an die eigentliche Antwort durchgereicht - die Regel-
   * Aenderung selbst ist bereits erfolgreich gespeichert.
   */
  async function syncTargetSafely(deviceId, channelIndex) {
    try {
      await ruleEngine.syncTarget(deviceId, channelIndex, api.systemState, sendControl);
    } catch (err) {
      ruleEngine.log("error", "Fehler beim Abgleich nach Regel-Aenderung", { error: err.message });
    }
  }

  // Status der Verbindung/des Systemzustands
  app.get("/api/status", (req, res) => {
    res.json({
      version: PLUGIN_VERSION,
      connected: api.connected,
      systemStateReady: api.systemStateReady,
      deviceCount: Object.keys(api.systemState.devices).length,
      targetModelType: RuleEngine.TARGET_MODEL_TYPE,
      simpleRgbColors: RuleEngine.SIMPLE_RGB_COLORS,
      opticalSignalBehaviours: RuleEngine.OPTICAL_SIGNAL_BEHAVIOURS,
      maxOnTimeSeconds: RuleEngine.MAX_ON_TIME_SECONDS,
      sourceLogicValues: RuleEngine.SOURCE_LOGIC_VALUES,
      operators: RuleEngine.OPERATORS,
    });
  });

  // Alle Geraete/Kanaele flach aufgelistet, fuer die Auswahl-Dropdowns
  app.get("/api/devices", (req, res) => {
    const result = [];
    const devices = api.systemState.devices || {};
    for (const deviceId of Object.keys(devices)) {
      const device = devices[deviceId];
      const channels = device.functionalChannels || {};
      for (const channelIndex of Object.keys(channels)) {
        const channel = channels[channelIndex];
        const controlType = RuleEngine.resolveControlType(channel);
        const isOn = RuleEngine.readBooleanState(channel);
        // Nur Kanaele anzeigen, die ueberhaupt einen An/Aus-Zustand haben -
        // reine Basiskanaele (DEVICE_BASE) o.ae. sind fuer Regeln irrelevant.
        if (isOn === null) continue;
        result.push({
          deviceId,
          deviceLabel: device.label || device.modelType || deviceId,
          modelType: device.modelType || "",
          channelIndex: Number(channelIndex),
          channelLabel: channel.label || "",
          channelType: channel.functionalChannelType || "",
          // Raum, aus der META-Gruppe des Kanals ermittelt (siehe
          // RuleEngine.resolveRoomLabel) - fuer die Raum-Filterung in der
          // Oberflaeche.
          roomLabel: RuleEngine.resolveRoomLabel(api.systemState, channel, device),
          controlType,
          isOn,
          stateLabel: RuleEngine.describeState(channel),
          supportsColor: controlType === "RGB_DIM",
          currentDimLevel: typeof channel.dimLevel === "number" ? channel.dimLevel : null,
          currentColor: typeof channel.simpleRGBColorState === "string" ? channel.simpleRGBColorState : null,
          // Nur durchgereicht, falls das echte Geraet dieses Feld tatsaechlich
          // liefert - ob ein WRC6-230-Kanal seinen aktuellen Signaleffekt
          // (Blinken/Blitzen/Wallend) im getSystemState ueberhaupt meldet,
          // ist nicht dokumentiert bestaetigt. Ohne das Feld bleibt es null,
          // die Oberflaeche zeigt dann einfach keinen Effekt-Hinweis an.
          currentOpticalSignalBehaviour: typeof channel.opticalSignalBehaviour === "string" ? channel.opticalSignalBehaviour : null,
          // Nur WRC6-230-Kanaele duerfen als Ziel gewaehlt werden - siehe
          // TARGET_MODEL_TYPE in rules.js. Wird von der Oberflaeche genutzt,
          // um die Ziel-Auswahl entsprechend einzuschraenken.
          isTargetCandidate: RuleEngine.isTargetChannel(device, channel),
        });
      }
    }
    // Erst nach Geraete-Label, dann NUMERISCH nach Kanal-Index sortieren
    // (ein reiner String-Vergleich wuerde Kanal 10 vor Kanal 9 einsortieren).
    result.sort((a, b) => a.deviceLabel.localeCompare(b.deviceLabel) || a.channelIndex - b.channelIndex);
    res.json(result);
  });

  // Live-Status (matches/active) je Regel mitliefern, siehe
  // RuleEngine.getRulesWithStatus - zeigt in der Oberflaeche, welche Regel
  // bei mehreren Regeln fuer dasselbe Ziel gerade tatsaechlich "gewinnt".
  app.get("/api/rules", (req, res) => {
    res.json(ruleEngine.getRulesWithStatus(api.systemStateReady ? api.systemState : null));
  });

  app.post("/api/rules", async (req, res) => {
    try {
      const { source, sources, target, invert, onDimLevel, onColor, onBehaviour, sourceLogic } = req.body;
      if (!(source || (Array.isArray(sources) && sources.length)) || !target) {
        throw new Error("Bitte mindestens einen Auslöser und eine LED auswählen.");
      }
      const rule = ruleEngine.addRule({ source, sources, target, invert, onDimLevel, onColor, onBehaviour, sourceLogic }, api.systemState);
      // Neue Regel kann - je nach Prioritaet/Bedingung - sofort das Ziel
      // uebernehmen (z.B. wenn ihre Bedingung schon erfuellt ist) - vor der
      // Antwort abgleichen, damit die Oberflaeche danach sofort den
      // tatsaechlichen Zustand zeigt (analog zu /api/control).
      await syncTargetSafely(rule.target.deviceId, rule.target.channelIndex);
      res.status(201).json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/rules/:id", async (req, res) => {
    try {
      const rule = ruleEngine.updateRule(req.params.id, req.body || {}, api.systemState);
      await syncTargetSafely(rule.target.deviceId, rule.target.channelIndex);
      res.json(rule);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // PRIORITAET aendern: verschiebt eine Regel in der Rangfolge nach oben/
  // unten (siehe RuleEngine.moveRule) - relevant, sobald mehrere Regeln
  // dasselbe Ziel haben und im Konfliktfall entschieden werden muss, welche
  // gewinnt.
  app.post("/api/rules/:id/move", async (req, res) => {
    try {
      const direction = req.body && req.body.direction === "down" ? "down" : "up";
      const rules = ruleEngine.moveRule(req.params.id, direction);
      const moved = rules.find((r) => r.id === req.params.id);
      if (moved) await syncTargetSafely(moved.target.deviceId, moved.target.channelIndex);
      res.json(ruleEngine.getRulesWithStatus(api.systemStateReady ? api.systemState : null));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/rules/:id", async (req, res) => {
    const existing = ruleEngine.getRules().find((r) => r.id === req.params.id);
    const ok = ruleEngine.deleteRule(req.params.id);
    if (!ok) return res.status(404).json({ error: "Regel nicht gefunden." });
    // Nach dem Loeschen kann eine andere, niedriger priorisierte Regel fuer
    // dasselbe Ziel jetzt zum Zug kommen (oder das Ziel muss ausgehen, wenn
    // keine mehr uebrig ist) - vor der Antwort abgleichen.
    if (existing) await syncTargetSafely(existing.target.deviceId, existing.target.channelIndex);
    res.status(204).end();
  });

  // Alle waehlbaren Ausloeser (Kanal + Bedingung) inkl. Kategorie, Raum und
  // aktuellem Zustand - siehe RuleEngine.listSourceOptions/conditions.js.
  app.get("/api/sources", (req, res) => {
    res.json(RuleEngine.listSourceOptions(api.systemState));
  });

  // Kanal-Typen + Feldnamen aller Geraete (ohne Namen/IDs) - siehe
  // RuleEngine.summarizeChannelFields.
  app.get("/api/channel-fields", (req, res) => {
    res.json(RuleEngine.summarizeChannelFields(api.systemState));
  });

  // Regeln sichern (Datei-Download)
  app.get("/api/rules/export", (req, res) => {
    const date = new Date().toISOString().slice(0, 10);
    res.set("Content-Disposition", `attachment; filename="wrc6-led-regeln-${date}.json"`);
    res.json(ruleEngine.exportRules());
  });

  // Regeln laden (aus einer Sicherung); werden hinten angehaengt.
  app.post("/api/rules/import", async (req, res) => {
    try {
      if (!api.systemStateReady) throw new Error("Keine Verbindung zur HCU – bitte kurz warten und erneut versuchen.");
      const result = ruleEngine.importRules(req.body, api.systemState);
      // Alle betroffenen LEDs sofort abgleichen
      const targets = new Set(ruleEngine.getRules().map((r) => `${r.target.deviceId}::${r.target.channelIndex}`));
      for (const key of targets) {
        const [deviceId, channelIndex] = key.split("::");
        await syncTargetSafely(deviceId, Number(channelIndex));
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/log", (req, res) => {
    res.json(ruleEngine.getLog());
  });

  // Manuelle Direktsteuerung eines einzelnen WRC6-230-Kanals (Helligkeit,
  // Farbe, an/aus) - unabhaengig von den gespeicherten Regeln, wirkt sofort.
  app.post("/api/control", async (req, res) => {
    try {
      const { deviceId, channelIndex, dimLevel, color, on, behaviour, rampTime } = req.body;
      if (!deviceId || channelIndex === undefined) {
        throw new Error("Keine LED angegeben.");
      }
      const { path: reqPath, body } = RuleEngine.buildManualControlRequest(api.systemState, deviceId, channelIndex, { dimLevel, color, on, behaviour, rampTime });
      const result = await api.sendSystemRequest(reqPath, body);
      // Duty-Cycle-Cache fuer dieses Ziel verwerfen, da die manuelle Aktion
      // am Regel-Engine-Zustand vorbeigeht - siehe RuleEngine.forgetTargetState.
      ruleEngine.forgetTargetState(deviceId, channelIndex);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return app;
}

function readWebPassword() {
  if (process.env.WEB_PASSWORD) return process.env.WEB_PASSWORD;
  try {
    const pw = fs.readFileSync(path.join(RuleEngine.DATA_DIR, "web-password.txt"), "utf8").trim();
    return pw || null;
  } catch (err) {
    return null;
  }
}

function basicAuth(password) {
  const expected = crypto.createHash("sha256").update(password).digest();
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const given = decoded.slice(decoded.indexOf(":") + 1);
      const givenHash = crypto.createHash("sha256").update(given).digest();
      if (crypto.timingSafeEqual(expected, givenHash)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="WRC6 Plugin", charset="UTF-8"');
    res.status(401).send("Anmeldung erforderlich");
  };
}

module.exports = { createWebServer };
