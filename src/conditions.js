"use strict";

/**
 * Ausloeser-Bedingungen ("conditions") fuer Regel-Quellen (ab v0.21.0).
 *
 * Eine Quelle ist ab jetzt nicht mehr nur "Kanal X", sondern
 * "Kanal X + Bedingung", z.B. "Bewegungsmelder Flur: Bewegung erkannt" oder
 * "Messsteckdose Waschmaschine: Leistung > 5 W". Derselbe Kanal kann so
 * mehrere Bedingungen anbieten (z.B. Basiskanal 0: Batterie schwach,
 * nicht erreichbar, Sabotage).
 *
 * ALLE Feldnamen stammen aus einem echten Systemzustand
 * (data/channel-fields.json vom 18.10.2026), nicht aus Vermutungen.
 * Nicht durch echte Daten belegt (nur ein Wert beobachtet) und daher
 * bewusst "alles ausser Ruhezustand" ausgewertet:
 *   - smokeDetectorAlarmType: beobachtet nur "IDLE_OFF" -> jeder andere
 *     Wert gilt als Alarm.
 *   - lockState: beobachtet nur "UNLOCKED" -> alles ausser "LOCKED" gilt
 *     als "nicht abgeschlossen".
 *
 * Quellen OHNE condition (Regeln aus Versionen vor 0.21.0) werden wie
 * bisher ausgewertet (on -> dimLevel -> windowState), siehe legacyCondition.
 */

const CATEGORIES = {
  WINDOW: "Fenster & Türen",
  MOTION: "Bewegung & Erschütterung",
  ALARM: "Wasser & Rauch",
  LOCK: "Türschloss",
  SWITCH: "Schalter & Licht",
  CLIMATE: "Temperatur & Luftfeuchte",
  ENERGY: "Strom & Energie",
  LIGHT_LEVEL: "Helligkeit",
  STATUS: "Gerätestatus",
};

