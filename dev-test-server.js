"use strict";
// Eigenes, temporaeres Datenverzeichnis - darf NIE die echte data/rules.json
// anfassen (bis v0.18.5 hat dieses Skript sie geleert). Muss VOR dem
// require von src/rules gesetzt werden.
process.env.WRC6_DATA_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "wrc6-test-"));
// Nur fuer die manuelle/visuelle UI-Pruefung in der Sandbox - kein Teil des Plugins.
const { RuleEngine } = require("./src/rules");
const { createWebServer } = require("./src/webServer");

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
        "9": { functionalChannelType: "NOTIFICATION_LIGHT_CHANNEL", index: 9, label: "LED (9) Haustuer", dimLevel: 0.4 },
        "11": { functionalChannelType: "OPTICAL_SIGNAL_CHANNEL", index: 11, label: "LED (11) Garten", dimLevel: 0, simpleRGBColorState: "WHITE" },
        "12": { functionalChannelType: "OPTICAL_SIGNAL_CHANNEL", index: 12, label: "LED (12) Waschmaschine", dimLevel: 1, simpleRGBColorState: "GREEN" },
        "13": { functionalChannelType: "OPTICAL_SIGNAL_CHANNEL", index: 13, label: "LED (13) Garage", dimLevel: 0.5, simpleRGBColorState: "BLUE" },
        "14": { functionalChannelType: "OPTICAL_SIGNAL_CHANNEL", index: 14, label: "LED (14) Rauchmelder", dimLevel: 0, simpleRGBColorState: "WHITE" },
        "10": {
          functionalChannelType: "NOTIFICATION_LIGHT_CHANNEL",
          index: 10,
          label: "LED (10) Kueche",
          dimLevel: 0.6,
          simpleRGBColorState: "RED",
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
  },
  groups: {
    "room-flur": { id: "room-flur", type: "META", label: "Flur" },
    "room-kueche": { id: "room-kueche", type: "META", label: "Küche" },
    "sec-flur": { id: "sec-flur", type: "SECURITY", metaGroupId: "room-flur" },
    "sec-kueche": { id: "sec-kueche", type: "SECURITY", metaGroupId: "room-kueche" },
  },
};

// Beispielgeraete fuer die weiteren Ausloeser (Feldnamen wie in einer echten
// data/channel-fields.json vom 18.10.2026).
Object.assign(systemState.devices, {
  "MOTION-DEV": { id: "MOTION-DEV", label: "BWM Flur", modelType: "HmIP-SMI", functionalChannels: {
    "0": { functionalChannelType: "DEVICE_SABOTAGE", lowBat: false, unreach: false, sabotage: false, groups: ["room-flur"] },
    "1": { functionalChannelType: "MOTION_DETECTION_CHANNEL", motionDetected: false, illumination: 120.5, groups: ["room-flur"] } } },
  "SMOKE-DEV": { id: "SMOKE-DEV", label: "Rauchmelder Küche", modelType: "HmIP-SWSD-2", functionalChannels: {
    "0": { functionalChannelType: "DEVICE_BASE", lowBat: false, unreach: false, groups: ["room-kueche"] },
    "1": { functionalChannelType: "SMOKE_DETECTOR_CHANNEL", smokeDetectorAlarmType: "IDLE_OFF", groups: ["room-kueche"] } } },
  "THERMO-DEV": { id: "THERMO-DEV", label: "Thermostat Küche", modelType: "HmIP-WTH-1", functionalChannels: {
    "1": { functionalChannelType: "WALL_MOUNTED_THERMOSTAT_PRO_CHANNEL", actualTemperature: 22.1, humidity: 53, groups: ["room-kueche"] } } },
  "PLUG-DEV": { id: "PLUG-DEV", label: "Waschmaschine", modelType: "HmIP-PSMCO", functionalChannels: {
    "1": { functionalChannelType: "SWITCH_MEASURING_CHANNEL", on: true, currentPowerConsumption: 36.56, groups: ["room-flur"] } } },
});

const ruleEngine = new RuleEngine({ onLog: () => {}, verifyDelayMs: 0 });
for (const r of [...ruleEngine.getRules()]) ruleEngine.deleteRule(r.id);

const fakeApi = {
  connected: true,
  systemStateReady: true,
  systemState,
  sendSystemRequest: async (path, body) => {
    console.log("CONTROL CALL:", path, JSON.stringify(body));
    return { code: 200 };
  },
};

const app = createWebServer({ api: fakeApi, ruleEngine });
app.listen(4321, () => console.log("dev-test-server läuft auf http://localhost:4321"));
