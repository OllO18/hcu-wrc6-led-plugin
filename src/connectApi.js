"use strict";

/**
 * Minimalistischer Client fuer die Homematic IP Connect API (WebSocket).
 *
 * Implementiert genau den Nachrichtenfluss, der in der offiziellen
 * Connect-API-Dokumentation (Version 1.0.1, https://github.com/homematicip/connect-api)
 * unter "3.1 Report the plugin state" und "3.3 Control and monitor" beschrieben ist:
 *
 *  - Envelope-Format: { id, pluginId, type, body }
 *  - Beim Verbindungsaufbau: PLUGIN_STATE_RESPONSE (READY) senden
 *  - Danach: HMIP_SYSTEM_REQUEST auf /hmip/home/getSystemState, um den
 *    initialen Systemzustand zu laden und zu cachen
 *  - Laufend: HMIP_SYSTEM_EVENT-Nachrichten verarbeiten und den Cache
 *    aktualisieren (Header "hmip-system-events: true" beim Connect noetig)
 *  - Steuerbefehle ueber HMIP_SYSTEM_REQUEST an beliebige
 *    /hmip/device/control/... Pfade senden
 *
 * Diese Datei kennt keine WRC6-spezifische Logik - das macht rules.js.
 */

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

const REQUEST_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 5000;

class ConnectApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.pluginId
   * @param {string} opts.host  z.B. "host.containers.internal" (installiert) oder "hcu1-XXXX.local" (remote)
   * @param {string} opts.authToken
   * @param {(log: {level:string, message:string, meta?:any}) => void} opts.onLog
   */
  constructor({ pluginId, host, authToken, onLog }) {
    this.pluginId = pluginId;
    this.host = host;
    this.authToken = authToken;
    this.onLog = onLog || (() => {});

    this.ws = null;
    this.connected = false;
    this.pending = new Map(); // messageId -> { resolve, reject, timeout }

    /** Zwischengespeicherter Systemzustand: { devices: {...}, groups: {...} } */
    this.systemState = { devices: {}, groups: {} };
    this.systemStateReady = false;

    /** IP-Adresse der HCU aus SYSTEM_INFO_RESPONSE (siehe requestSystemInfo) */
    this.hcuIpAddress = null;
    this._systemInfoWaiters = [];

    /** Aufrufer, die ueber Aenderungen an Geraeten informiert werden wollen */
    this.deviceChangeListeners = [];
  }

  /**
   * SystemInfoRequest (Doku 6.3.12) senden; die Antwort setzt
   * this.hcuIpAddress. Liefert ein Promise mit der IP (oder null nach
   * timeoutMs ohne Antwort).
   */
  requestSystemInfo(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this._systemInfoWaiters.indexOf(done);
        if (i >= 0) this._systemInfoWaiters.splice(i, 1);
        resolve(this.hcuIpAddress || null);
      }, timeoutMs);
      const done = (ip) => {
        clearTimeout(timer);
        resolve(ip);
      };
      this._systemInfoWaiters.push(done);
      if (!this._send({ id: uuidv4(), pluginId: this.pluginId, type: "SYSTEM_INFO_REQUEST", body: {} })) {
        done(this.hcuIpAddress || null);
      }
    });
  }

  /** fn(languageCode) -> ConfigTemplateResponse-Body, siehe hcuConfig.js */
  setConfigTemplateProvider(fn) {
    this.configTemplateProvider = fn;
  }

  onDeviceChange(fn) {
    this.deviceChangeListeners.push(fn);
  }

  log(level, message, meta) {
    this.onLog({ level, message, meta, ts: Date.now() });
  }

  start() {
    this._connect();
  }

  _connect() {
    const url = `wss://${this.host}:9001`;
    this.log("info", `Verbinde mit Connect API unter ${url} ...`);

    this.ws = new WebSocket(url, {
      rejectUnauthorized: false, // die HCU nutzt ein selbst-signiertes Zertifikat
      headers: {
        authtoken: this.authToken,
        "plugin-id": this.pluginId,
        "hmip-system-events": "true",
      },
    });

    this.ws.on("open", () => {
      this.connected = true;
      this.log("info", "WebSocket verbunden.");
      this._sendPluginReady(uuidv4());
      this._requestSystemState();
      this.requestSystemInfo();
    });

    this.ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        this.log("error", "Konnte Nachricht nicht parsen", { error: String(err) });
        return;
      }
      this._handleMessage(message);
    });

    this.ws.on("close", (code, reason) => {
      this.connected = false;
      this.systemStateReady = false;
      // Offene Anfragen sofort mit Fehler beenden statt 10 s auf die
      // Zeitueberschreitung zu warten - die Antwort kommt nach einem
      // Verbindungsabbruch ohnehin nie mehr.
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("Verbindung zur HCU unterbrochen"));
        this.pending.delete(id);
      }
      this.log("warn", `WebSocket getrennt (${code} ${reason || ""}). Neuer Versuch in ${RECONNECT_DELAY_MS / 1000}s.`);
      setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    });

    this.ws.on("error", (err) => {
      this.log("error", "WebSocket-Fehler", { error: err.message || String(err) });
    });
  }

  _handleMessage(message) {
    const { id, type, body } = message;

    switch (type) {
      case "PLUGIN_STATE_REQUEST":
        // Die HCU fragt aktiv nach dem Plugin-Status (z.B. beim Oeffnen der Plugin-Seite in HCUweb)
        this._sendPluginReady(id);
        break;

      case "HMIP_SYSTEM_RESPONSE": {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          if (body && body.code === 200) {
            pending.resolve(body.body);
          } else {
            pending.reject(new Error(`Die HCU hat den Befehl abgelehnt (Code ${body && body.code}: ${JSON.stringify(body && body.body)})`));
          }
        }
        break;
      }

      case "HMIP_SYSTEM_EVENT":
        this._handleSystemEvent(body);
        break;

      case "SYSTEM_INFO_RESPONSE":
        // Doku 6.4.15: enthaelt u.a. die IP-Adresse der HCU (ipAddress) -
        // genutzt fuer den Link auf der HCUweb-Einstellungsseite.
        if (body && body.success !== false && typeof body.ipAddress === "string" && body.ipAddress) {
          if (this.hcuIpAddress !== body.ipAddress) this.log("info", `IP-Adresse der HCU: ${body.ipAddress}`);
          this.hcuIpAddress = body.ipAddress;
        }
        for (const resolve of this._systemInfoWaiters.splice(0)) resolve(this.hcuIpAddress || null);
        break;

      case "ERROR_RESPONSE":
        this.log("error", "Fehlermeldung von der HCU erhalten", { body });
        break;

      case "CONFIG_TEMPLATE_REQUEST": {
        // Falls die IP-Adresse der HCU noch unbekannt ist: kurz (max. 3 s)
        // nachfragen und erst dann antworten (Doku: Antwort binnen 10 s).
        if (!this.hcuIpAddress && this.configTemplateProvider) {
          const lang0 = (body && body.languageCode) || "de";
          this.requestSystemInfo(3000).then(() => {
            this._send({ id, pluginId: this.pluginId, type: "CONFIG_TEMPLATE_RESPONSE", body: this.configTemplateProvider(lang0) });
          });
          break;
        }
        // Einstellungsseite in HCUweb (siehe hcuConfig.js). Bis v0.22.0 wurde
        // hier faelschlich { propertyTemplates: {} } gesendet - das Pflichtfeld
        // heisst laut Doku 6.3.1 "properties".
        const lang = (body && body.languageCode) || "de";
        this._send({
          id,
          pluginId: this.pluginId,
          type: "CONFIG_TEMPLATE_RESPONSE",
          body: this.configTemplateProvider ? this.configTemplateProvider(lang) : { properties: {} },
        });
        break;
      }

      case "CONFIG_UPDATE_REQUEST":
        // Die Einstellungsseite enthaelt nur Anzeigefelder (READONLY/QRCODE) -
        // nichts zu uebernehmen, aber laut Doku 6.3.2 trotzdem bestaetigen.
        this._send({
          id,
          pluginId: this.pluginId,
          type: "CONFIG_UPDATE_RESPONSE",
          body: { status: "APPLIED" },
        });
        break;

      default:
        // DiscoverRequest, StatusRequest etc. ignorieren wir bewusst - dieses Plugin
        // bindet keine eigenen virtuellen Geraete ein (siehe 3.2 "Include devices").
        break;
    }
  }

  _requestSystemState() {
    this.sendSystemRequest("/hmip/home/getSystemState", {})
      .then((responseBody) => {
        this.systemState.devices = (responseBody && responseBody.devices) || {};
        this.systemState.groups = (responseBody && responseBody.groups) || {};
        this.systemStateReady = true;
        this.log("info", `Systemzustand geladen: ${Object.keys(this.systemState.devices).length} Geraete.`);
        this._notifyDeviceChange(Object.keys(this.systemState.devices));
      })
      .catch((err) => {
        this.log("error", "getSystemState fehlgeschlagen", { error: err.message });
      });
  }

  _handleSystemEvent(body) {
    const tx = body && body.eventTransaction;
    if (!tx || !tx.events) return;

    const changedDeviceIds = new Set();

    for (const key of Object.keys(tx.events)) {
      const evt = tx.events[key];
      switch (evt.pushEventType) {
        case "DEVICE_CHANGED":
        case "DEVICE_ADDED":
          if (evt.device && evt.device.id) {
            this.systemState.devices[evt.device.id] = evt.device;
            changedDeviceIds.add(evt.device.id);
          }
          break;
        case "DEVICE_REMOVED":
          if (evt.device && evt.device.id) {
            delete this.systemState.devices[evt.device.id];
          }
          break;
        case "GROUP_CHANGED":
        case "GROUP_ADDED":
          if (evt.group && evt.group.id) {
            this.systemState.groups[evt.group.id] = evt.group;
          }
          break;
        case "GROUP_REMOVED":
          if (evt.group && evt.group.id) {
            delete this.systemState.groups[evt.group.id];
          }
          break;
        default:
          break;
      }
    }

    if (changedDeviceIds.size > 0) {
      this._notifyDeviceChange([...changedDeviceIds]);
    }
  }

  _notifyDeviceChange(deviceIds) {
    for (const fn of this.deviceChangeListeners) {
      try {
        fn(deviceIds, this.systemState);
      } catch (err) {
        this.log("error", "Fehler in Device-Change-Listener", { error: err.message });
      }
    }
  }

  _sendPluginReady(messageId) {
    this._send({
      id: messageId,
      pluginId: this.pluginId,
      type: "PLUGIN_STATE_RESPONSE",
      body: { pluginReadinessStatus: "READY" },
    });
  }

  /**
   * Sendet einen HMIP_SYSTEM_REQUEST und liefert ein Promise, das mit dem
   * inneren "body" der HMIP_SYSTEM_RESPONSE aufgeloest wird (bei code=200).
   */
  sendSystemRequest(path, body) {
    const id = uuidv4();
    const message = {
      id,
      pluginId: this.pluginId,
      type: "HMIP_SYSTEM_REQUEST",
      body: { path, body: body || {} },
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Die HCU hat nicht rechtzeitig geantwortet (${path})`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timeout });
      if (!this._send(message)) {
        // Nicht gesendet (Verbindung zu) - sofort Fehler statt Zeitueberschreitung.
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`Keine Verbindung zur HCU (${path})`));
      }
    });
  }

  _send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("warn", "Konnte Nachricht nicht senden - WebSocket nicht offen", { type: message.type });
      return false;
    }
    this.ws.send(JSON.stringify(message));
    return true;
  }
}

/**
 * Liest den Auth-Token: als installiertes Plugin liegt er unter /TOKEN
 * (von der HCU automatisch ins Image kopiert, siehe Containerization-Kapitel
 * der Doku). Fuer lokale Entwicklung/Tests ausserhalb der HCU kann alternativ
 * ueber die Umgebungsvariable HCU_AUTH_TOKEN_FILE eine andere Datei angegeben
 * werden.
 */
function readAuthToken() {
  const file = process.env.HCU_AUTH_TOKEN_FILE || "/TOKEN";
  return fs.readFileSync(file, "utf8").trim();
}

module.exports = { ConnectApiClient, readAuthToken };