const bool = (v) => typeof v === "boolean";
const num = (v) => typeof v === "number" && Number.isFinite(v);
const fmt = (v, digits) => (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString("de-DE");

/**
 * Jede Bedingung:
 *   label     - Anzeige in der Oberflaeche
 *   category  - Kategorie fuer den Filter
 *   applies(channel, device) - bietet dieser Kanal die Bedingung an?
 *   evaluate(channel)        - true/false/null (nur boolesche Bedingungen)
 *   stateLabel(channel)      - aktueller Zustand als Text
 *   numeric   - nur bei Schwellwert-Bedingungen: { read(channel), unit,
 *               digits, hysteresis(threshold) }
 */
const CONDITIONS = {
  on: {
    label: "eingeschaltet",
    category: CATEGORIES.SWITCH,
    applies: (ch) => bool(ch.on) || (num(ch.dimLevel) && !bool(ch.on)),
    evaluate: (ch) => (bool(ch.on) ? ch.on : num(ch.dimLevel) ? ch.dimLevel > 0 : null),
    stateLabel: (ch) => {
      const v = CONDITIONS.on.evaluate(ch);
      return v === null ? null : v ? "AN" : "AUS";
    },
  },
  windowOpen: {
    label: "offen/gekippt",
    category: CATEGORIES.WINDOW,
    applies: (ch) => typeof ch.windowState === "string",
    evaluate: (ch) => (typeof ch.windowState === "string" ? ch.windowState === "OPEN" || ch.windowState === "TILTED" : null),
    stateLabel: (ch) => (ch.windowState === "CLOSED" ? "GESCHLOSSEN" : ch.windowState === "TILTED" ? "GEKIPPT" : ch.windowState ? "OFFEN" : null),
  },
  motion: {
    label: "Bewegung erkannt",
    category: CATEGORIES.MOTION,
    applies: (ch) => bool(ch.motionDetected),
    evaluate: (ch) => (bool(ch.motionDetected) ? ch.motionDetected : null),
    stateLabel: (ch) => (bool(ch.motionDetected) ? (ch.motionDetected ? "BEWEGUNG" : "RUHE") : null),
  },
  vibration: {
    label: "Erschütterung/Neigung ausgelöst",
    category: CATEGORIES.MOTION,
    applies: (ch) => bool(ch.accelerationSensorTriggered),
    evaluate: (ch) => (bool(ch.accelerationSensorTriggered) ? ch.accelerationSensorTriggered : null),
    stateLabel: (ch) => (bool(ch.accelerationSensorTriggered) ? (ch.accelerationSensorTriggered ? "AUSGELÖST" : "RUHE") : null),
  },
  water: {
    label: "Wasser/Feuchtigkeit erkannt",
    category: CATEGORIES.ALARM,
    applies: (ch) => bool(ch.waterlevelDetected) || bool(ch.moistureDetected),
    evaluate: (ch) => {
      if (!bool(ch.waterlevelDetected) && !bool(ch.moistureDetected)) return null;
      return ch.waterlevelDetected === true || ch.moistureDetected === true;
    },
    stateLabel: (ch) => {
      const v = CONDITIONS.water.evaluate(ch);
      return v === null ? null : v ? "WASSER" : "TROCKEN";
    },
  },
  smokeAlarm: {
    label: "Rauchalarm",
    category: CATEGORIES.ALARM,
    applies: (ch) => typeof ch.smokeDetectorAlarmType === "string",
    evaluate: (ch) => (typeof ch.smokeDetectorAlarmType === "string" ? ch.smokeDetectorAlarmType !== "IDLE_OFF" : null),
    stateLabel: (ch) => (typeof ch.smokeDetectorAlarmType === "string" ? (ch.smokeDetectorAlarmType === "IDLE_OFF" ? "RUHE" : "ALARM") : null),
  },
  unlocked: {
    label: "nicht abgeschlossen",
    category: CATEGORIES.LOCK,
    applies: (ch) => typeof ch.lockState === "string",
    evaluate: (ch) => (typeof ch.lockState === "string" ? ch.lockState !== "LOCKED" : null),
    stateLabel: (ch) => (typeof ch.lockState === "string" ? (ch.lockState === "LOCKED" ? "ABGESCHLOSSEN" : "AUFGESCHLOSSEN") : null),
  },
  lowBat: {
    label: "Batterie schwach",
    category: CATEGORIES.STATUS,
    applies: (ch) => bool(ch.lowBat),
    evaluate: (ch) => (bool(ch.lowBat) ? ch.lowBat : null),
    stateLabel: (ch) => (bool(ch.lowBat) ? (ch.lowBat ? "SCHWACH" : "OK") : null),
  },
  unreach: {
    label: "nicht erreichbar",
    category: CATEGORIES.STATUS,
    applies: (ch) => bool(ch.unreach),
    evaluate: (ch) => (bool(ch.unreach) ? ch.unreach : null),
    stateLabel: (ch) => (bool(ch.unreach) ? (ch.unreach ? "NICHT ERREICHBAR" : "OK") : null),
  },
  sabotage: {
    label: "Sabotage",
    category: CATEGORIES.STATUS,
    applies: (ch) => bool(ch.sabotage),
    evaluate: (ch) => (bool(ch.sabotage) ? ch.sabotage : null),
    stateLabel: (ch) => (bool(ch.sabotage) ? (ch.sabotage ? "SABOTAGE" : "OK") : null),
  },
  temperature: {
    label: "Temperatur",
    category: CATEGORIES.CLIMATE,
    numeric: {
      // Wandthermostate: actualTemperature; Heizkoerperthermostate:
      // valveActualTemperature (beides in echten Daten beobachtet).
      read: (ch) => (num(ch.actualTemperature) ? ch.actualTemperature : num(ch.valveActualTemperature) ? ch.valveActualTemperature : null),
      unit: "°C",
      digits: 1,
      hysteresis: () => 0.2,
    },
  },
  humidity: {
    label: "Luftfeuchte",
    category: CATEGORIES.CLIMATE,
    numeric: { read: (ch) => (num(ch.humidity) ? ch.humidity : null), unit: "%", digits: 0, hysteresis: () => 2 },
    // Die "SystemHealth"-Pseudogeraete melden unter "humidity" keine
    // Luftfeuchte (Duty Cycle/Carrier Sense) - ausblenden.
    excludeDevice: (device) => /^SystemHealth/.test(device.modelType || ""),
  },
  power: {
    label: "Leistung",
    category: CATEGORIES.ENERGY,
    numeric: {
      read: (ch) => (num(ch.currentPowerConsumption) ? ch.currentPowerConsumption : null),
      unit: "W",
      digits: 1,
      hysteresis: (t) => Math.max(0.5, Math.abs(t) * 0.1),
    },
  },
  illumination: {
    label: "Helligkeit",
    category: CATEGORIES.LIGHT_LEVEL,
    numeric: {
      read: (ch) => (num(ch.illumination) ? ch.illumination : null),
      unit: "lx",
      digits: 1,
      hysteresis: (t) => Math.max(1, Math.abs(t) * 0.1),
    },
  },
};

// Numerische Bedingungen: applies/stateLabel generisch ableiten.
for (const c of Object.values(CONDITIONS)) {
  if (!c.numeric) continue;
  c.applies = (ch, device) => c.numeric.read(ch) !== null && !(c.excludeDevice && device && c.excludeDevice(device));
  c.stateLabel = (ch) => {
    const v = c.numeric.read(ch);
    return v === null ? null : `${fmt(v, c.numeric.digits)} ${c.numeric.unit}`;
  };
}

const OPERATORS = { ">": "größer als", "<": "kleiner als" };

/** Bedingung fuer Quellen ohne condition (vor v0.21.0) - entspricht exakt
 * dem bisherigen readBooleanState: on -> dimLevel -> windowState. */
function legacyCondition(channel) {
  if (!channel) return null;
  if (bool(channel.on) || num(channel.dimLevel)) return "on";
  if (typeof channel.windowState === "string") return "windowOpen";
  return null;
}

/** Alle Bedingungen, die ein Kanal anbietet (Schluessel-Liste). */
function conditionsForChannel(channel, device) {
  if (!channel) return [];
  return Object.keys(CONDITIONS).filter((k) => CONDITIONS[k].applies(channel, device));
}

/**
 * Prueft eine Quelle (aus Formular/API) und liefert die normalisierte
 * Form {condition, op?, threshold?}. Wirft bei ungueltigen Angaben.
 */
function normalizeSourceCondition(source, channel, device) {
  const condition = source.condition || legacyCondition(channel);
  const def = CONDITIONS[condition];
  if (!def) throw new Error(`Unbekannte Bedingung "${source.condition}".`);
  if (!def.applies(channel, device)) throw new Error(`Die Bedingung „${def.label}“ passt nicht zu diesem Gerät.`);
  if (!def.numeric) return { condition };
  const op = source.op || ">";
  if (!OPERATORS[op]) throw new Error(`Ungültiger Vergleich "${source.op}". Erlaubt: > oder <.`);
  const threshold = Number(source.threshold);
  if (source.threshold === undefined || source.threshold === null || source.threshold === "" || !Number.isFinite(threshold)) {
    throw new Error(`Für „${def.label}“ fehlt ein gültiger Grenzwert.`);
  }
  return { condition, op, threshold };
}

/** Kurztext einer Quellen-Bedingung, z.B. "Leistung > 5 W". */
function describeCondition(source) {
  const def = CONDITIONS[source.condition];
  if (!def) return "";
  if (def.numeric) return `${def.label} ${source.op || ">"} ${fmt(Number(source.threshold), 2)} ${def.numeric.unit}`;
  return def.label;
}

module.exports = {
  CONDITIONS,
  CATEGORIES,
  OPERATORS,
  legacyCondition,
  conditionsForChannel,
  normalizeSourceCondition,
  describeCondition,
};
