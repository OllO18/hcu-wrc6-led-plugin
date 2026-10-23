"use strict";

/**
 * Inhalt der Plugin-Einstellungsseite in HCUweb (ConfigTemplateResponse,
 * Connect-API-Doku 6.3.1 / 6.5.4 / 6.6.11).
 *
 * Angezeigt werden:
 *   - WEBLINK:  klickbarer Link (undokumentierter, aber von HCUweb
 *               unterstuetzter Typ - siehe Kommentar bei webLink)
 *   - READONLY: Adresse der Weboberflaeche als Text (zum Kopieren)
 *   - QRCODE:   dieselbe Adresse als QR-Code (zum Scannen mit dem Handy)
 *
 * Adresse: bevorzugt http://<IP der HCU>:<WEB_PORT> (IP per
 * SystemInfoRequest, siehe connectApi.requestSystemInfo/plugin.js).
 * Rueckfall: http://hcu1-XXXX.local:<WEB_PORT>, XXXX = letzte vier Zeichen
 * der SGTIN (Doku 6.1: "hcu1-XXXX.local, where XXXX are the last four
 * digits of the SGTIN"). Die SGTIN liegt im installierten Plugin unter
 * /SGTIN (Doku 4.2). Mit WEB_PUBLIC_URL laesst sich die Adresse
 * ueberschreiben (z.B. mit der IP-Adresse der HCU).
 */

const fs = require("fs");

function resolveWebUrl({ webPort, sgtinFile = "/SGTIN", env = process.env } = {}) {
  if (env.WEB_PUBLIC_URL) return env.WEB_PUBLIC_URL;
  try {
    const sgtin = fs.readFileSync(sgtinFile, "utf8").trim().replace(/[^0-9A-Za-z]/g, "");
    if (sgtin.length >= 4) return `http://hcu1-${sgtin.slice(-4).toUpperCase()}.local:${webPort}`;
  } catch (err) {
    // ausserhalb der HCU (lokaler Testlauf) gibt es keine /SGTIN
  }
  return `http://localhost:${webPort}`;
}

const TEXTS = {
  de: {
    group: "Weboberfläche",
    groupDesc: "Alle Einstellungen – Regeln, Auslöser, LED-Farben – nimmst du in der eigenen Weboberfläche des Plugins vor.",
    open: "Weboberfläche öffnen",
    openDesc: "Öffnet die Weboberfläche in einem neuen Fenster.",
    linkText: "Zur Weboberfläche",
    url: "Adresse der Weboberfläche",
    urlDesc: "Zum Kopieren in die Adresszeile des Browsers, z. B. für ein Lesezeichen.",
    qr: "Weboberfläche per QR-Code",
    qrDesc: "Mit der Handy-Kamera scannen (Handy im selben WLAN).",
  },
  en: {
    group: "Web interface",
    groupDesc: "All settings – rules, triggers, LED colours – are made in the plugin's own web interface.",
    open: "Open web interface",
    openDesc: "Opens the web interface in a new window.",
    linkText: "Go to web interface",
    url: "Web interface address",
    urlDesc: "To copy into the browser's address bar, e.g. for a bookmark.",
    qr: "Web interface QR code",
    qrDesc: "Scan with your phone camera (phone on the same network).",
  },
};

function buildConfigTemplate(languageCode, url) {
  const t = TEXTS[languageCode] || TEXTS.de;
  return {
    groups: {
      web: { friendlyName: t.group, description: t.groupDesc, order: 1 },
    },
    properties: {
      // WEBLINK ist in der Connect-API-Doku 1.0.1 NICHT beschrieben, wird von
      // HCUweb aber unterstuetzt (Typliste im HCUweb-Programmcode main.dart.js:
      // STRING, NUMBER, INTEGER, BOOLEAN, ENUM, TYPEAHEAD, READONLY, WEBLINK,
      // PASSWORD, QRCODE, FILE - aus dem HCUweb-Programmcode ausgelesen). Ein
      // anderes Plugin zeigt damit einen klickbaren Link. Die URL steht in
      // currentValue (und vorsichtshalber auch in defaultValue).
      // Das READONLY-Feld und der QR-Code bleiben als Rueckfallebene.
      webLink: {
        dataType: "WEBLINK",
        friendlyName: t.open,
        description: t.openDesc,
        currentValue: url,
        defaultValue: url,
        groupId: "web",
        order: 1,
      },
      webUrl: { dataType: "READONLY", friendlyName: t.url, description: t.urlDesc, currentValue: url, groupId: "web", order: 2 },
      webQr: { dataType: "QRCODE", friendlyName: t.qr, description: t.qrDesc, currentValue: url, groupId: "web", order: 3 },
    },
  };
}

module.exports = { resolveWebUrl, buildConfigTemplate };
