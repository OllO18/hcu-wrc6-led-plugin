"use strict";

/**
 * Einstiegspunkt des Plugins.
 *
 * Wichtig zum Scope dieses Plugins (bewusst so entschieden, siehe README):
 * Die Connect API erlaubt es NICHT, die interne Kanal-Konfiguration eines
 * bestehenden nativen Homematic IP Geraets (z.B. welche Taste welche LED
 * ansteuert / Direktverknuepfungen) zu veraendern - das bleibt Sache der
 * Homematic IP App. Dieses Plugin bildet daher eine SOFTWARE-Regel nach:
 * "Wenn Lichtquelle X an/aus schaltet, schalte WRC6-LED Y mit" - per
 * Connect-API-Steuerbefehlen und -Events, konfigurierbar ueber eine eigene
 * Weboberflaeche statt per YAML/Code.
 */

const { ConnectApiClient, readAuthToken } = require("./connectApi");
const { RuleEngine } = require("./rules");
const { createWebServer } = require("./webServer");
const { resolveWebUrl, buildConfigTemplate } = require("./hcuConfig");
const fs = require("fs");
const path = require("path");

const PLUGIN_ID = process.env.HCU_PLUGIN_ID || "io.github.ollo18.wrc6led";
const HOST = process.env.HCU_HOST || "host.containers.internal";
const WEB_PORT = Number(process.env.WEB_PORT || 8099);
/** "debug" zeigt zusaetzlich jeden gesendeten Befehl und jede Regel-
 * Auswertung (Fehlersuche). Standard "info". */
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

function log({ level, message, meta, ts }) {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  const time = new Date(ts).toISOString();
  const suffix = meta ? " " + JSON.stringify(meta) : "";
  // eslint-disable-next-line no-console
  console.log(`[${time}] [${level.toUpperCase()}] ${message}${suffix}`);
}

async function main() {
  const authToken = readAuthToken();

  const api = new ConnectApiClient({
    pluginId: PLUGIN_ID,
    host: HOST,
    authToken,
    onLog: log,
  });

  const ruleEngine = new RuleEngine({ onLog: log });

  // Adresse der Weboberflaeche fuer die Einstellungsseite in HCUweb
  // Vorrang: WEB_PUBLIC_URL > IP-Adresse der HCU (SystemInfoResponse) >
  // hcu1-XXXX.local aus /SGTIN. Der .local-Name wird nicht ueberall
  // aufgeloest (z. B. unter Windows/Firefox oft nicht) - daher IP bevorzugt.
  const fallbackUrl = resolveWebUrl({ webPort: WEB_PORT });
  const currentWebUrl = () =>
    process.env.WEB_PUBLIC_URL || (api.hcuIpAddress ? `http://${api.hcuIpAddress}:${WEB_PORT}` : fallbackUrl);
  api.setConfigTemplateProvider((lang) => buildConfigTemplate(lang, currentWebUrl()));

  let initialized = false;
  api.onDeviceChange((changedDeviceIds, systemState) => {
    if (!initialized) {
      // Erster Aufruf nach getSystemState: alle Regeln sofort anhand des
      // TATSAECHLICHEN AKTUELLEN Zustands der Quellen durchsetzen (nicht nur
      // stumm merken) - z.B. wenn ein Fenster beim Plugin-Start schon offen
      // ist, soll die LED sofort angehen statt erst auf eine zukuenftige
      // Zustandsaenderung zu warten. Siehe RuleEngine.enforceAllRules.
      initialized = true;
      // Kanal-Typen/Feldnamen einmal pro Start in eine Datei schreiben
      // (data/channel-fields.json, ohne Namen/IDs) - Grundlage fuer die
      // Unterstuetzung weiterer Sensortypen anhand echter Daten.
      try {
        const file = path.join(RuleEngine.DATA_DIR, "channel-fields.json");
        fs.mkdirSync(RuleEngine.DATA_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(RuleEngine.summarizeChannelFields(systemState), null, 2), "utf8");
        log({ level: "info", message: `Kanal-Uebersicht geschrieben: ${file}`, ts: Date.now() });
      } catch (err) {
        log({ level: "warn", message: "Konnte Kanal-Uebersicht nicht schreiben", meta: { error: err.message }, ts: Date.now() });
      }
      ruleEngine
        .enforceAllRules(systemState, (path, body) => api.sendSystemRequest(path, body))
        .catch((err) => log({ level: "error", message: "Fehler beim initialen Abgleich der Regeln", meta: { error: err.message }, ts: Date.now() }));
      return;
    }
    ruleEngine
      .onDevicesChanged(changedDeviceIds, systemState, (path, body) => api.sendSystemRequest(path, body))
      .catch((err) => log({ level: "error", message: "Fehler bei der Regel-Auswertung", meta: { error: err.message }, ts: Date.now() }));
  });

  api.start();

  const app = createWebServer({ api, ruleEngine });
  app.listen(WEB_PORT, () => {
    log({ level: "info", message: `Web-Oberflaeche laeuft auf Port ${WEB_PORT}`, ts: Date.now() });
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fataler Fehler beim Start des Plugins:", err);
  process.exit(1);
});
