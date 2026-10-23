"use strict";

const $ = (sel) => document.querySelector(sel);

let devicesCache = [];
/** Alle waehlbaren Ausloeser (Kanal + Bedingung), siehe /api/sources. */
let sourcesCache = [];
/** Vergleich/Grenzwert je Schwellwert-Ausloeser: key -> { op, threshold }. */
const sourceParams = {};

/** Farbdarstellung fuer die von der Connect API erlaubten 8 Signalfarben.
 * "text" ist die Textfarbe fuer ausreichenden Kontrast auf dem jeweiligen
 * Hintergrund (fuer die grafische Zustandsanzeige, siehe currentStateEl). */
const COLOR_SWATCHES = [
  { value: "WHITE", hex: "#ffffff", label: "Weiß", text: "#1f2430" },
  { value: "YELLOW", hex: "#e6c400", label: "Gelb", text: "#1f2430" },
  { value: "RED", hex: "#d62728", label: "Rot", text: "#ffffff" },
  { value: "PURPLE", hex: "#9467bd", label: "Lila", text: "#ffffff" },
  { value: "BLUE", hex: "#2f6fed", label: "Blau", text: "#ffffff" },
  { value: "TURQUOISE", hex: "#17becf", label: "Türkis", text: "#ffffff" },
  { value: "GREEN", hex: "#2ca02c", label: "Grün", text: "#ffffff" },
  { value: "BLACK", hex: "#2b2b2b", label: "Schwarz (aus)", text: "#ffffff" },
];

/** Vom Connect-API-Endpunkt setOpticalSignal dokumentierte Signaleffekte
 * (Doku Kapitel 6.8.1.21) - "" (Standard) nutzt weiterhin den bereits
 * getesteten setSimpleRGBColorDimLevel-Pfad fuer dauerhaftes Leuchten. */
const SIGNAL_BEHAVIOUR_OPTIONS = [
  { value: "", label: "Dauerhaft" },
  { value: "BLINKING_MIDDLE", label: "Blinken" },
  { value: "FLASH_MIDDLE", label: "Blitzen" },
  { value: "BILLOW_MIDDLE", label: "Wallend" },
];

/** Verknuepfung mehrerer Quellen EINER Regel, siehe rules.js SOURCE_LOGIC_VALUES. */
const SOURCE_LOGIC_OPTIONS = [
  { value: "OR", label: "LED an, wenn mindestens einer zutrifft (ODER)" },
  { value: "AND", label: "LED an, nur wenn alle gleichzeitig zutreffen (UND)" },
];

function behaviourLabelFor(value) {
  const match = SIGNAL_BEHAVIOUR_OPTIONS.find((b) => b.value === value);
  if (match && match.value) return match.label;
  if (value === "ON" || !value) return null; // dauerhaft an - keine Extra-Anzeige noetig
  if (value === "OFF") return null; // Aus wird bereits ueber das AN/AUS-Badge angezeigt
  return value; // unbekannter Wert - lieber roh anzeigen als verschweigen
}

/** channelKey -> { dimLevelPercent, color } - lokaler Entwurfszustand der
 * manuellen Steuerung, damit laufende Slider-/Farbwahl nicht durch das
 * 3-Sekunden-Live-Polling ueberschrieben wird (siehe refreshDevices). */
const manualState = {};

/** Entwurfszustand fuer die Ziel-Einstellung im "Neue Regel"-Formular. */
let newRuleTargetState = { dimLevelPercent: 100, color: "WHITE", behaviour: "" };

/** Ausgewaehlte Quellen im "Neue Regel"-Formular (channelKey -> true). */
const selectedSourceKeys = new Set();

/** Aktuell gewaehlte Filter fuer die Quellenliste. */
// categories/rooms: Mehrfachauswahl (leere Menge = alle), siehe createMultiFilter.
const sourceFilters = { categories: new Set(), rooms: new Set(), search: "", onlySelected: false };

/** Wert fuer Kanaele ohne ermittelbaren Raum im Raum-Filter. */
const NO_ROOM = "\u0000ohne-raum";

/**
 * Aufklappbarer Mehrfachauswahl-Filter (<details> mit Haekchen) als Ersatz
 * fuer ein einfaches <select>. selected: Set der gewaehlten Werte, leer =
 * keine Einschraenkung ("alle"). setOptions() baut die Liste nur neu, wenn
 * sich die verfuegbaren Werte geaendert haben - das 3-Sekunden-Update
 * schliesst das Aufklappmenue also nicht und verliert keine Auswahl.
 */
function createMultiFilter(el, { allLabel, unitPlural, labelFor }, selected, onChange) {
  el.innerHTML = `<summary></summary><div class="mf-panel">
      <div class="mf-actions"><button type="button" class="secondary small" data-mf="all">alle</button>
      <button type="button" class="secondary small" data-mf="none">keine Einschränkung</button></div>
      <div class="mf-options"></div></div>`;
  const summary = el.querySelector("summary");
  const optionsEl = el.querySelector(".mf-options");
  let currentValues = [];

  const updateSummary = () => {
    if (selected.size === 0) summary.textContent = allLabel;
    else if (selected.size === 1) summary.textContent = labelFor([...selected][0]);
    else summary.textContent = `${selected.size} ${unitPlural}`;
    el.classList.toggle("active", selected.size > 0);
  };

  const render = () => {
    optionsEl.innerHTML = "";
    for (const v of currentValues) {
      const label = document.createElement("label");
      label.innerHTML = `<input type="checkbox" ${selected.has(v) ? "checked" : ""} /> <span></span>`;
      label.querySelector("span").textContent = labelFor(v);
      label.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) selected.add(v);
        else selected.delete(v);
        updateSummary();
        onChange();
      });
      optionsEl.appendChild(label);
    }
    updateSummary();
  };

  el.querySelector('[data-mf="all"]').addEventListener("click", () => {
    for (const v of currentValues) selected.add(v);
    render();
    onChange();
  });
  el.querySelector('[data-mf="none"]').addEventListener("click", () => {
    selected.clear();
    render();
    onChange();
  });
  // Klick ausserhalb schliesst das Aufklappmenue
  document.addEventListener("click", (e) => {
    if (el.open && !el.contains(e.target)) el.open = false;
  });

  return {
    setOptions(values) {
      const unique = [...new Set(values)].sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
      // Nicht mehr vorhandene Werte aus der Auswahl entfernen
      for (const v of [...selected]) if (!unique.includes(v)) selected.delete(v);
      if (unique.join("\u0001") !== currentValues.join("\u0001")) {
        currentValues = unique;
        render();
      } else {
        updateSummary();
      }
    },
  };
}

const categoryFilter = createMultiFilter(
  $("#sourceCategoryFilter"),
  { allLabel: "Alle Kategorien", unitPlural: "Kategorien", labelFor: (v) => v },
  sourceFilters.categories,
  () => renderSourceList()
);
const roomFilter = createMultiFilter(
  $("#sourceRoomFilter"),
  { allLabel: "Alle Räume", unitPlural: "Räume", labelFor: (v) => (v === NO_ROOM ? "(ohne Raum)" : v) },
  sourceFilters.rooms,
  () => renderSourceList()
);

/** Regel, deren Quellen gerade bearbeitet werden (null = Formular legt
 * eine neue Regel an). Siehe startEditSources/stopEditSources. */
let editingRule = null;

/** Zuletzt gerenderte (gefilterte) Quellen - fuer "alle sichtbaren
 * auswaehlen/abwaehlen". */
let visibleSourceKeys = [];

/** Deutsche Bezeichnungen fuer die bekannten Kanal-Typen. Fuer noch nicht
 * uebersetzte Typen wird der Rohname lesbar formatiert (siehe channelTypeLabel). */
const CHANNEL_TYPE_LABELS = {
  SWITCH_CHANNEL: "Schalter",
  SWITCH_MEASURING_CHANNEL: "Schalter (mit Messung)",
  EXTERNAL_SWITCH_CHANNEL: "Schalter (extern)",
  DIMMER_CHANNEL: "Dimmer/Lampe",
  EXTERNAL_UNIVERSAL_LIGHT_CHANNEL: "Dimmbare Lampe (extern)",
  NOTIFICATION_LIGHT_CHANNEL: "Signal-LED",
  OPTICAL_SIGNAL_CHANNEL: "LED-Signal (WRC6)",
  OPTICAL_SIGNAL_GROUP_CHANNEL: "LED-Signal (WRC6, Gruppe)",
  SHUTTER_CONTACT_CHANNEL: "Fenster-/Türkontakt",
  MAGNETIC_DOOR_SENSOR_CHANNEL: "Tür-/Torkontakt (magnetisch)",
  MULTI_MODE_INPUT_CHANNEL: "Taster-Eingang",
};

function channelTypeLabel(type) {
  if (CHANNEL_TYPE_LABELS[type]) return CHANNEL_TYPE_LABELS[type];
  if (!type) return "Unbekannt";
  return type.replace(/_CHANNEL$/, "").replace(/_/g, " ");
}

function colorLabelFor(value) {
  const match = COLOR_SWATCHES.find((c) => c.value === value);
  return match ? match.label : value || "–";
}

function channelKey(d) {
  return `${d.deviceId}::${d.channelIndex}`;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function refreshStatus() {
  try {
    const status = await fetchJSON("/api/status");
    if (status.version) $("#version").textContent = `v${status.version}`;
    const el = $("#status");
    if (status.connected && status.systemStateReady) {
      el.textContent = `Mit HCU verbunden · ${status.deviceCount} Geräte`;
      el.className = "status connected";
    } else {
      el.textContent = "Keine Verbindung zur HCU";
      el.className = "status disconnected";
    }
  } catch (err) {
    $("#status").textContent = "Plugin nicht erreichbar: " + err.message;
  }
}

/** Fuellt die Ziel-Kanal-Auswahl im "Neue Regel"-Formular - NUR mit den
 * Kanaelen des Geraets, das gerade links in Spalte 1 ausgewaehlt ist
 * (selectedWrcDeviceId, siehe renderWrcDeviceList). Bis v0.13.0 gab es hier
 * noch ein eigenes zweites Geraete-Dropdown, unabhaengig von Spalte 1 - das
 * fuehrte zu zwei getrennten Geraete-Auswahlen auf derselben Seite, was laut
 * Nutzer-Feedback verwirrend war. Seit v0.14.0 gibt es nur noch die eine
 * Auswahl in Spalte 1; hier wird das aktuell gewaehlte Geraet nur noch
 * angezeigt (targetDeviceLabel), nicht mehr eigenstaendig ausgewaehlt. */
function populateTargetChannelSelect(targetDevices) {
  const channelSelect = $("#targetChannelSelect");
  const previousChannelKey = channelSelect.value;

  const channelsOfDevice = selectedWrcDeviceId
    ? targetDevices.filter((d) => d.deviceId === selectedWrcDeviceId)
    : [];

  channelSelect.innerHTML = "";
  for (const d of channelsOfDevice) {
    const opt = document.createElement("option");
    opt.value = channelKey(d);
    opt.textContent = d.channelLabel || `LED ${d.channelIndex}`;
    channelSelect.appendChild(opt);
  }
  if (channelsOfDevice.some((d) => channelKey(d) === previousChannelKey)) {
    channelSelect.value = previousChannelKey;
  }

  const label = $("#targetDeviceLabel");
  if (label) {
    label.textContent = channelsOfDevice.length > 0 ? channelsOfDevice[0].deviceLabel : "–";
  }
}

function renderColorPicker(container, selectedColor, onSelect) {
  container.innerHTML = "";
  for (const c of COLOR_SWATCHES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "color-swatch" + (c.value === selectedColor ? " selected" : "");
    btn.style.background = c.hex;
    btn.title = c.label;
    btn.addEventListener("click", () => onSelect(c.value));
    container.appendChild(btn);
  }
}

/** key -> {row, nameEl, badgeEl} fuer bereits gebaute Zeilen, siehe
 * renderManualControls: Zeilen werden nur EINMAL gebaut und danach beim
 * Live-Update nur noch in-place aktualisiert (Name/Zustand), statt komplett
 * neu erzeugt. Wuerden Anwenden/Aus-Buttons bei jedem 3-Sekunden-Update neu
 * erzeugt, koennte ein Klick, der genau waehrend eines Updates passiert
 * (mousedown vor, mouseup nach dem Neuaufbau), vom Browser stillschweigend
 * verworfen werden - das passiert unabhaengig davon, ob der Klick-Listener
 * direkt am Button oder delegiert an einem Elternelement haengt, weil der
 * Browser gar kein "click"-Ereignis synthetisiert, wenn das urspruenglich
 * gedrueckte Element beim Loslassen nicht mehr existiert. Indem der Button
 * als DOM-Knoten ueber die Zeit hinweg derselbe bleibt, kann dieses Problem
 * gar nicht erst auftreten. */
const manualControlNodes = {};

/** Aktuell in Spalte 1 (wrc-layout) ausgewaehltes WRC6-230-Geraet - siehe
 * renderWrcDeviceList. null, solange kein WRC6-230 im System gefunden wurde. */
let selectedWrcDeviceId = null;

/** Baut die klickbare Geraeteliste in Spalte 1 des oberen Bereichs (ersetzt
 * das fruehere Dropdown-Filter) - ein Klick waehlt das Geraet, dessen Kanaele
 * dann allein in Spalte 2 (renderManualControls) erscheinen. Waehlt beim
 * ersten Laden automatisch das erste (alphabetisch sortierte) Geraet aus,
 * damit Spalte 2 sofort etwas zeigt, statt leer zu bleiben, bis geklickt
 * wird (so bestaetigt). Spalte 1 ist bewusst als eigene Karte
 * angelegt, damit hier spaeter weitere geraetebezogene Aktionen Platz haben
 * (siehe #wrcDeviceActions in index.html). */
function renderWrcDeviceList(targetDevices) {
  const container = $("#wrcDeviceList");
  const devicesById = new Map();
  for (const d of targetDevices) {
    if (!devicesById.has(d.deviceId)) {
      devicesById.set(d.deviceId, { deviceId: d.deviceId, deviceLabel: d.deviceLabel, count: 0 });
    }
    // Gruppenkanal 15 ("alle LEDs") nicht als eigene LED zaehlen
    if (d.channelType !== "OPTICAL_SIGNAL_GROUP_CHANNEL") devicesById.get(d.deviceId).count++;
  }
  const sorted = [...devicesById.values()].sort((a, b) => a.deviceLabel.localeCompare(b.deviceLabel));

  $("#wrcDeviceListEmpty").style.display = sorted.length ? "none" : "block";

  if (sorted.length === 0) {
    selectedWrcDeviceId = null;
    container.innerHTML = "";
    return;
  }
  if (!selectedWrcDeviceId || !devicesById.has(selectedWrcDeviceId)) {
    selectedWrcDeviceId = sorted[0].deviceId;
  }

  container.innerHTML = "";
  for (const d of sorted) {
    const row = document.createElement("div");
    row.className = "wrc-device-row" + (d.deviceId === selectedWrcDeviceId ? " selected" : "");
    row.innerHTML = `
      <span class="wrc-device-name">${escapeHtml(d.deviceLabel)}</span>
      <span class="wrc-device-count">${d.count} LED${d.count === 1 ? "" : "s"}</span>
    `;
    row.addEventListener("click", () => {
      if (selectedWrcDeviceId === d.deviceId) return;
      selectedWrcDeviceId = d.deviceId;
      renderManualControls();
      renderLedMap();
      // Ziel-Auswahl im "Neue Regel"-Formular folgt der Geraete-Auswahl hier
      // links (siehe populateTargetChannelSelect) - inkl. Aktualisierung der
      // Ziel-Zustand-Anzeige (Farbe/Helligkeit/Signalverhalten) fuer den dann
      // automatisch gewaehlten ersten Kanal des neuen Geraets.
      const allTargetDevices = devicesCache.filter((dev) => dev.isTargetCandidate);
      populateTargetChannelSelect(allTargetDevices);
      updateRuleTargetStateVisibility();
    });
    container.appendChild(row);
  }
}

function renderManualControls() {
  const allTargetDevices = devicesCache.filter((d) => d.isTargetCandidate);
  renderWrcDeviceList(allTargetDevices);

  const targetDevices = selectedWrcDeviceId ? allTargetDevices.filter((d) => d.deviceId === selectedWrcDeviceId) : [];

  const container = $("#manualControls");
  $("#manualEmpty").style.display = targetDevices.length ? "none" : "block";
  $("#manualControlsHeading").textContent = targetDevices.length
    ? `LEDs direkt schalten – ${targetDevices[0].deviceLabel}`
    : "LEDs direkt schalten (zum Ausprobieren)";

  const currentKeys = new Set(targetDevices.map(channelKey));
  for (const key of Object.keys(manualControlNodes)) {
    if (!currentKeys.has(key)) {
      manualControlNodes[key].row.remove();
      delete manualControlNodes[key];
    }
  }

  for (const d of targetDevices) {
    const key = channelKey(d);
    if (!manualState[key]) {
      manualState[key] = {
        dimLevelPercent: Math.round((d.currentDimLevel ?? 1) * 100),
        color: d.currentColor || "WHITE",
        behaviour: "",
        rampTime: "",
      };
    }
    const state = manualState[key];

    if (!manualControlNodes[key]) {
      // Zeile in zwei Zeilen aufgeteilt: oben Name+Zustand (kann bei langen
      // Geraetenamen umbrechen), darunter Slider/Farbwahl/Buttons IMMER in
      // einer eigenen, nicht umbrechenden Reihe - so bleiben "Anwenden" und
      // "Aus" unabhaengig von der Namenslaenge nebeneinander erreichbar.
      const row = document.createElement("div");
      row.className = "manual-control-row";

      const header = document.createElement("div");
      header.className = "mc-header";
      const nameEl = document.createElement("span");
      nameEl.className = "name";
      const badgeEl = document.createElement("span");
      badgeEl.className = "badge";
      // Zeigt den tatsaechlich aktiven Zustand des Geraets (live, aus dem
      // Polling) - unabhaengig davon, was gerade im Slider/Farbwaehler als
      // Entwurf eingestellt ist. Ohne das war nicht erkennbar, ob eine
      // ausgewaehlte Farbe schon aktiv ist oder nur ausprobiert wird, ohne
      // dass "Anwenden" gedrueckt wurde.
      const currentEl = document.createElement("span");
      currentEl.className = "current-state";
      // Nur sichtbar, wenn das echte Geraet einen Signaleffekt meldet
      // (siehe currentOpticalSignalBehaviour in webServer.js).
      const behaviourEl = document.createElement("span");
      behaviourEl.className = "current-behaviour";
      behaviourEl.style.display = "none";
      header.appendChild(nameEl);
      header.appendChild(badgeEl);
      header.appendChild(currentEl);
      header.appendChild(behaviourEl);
      row.appendChild(header);

      const controls = document.createElement("div");
      controls.className = "mc-controls";

      const sliderCol = document.createElement("div");
      sliderCol.className = "slider-col";
      const sliderLabel = document.createElement("span");
      sliderLabel.textContent = `${state.dimLevelPercent}%`;
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "0";
      slider.max = "100";
      slider.value = String(state.dimLevelPercent);
      slider.addEventListener("input", () => {
        state.dimLevelPercent = Number(slider.value);
        sliderLabel.textContent = `${state.dimLevelPercent}%`;
      });
      sliderCol.appendChild(slider);
      sliderCol.appendChild(sliderLabel);
      controls.appendChild(sliderCol);

      // Einblendzeit (rampTime, Sekunden, optional) - siehe
      // rules.js/_validateRampTime: nutzt sie den "...WithTime"-Endpunkt,
      // der laut Doku immer einen Auto-Aus-Timer (onTime) mitbringt. Ohne
      // Eingabe (leer) bleibt alles beim bisherigen, unbefristeten Verhalten.
      const rampCol = document.createElement("div");
      rampCol.className = "ramp-col";
      const rampInput = document.createElement("input");
      rampInput.type = "number";
      rampInput.min = "0.1";
      rampInput.max = "16383";
      rampInput.step = "0.1";
      rampInput.placeholder = "Sek.";
      rampInput.title =
        "Einblendzeit in Sekunden (optional). Hinweis: Die HCU kennt dafür nur einen Befehl mit eingebautem Ausschalt-Timer – die LED geht dann spätestens nach ca. 4,5 Stunden von selbst aus.";
      rampInput.addEventListener("input", () => {
        state.rampTime = rampInput.value;
      });
      const rampLabel = document.createElement("span");
      rampLabel.textContent = "Einblendzeit";
      rampCol.appendChild(rampLabel);
      rampCol.appendChild(rampInput);
      controls.appendChild(rampCol);

      if (d.supportsColor) {
        const colorContainer = document.createElement("div");
        colorContainer.className = "color-picker";
        const redraw = (color) => {
          state.color = color;
          renderColorPicker(colorContainer, state.color, redraw);
        };
        renderColorPicker(colorContainer, state.color, redraw);
        controls.appendChild(colorContainer);

        // Signalverhalten (Blinken/Blitzen/Wallend) - nutzt den Connect-API-
        // Endpunkt setOpticalSignal statt setSimpleRGBColorDimLevel, siehe
        // rules.js/buildManualControlRequest. Nur fuer farbfaehige Kanaele
        // sinnvoll, daher im selben if(d.supportsColor)-Zweig.
        const behaviourSelect = document.createElement("select");
        behaviourSelect.className = "behaviour-select";
        behaviourSelect.title = "Leuchtart";
        for (const opt of SIGNAL_BEHAVIOUR_OPTIONS) {
          const optionEl = document.createElement("option");
          optionEl.value = opt.value;
          optionEl.textContent = opt.label;
          behaviourSelect.appendChild(optionEl);
        }
        behaviourSelect.value = state.behaviour;
        behaviourSelect.addEventListener("change", () => {
          state.behaviour = behaviourSelect.value;
        });
        controls.appendChild(behaviourSelect);
      }

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.textContent = "Anwenden";
      applyBtn.dataset.action = "apply";
      applyBtn.dataset.key = key;
      controls.appendChild(applyBtn);

      const offBtn = document.createElement("button");
      offBtn.type = "button";
      offBtn.className = "secondary";
      offBtn.textContent = "Aus";
      offBtn.dataset.action = "off";
      offBtn.dataset.key = key;
      controls.appendChild(offBtn);

      row.appendChild(controls);
      container.appendChild(row);

      manualControlNodes[key] = { row, nameEl, badgeEl, currentEl, behaviourEl };
    }

    // Nur die sich laufend aendernden Teile (Name/Zustands-Badge/tatsaechlicher
    // Zustand) aktualisieren - Slider, Farbwahl und Buttons bleiben als
    // DOM-Knoten unangetastet.
    const nodes = manualControlNodes[key];
    nodes.nameEl.textContent = d.channelLabel || `LED ${d.channelIndex}`;
    nodes.badgeEl.textContent = d.stateLabel || "?";
    nodes.badgeEl.className = `badge ${d.stateLabel === "AN" ? "on" : "off"}`;

    if (d.controlType === "RGB_DIM") {
      const pct = Math.round((d.currentDimLevel ?? 0) * 100);
      const swatch = COLOR_SWATCHES.find((c) => c.value === d.currentColor);
      nodes.currentEl.textContent = `${pct}%`;
      nodes.currentEl.style.background = swatch ? swatch.hex : "";
      nodes.currentEl.style.color = swatch ? swatch.text : "";
      nodes.currentEl.style.borderColor = swatch && swatch.value === "WHITE" ? "var(--border)" : "transparent";
      nodes.currentEl.title = `Aktuell: ${pct}% · ${colorLabelFor(d.currentColor)}`;
      // Signaleffekt (Blinken/Blitzen/Wallend) nur anzeigen, wenn das echte
      // Geraet ihn tatsaechlich meldet (siehe webServer.js) - sonst bleibt
      // dieser zusaetzliche Hinweis schlicht weg.
      const behaviourLabel = behaviourLabelFor(d.currentOpticalSignalBehaviour);
      nodes.behaviourEl.textContent = behaviourLabel ? behaviourLabel : "";
      nodes.behaviourEl.style.display = behaviourLabel ? "inline" : "none";
    } else if (d.controlType === "DIM") {
      const pct = Math.round((d.currentDimLevel ?? 0) * 100);
      nodes.currentEl.textContent = `${pct}%`;
      nodes.currentEl.style.background = "";
      nodes.currentEl.style.color = "";
      nodes.currentEl.style.borderColor = "transparent";
      nodes.currentEl.title = `Aktuell: ${pct}%`;
      nodes.behaviourEl.style.display = "none";
    } else {
      nodes.currentEl.textContent = "";
      nodes.currentEl.style.background = "";
      nodes.currentEl.title = "";
      nodes.behaviourEl.style.display = "none";
    }
  }
}

/** Sendet den Steuerbefehl und gibt an der Schaltflaeche selbst sofort
 * sichtbare Rueckmeldung (unabhaengig davon, wie lange die HCU fuer die
 * Antwort braucht) - vorher gab es bei Erfolg gar keine optische Reaktion,
 * nur die stille Badge-Aktualisierung beim naechsten 3-Sekunden-Update. */
async function applyManualControl(device, state, btn) {
  const originalText = btn ? btn.textContent : null;
  if (btn) {
    btn.disabled = true;
    btn.classList.add("pending");
    btn.textContent = "…";
  }
  try {
    await fetchJSON("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: device.deviceId,
        channelIndex: device.channelIndex,
        dimLevel: state.dimLevelPercent / 100,
        color: device.supportsColor ? state.color : undefined,
        behaviour: device.supportsColor ? state.behaviour || undefined : undefined,
        rampTime: state.rampTime !== "" && state.rampTime !== undefined ? Number(state.rampTime) : undefined,
      }),
    });
    if (btn) {
      btn.classList.remove("pending");
      btn.classList.add("success");
      btn.textContent = "✓ Gesendet";
      setTimeout(() => {
        btn.classList.remove("success");
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1000);
    }
  } catch (err) {
    if (btn) {
      btn.classList.remove("pending");
      btn.textContent = originalText;
      btn.disabled = false;
    }
    alert("Fehler: " + err.message);
  }
}

/** Fuellt ein Filter-<select> mit den in "values" vorkommenden eindeutigen
 * Werten (sortiert), behaelt die bisherige Auswahl, falls sie noch existiert. */
function populateFilterSelect(select, values, labelFn, placeholderText) {
  const previousValue = select.value;
  const unique = [...new Set(values)].filter((v) => v).sort((a, b) => labelFn(a).localeCompare(labelFn(b)));
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = placeholderText;
  select.appendChild(placeholder);
  for (const v of unique) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = labelFn(v);
    select.appendChild(opt);
  }
  if (unique.includes(previousValue)) select.value = previousValue;
}

/** Rendert die filterbare Mehrfachauswahl-Liste der Ausloeser (Kanal +
 * Bedingung, siehe /api/sources) unter Beruecksichtigung der Filter
 * (sourceFilters) und der Auswahl (selectedSourceKeys). Schwellwert-
 * Bedingungen bekommen Vergleich (> / <) und Grenzwert (sourceParams). */
function renderSourceList() {
  const needle = sourceFilters.search.trim().toLowerCase();
  const filtered = sourcesCache.filter((d) => {
    if (sourceFilters.categories.size && !sourceFilters.categories.has(d.category)) return false;
    if (sourceFilters.rooms.size && !sourceFilters.rooms.has(d.roomLabel || NO_ROOM)) return false;
    if (sourceFilters.onlySelected && !selectedSourceKeys.has(d.key)) return false;
    if (needle) {
      const hay = [d.deviceLabel, d.channelLabel, d.roomLabel, d.category, d.conditionLabel, channelTypeLabel(d.channelType), d.modelType]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  visibleSourceKeys = filtered.map((d) => d.key);
  updateSourceCount();

  const container = $("#sourceList");
  container.innerHTML = "";
  $("#sourceHint").textContent = filtered.length === 0 ? "Keine Auslöser für diesen Filter gefunden." : "";

  for (const d of filtered) {
    const key = d.key;
    const row = document.createElement("div");
    row.className = "source-row";
    const badgeClass = d.numeric ? "value" : d.currentValue === true ? "on" : "off";
    const params = sourceParams[key] || (sourceParams[key] = { op: ">", threshold: "" });
    const numericHtml = d.numeric
      ? `<span class="threshold">
          <select data-role="op" title="Vergleich">
            <option value=">" ${params.op === ">" ? "selected" : ""}>&gt;</option>
            <option value="<" ${params.op === "<" ? "selected" : ""}>&lt;</option>
          </select>
          <input type="number" step="any" data-role="threshold" placeholder="Wert" value="${escapeHtml(params.threshold)}" />
          <span class="muted">${escapeHtml(d.unit || "")}</span>
        </span>`
      : "";
    row.innerHTML = `
      <label>
        <input type="checkbox" data-key="${escapeHtml(key)}" ${selectedSourceKeys.has(key) ? "checked" : ""} />
        ${escapeHtml(sourceName(d))}:
        <strong>${escapeHtml(d.conditionLabel)}</strong>
        <span class="muted">${escapeHtml(d.category)}${d.roomLabel ? " · " + escapeHtml(d.roomLabel) : ""}</span>
      </label>
      ${numericHtml}
      <span class="badge ${badgeClass}">${escapeHtml(d.stateLabel || "?")}</span>
    `;
    row.querySelector('input[type="checkbox"]').addEventListener("change", (e) => {
      if (e.target.checked) selectedSourceKeys.add(key);
      else selectedSourceKeys.delete(key);
      updateSourceCount();
    });
    if (d.numeric) {
      row.querySelector('[data-role="op"]').addEventListener("change", (e) => {
        params.op = e.target.value;
      });
      row.querySelector('[data-role="threshold"]').addEventListener("input", (e) => {
        params.threshold = e.target.value;
        // Grenzwert eingegeben -> Quelle automatisch mit auswaehlen
        if (e.target.value !== "" && !selectedSourceKeys.has(key)) {
          selectedSourceKeys.add(key);
          row.querySelector('input[type="checkbox"]').checked = true;
          updateSourceCount();
        }
      });
    }
    container.appendChild(row);
  }
}

/**
 * Anzeigename eines Ausloesers: Geraet (+ Kanalname). Die Kanalnummer wird
 * nur angehaengt, wenn das Geraet mehrere gleichartige Kanaele ohne eigenen
 * Namen hat (z. B. 6-fach-Eingang) - sonst ist sie fuer Aussenstehende nur
 * Rauschen. Grundlage: sourcesCache (siehe /api/sources).
 */
function sourceName(s) {
  if (s.channelLabel) return `${s.deviceLabel} – ${s.channelLabel}`;
  const cond = s.condition || s.effectiveCondition;
  const siblings = sourcesCache.filter((o) => o.deviceId === s.deviceId && o.condition === cond && !o.channelLabel);
  return siblings.length > 1 ? `${s.deviceLabel} (Kanal ${s.channelIndex})` : s.deviceLabel;
}

/**
 * Lage der sechs LEDs am HmIP-WRC6-230 (Spalte 0 = links, 1 = rechts;
 * Reihe 0 = oben). Kanalnummern wie in der Connect API (9-14; 15 = alle
 * LEDs gemeinsam). Zuordnung bestaetigt durch die Kanalgrafik der
 * Homematic IP App (Screenshot der App-Zuordnung).
 */
const LED_POSITIONS = {
  9: { col: 0, row: 0, text: "oben links" },
  10: { col: 1, row: 0, text: "oben rechts" },
  11: { col: 0, row: 1, text: "Mitte links" },
  12: { col: 1, row: 1, text: "Mitte rechts" },
  13: { col: 0, row: 2, text: "unten links" },
  14: { col: 1, row: 2, text: "unten rechts" },
};

/** Animation je Leuchtart (CSS-Klassen in style.css). Die echten Takte
 * des Geraets sind nicht dokumentiert - die Darstellung ist angenaehert. */
const LED_ANIMATION = { BLINKING_MIDDLE: "led-blink", FLASH_MIDDLE: "led-flash", BILLOW_MIDDLE: "led-billow" };

/** LED leuchtet? Helligkeit > 0 und - falls gemeldet - Leuchtart nicht
 * "OFF" (bei OFF bleibt die LED trotz Helligkeit dunkel, siehe v0.19.0). */
function ledIsOn(d) {
  if (!d || !((d.currentDimLevel ?? 0) > 0) || d.isOn === false) return false;
  return d.currentOpticalSignalBehaviour !== "OFF";
}

/** Eigene, schematische Zeichnung des Wandtasters mit Live-Zustand der LEDs. */
function renderLedMap() {
  const container = $("#ledMap");
  const leds = devicesCache.filter((d) => d.deviceId === selectedWrcDeviceId && LED_POSITIONS[d.channelIndex]);
  const deviceLabel = leds.length ? leds[0].deviceLabel : "";
  $("#ledMapDevice").textContent = deviceLabel || "Kein Wandtaster ausgewählt";
  if (!leds.length) {
    container.innerHTML = "";
    return;
  }
  const byIndex = new Map(leds.map((d) => [d.channelIndex, d]));
  const keyW = 78, keyH = 54, gap = 4, x0 = 24, y0 = 24;
  let keys = "";
  for (const [idx, pos] of Object.entries(LED_POSITIONS)) {
    const d = byIndex.get(Number(idx));
    const x = x0 + pos.col * (keyW + gap);
    const y = y0 + pos.row * (keyH + gap);
    const on = ledIsOn(d);
    const sw = d && COLOR_SWATCHES.find((c) => c.value === d.currentColor);
    const anim = on ? LED_ANIMATION[d.currentOpticalSignalBehaviour] || "" : "";
    // An, aber ohne Farbangabe (reine Helligkeits-LED): warmweiss darstellen
    const color = on ? (sw ? (sw.value === "BLACK" ? "#c3c9d4" : sw.hex) : "#ffd966") : "#c3c9d4";
    // LED sitzt an der Innenkante der Taste (zur Mitte hin)
    const cx = pos.col === 0 ? x + keyW - 14 : x + 14;
    const cy = y + keyH / 2;
    keys += `<rect x="${x}" y="${y}" width="${keyW}" height="${keyH}" rx="10" fill="#fbfcfe" stroke="#c9d0db"/>`;
    keys += `<g class="${anim}">`;
    if (on) keys += `<circle cx="${cx}" cy="${cy}" r="10" fill="${color}" opacity="0.35"/>`;
    keys += `<circle cx="${cx}" cy="${cy}" r="6" fill="${color}" stroke="${on ? "none" : "#aab2bf"}"/></g>`;
    const tx = pos.col === 0 ? x + 16 : x + keyW - 16;
    keys += `<text x="${tx}" y="${cy + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="#1d3f6e">${idx}</text>`;
  }
  const w = x0 * 2 + keyW * 2 + gap, h = y0 * 2 + keyH * 3 + gap * 2;
  const svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Schema des Wandtasters mit LED-Nummern">
    <rect x="4" y="4" width="${w - 8}" height="${h - 8}" rx="22" fill="#ffffff" stroke="#c9d0db" stroke-width="2"/>
    <rect x="${x0 - 4}" y="${y0 - 4}" width="${keyW * 2 + gap + 8}" height="${keyH * 3 + gap * 2 + 8}" rx="13" fill="#e1e6ee"/>
    ${keys}</svg>`;
  const legend = Object.entries(LED_POSITIONS)
    .map(([idx, pos]) => {
      const d = byIndex.get(Number(idx));
      const on = ledIsOn(d);
      const pct = d ? Math.round((d.currentDimLevel ?? 0) * 100) : 0;
      const effect = on ? behaviourLabelFor(d.currentOpticalSignalBehaviour) : null;
      const state = d
        ? on
          ? `${pct} %${d.currentColor ? " · " + colorLabelFor(d.currentColor) : ""}${effect ? " · " + effect : ""}`
          : "aus"
        : "nicht vorhanden";
      return `<li><span class="num">${idx}</span><span class="txt"><span class="pos">${pos.text}</span> <span class="state ${on ? "on" : ""}">${escapeHtml(state)}</span>
        ${d && d.channelLabel ? `<span class="name">${escapeHtml(d.channelLabel)}</span>` : ""}</span></li>`;
    })
    .join("");
  const html = `${svg}<ul class="led-legend">${legend}</ul>
    <p class="muted" style="margin:0;font-size:0.8rem;">Kanal 15 steuert alle LEDs gemeinsam. Die Nummern entsprechen denen in der Homematic IP App (Gerät → Zuordnung).</p>`;
  // Nur bei Aenderung neu zeichnen - sonst wuerden Blink-/Wall-Animationen
  // bei jeder 3-Sekunden-Aktualisierung neu starten und ruckeln.
  if (container.dataset.html !== html) {
    container.innerHTML = html;
    container.dataset.html = html;
  }
}

function updateSourceCount() {
  $("#sourceCount").textContent = `${selectedSourceKeys.size} ausgewählt · ${visibleSourceKeys.length} angezeigt`;
}

/** Baut aus der Auswahl die Quellen fuer POST/PATCH /api/rules. Wirft bei
 * Schwellwert-Quellen ohne Grenzwert. */
function buildSelectedSources() {
  return [...selectedSourceKeys].map((key) => {
    const [deviceId, channelIndex, condition] = key.split("::");
    const option = sourcesCache.find((d) => d.key === key);
    const source = { deviceId, channelIndex: Number(channelIndex), condition };
    if (option && option.numeric) {
      const p = sourceParams[key] || {};
      if (p.threshold === "" || p.threshold === undefined || !Number.isFinite(Number(p.threshold))) {
        throw new Error(`Bitte einen Grenzwert für „${option.deviceLabel}: ${option.conditionLabel}“ eingeben.`);
      }
      source.op = p.op || ">";
      source.threshold = Number(p.threshold);
    }
    return source;
  });
}

async function refreshDevices() {
  const [devices, sources] = await Promise.all([fetchJSON("/api/devices"), fetchJSON("/api/sources")]);
  devicesCache = devices;
  sourcesCache = sources;

  // Quelle (Ausloeser): alle Kanaele mit einem erkannten Zustand - Schalter,
  // Lampen, Fensterkontakte usw. - per Kanal-Typ und Raum filterbar,
  // Mehrfachauswahl moeglich (siehe renderSourceList).
  // Ziel: ausschliesslich Kanaele des WRC6-230 (isTargetCandidate, siehe
  // Backend) - dieses Plugin steuert bewusst nur dieses eine Geraetemodell.
  const targetDevices = devices.filter((d) => d.isTargetCandidate);

  // Ausgewaehlte Quellen bereinigen, falls das Geraet inzwischen verschwunden ist.
  const currentKeys = new Set(sources.map((d) => d.key));
  for (const key of [...selectedSourceKeys]) {
    if (!currentKeys.has(key)) selectedSourceKeys.delete(key);
  }

  categoryFilter.setOptions(sources.map((d) => d.category));
  roomFilter.setOptions(sources.map((d) => d.roomLabel || NO_ROOM));
  // Nicht neu aufbauen, waehrend in der Liste getippt wird (Grenzwert) -
  // sonst ginge bei jedem 3-Sekunden-Update der Fokus verloren.
  if (!$("#sourceList").contains(document.activeElement)) renderSourceList();

  // renderManualControls() zuerst: setzt/aktualisiert selectedWrcDeviceId
  // (Geraete-Auswahl in Spalte 1, inkl. automatischer Auswahl des ersten
  // Geraets beim allerersten Laden) - populateTargetChannelSelect braucht
  // das bereits gesetzte selectedWrcDeviceId, um die Ziel-Auswahl im
  // "Neue Regel"-Formular korrekt zu befuellen.
  renderManualControls();
  renderLedMap();
  populateTargetChannelSelect(targetDevices);

  if (targetDevices.length === 0) {
    $("#targetHint").textContent = "Kein Wandtaster HmIP-WRC6-230 gefunden.";
  } else {
    $("#targetHint").textContent = "";
  }

  updateRuleTargetStateVisibility();

  const tbody = $("#devicesTable tbody");
  tbody.innerHTML = "";
  for (const d of devices) {
    const tr = document.createElement("tr");
    const badgeClass = d.stateLabel === "AN" || d.stateLabel === "OFFEN" ? "on" : "off";
    tr.innerHTML = `
      <td>${escapeHtml(d.deviceLabel)}${d.modelType ? ` <span class="muted">(${escapeHtml(d.modelType)})</span>` : ""}</td>
      <td>${d.channelIndex}${d.channelLabel ? " – " + escapeHtml(d.channelLabel) : ""}</td>
      <td>${escapeHtml(channelTypeLabel(d.channelType))}${d.roomLabel ? ` <span class="muted">· ${escapeHtml(d.roomLabel)}</span>` : ""}</td>
      <td><span class="badge ${badgeClass}">${escapeHtml(d.stateLabel || "?")}</span></td>
    `;
    tbody.appendChild(tr);
  }
}

function findDeviceByKey(key) {
  return devicesCache.find((d) => channelKey(d) === key);
}

function updateRuleTargetStateVisibility() {
  const targetKey = $("#targetChannelSelect").value;
  const target = targetKey ? findDeviceByKey(targetKey) : null;
  const section = $("#ruleTargetState");
  const colorPicker = $("#onColorPicker");
  const behaviourRow = $("#onBehaviourRow");
  const behaviourSelect = $("#onBehaviourSelect");

  // Im Modus "Auslöser bearbeiten" bleibt der Ziel-Zustand ausgeblendet -
  // sonst wuerde ihn das 3-Sekunden-Update wieder einblenden.
  if (editingRule || !target || target.controlType === "SWITCH") {
    section.style.display = "none";
    return;
  }
  section.style.display = "flex";
  $("#onDimLevelInput").value = String(newRuleTargetState.dimLevelPercent);
  $("#onDimLevelValue").textContent = `${newRuleTargetState.dimLevelPercent}%`;

  if (target.supportsColor) {
    colorPicker.style.display = "flex";
    const redraw = (color) => {
      newRuleTargetState.color = color;
      renderColorPicker(colorPicker, newRuleTargetState.color, redraw);
    };
    renderColorPicker(colorPicker, newRuleTargetState.color, redraw);

    behaviourRow.style.display = "block";
    if (!behaviourSelect.dataset.populated) {
      for (const opt of SIGNAL_BEHAVIOUR_OPTIONS) {
        const optionEl = document.createElement("option");
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        behaviourSelect.appendChild(optionEl);
      }
      behaviourSelect.dataset.populated = "1";
      behaviourSelect.addEventListener("change", () => {
        newRuleTargetState.behaviour = behaviourSelect.value;
      });
    }
    behaviourSelect.value = newRuleTargetState.behaviour;
  } else {
    colorPicker.style.display = "none";
    behaviourRow.style.display = "none";
  }
}

/**
 * Baut die "Status"-Zelle einer Regelzeile - siehe RuleEngine.getRulesWithStatus:
 * "matches" = trifft die Regel fuer sich genommen gerade zu, "active" = ist
 * es tatsaechlich diese Regel, die das Ziel gerade steuert (kann bei
 * mehreren Regeln fuer dasselbe Ziel auseinanderfallen, siehe Rang-Spalte).
 */
function ruleStatusHtml(r) {
  if (!r.enabled) return `<span class="muted">ausgeschaltet</span>`;
  if (r.matches === null) return `<span class="muted">?</span>`;
  if (r.active) return `<span class="badge on" title="Diese Regel steuert das Ziel gerade tatsächlich.">steuert die LED</span>`;
  if (r.matches) {
    return `<span class="badge overridden" title="Bedingung erfüllt, aber eine höher priorisierte Regel für dasselbe Ziel gewinnt gerade.">andere Regel hat Vorrang</span>`;
  }
  return `<span class="muted">–</span>`;
}

async function refreshRules() {
  const rules = await fetchJSON("/api/rules");
  const tbody = $("#rulesTable tbody");
  tbody.innerHTML = "";
  $("#rulesEmpty").style.display = rules.length ? "none" : "block";

  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    const tr = document.createElement("tr");
    const joiner = r.sourceLogic === "AND" ? " UND " : " ODER ";
    const sourceText = r.sources
      .map((s) => `${sourceName(s)}${s.conditionText ? ": " + s.conditionText : ""}`)
      .join(joiner);
    const targetText = `${r.target.deviceLabel} – ${r.target.channelLabel || "LED " + r.target.channelIndex}`;

    let targetStateText = "an";
    if (r.target.controlType === "RGB_DIM") {
      const pct = Math.round((r.target.onDimLevel ?? 1) * 100);
      const colorInfo = COLOR_SWATCHES.find((c) => c.value === r.target.onColor);
      const behaviourLabel = r.target.onBehaviour ? SIGNAL_BEHAVIOUR_OPTIONS.find((b) => b.value === r.target.onBehaviour)?.label : null;
      targetStateText = `${pct}% · ${colorInfo ? colorInfo.label : r.target.onColor}${behaviourLabel ? " · " + behaviourLabel : ""}`;
    } else if (r.target.controlType === "DIM") {
      targetStateText = "100%";
    }

    // Pfeile verschieben die Regel global eine Position nach oben/unten
    // (siehe moveRule/RuleEngine.moveRule) - bei mehreren, nicht
    // benachbarten Regeln fuer dasselbe Ziel kann das mehr als ein Klick
    // brauchen, bis sich die Reihenfolge INNERHALB dieser Ziel-Gruppe
    // aendert; die Zeile bewegt sich aber bei jedem Klick sichtbar.
    tr.innerHTML = `
      <td class="rank-cell">
        <button type="button" class="rank-btn" data-action="up" ${i === 0 ? "disabled" : ""} title="Priorität erhöhen (nach oben)">▲</button>
        <button type="button" class="rank-btn" data-action="down" ${i === rules.length - 1 ? "disabled" : ""} title="Priorität verringern (nach unten)">▼</button>
      </td>
      <td>${escapeHtml(sourceText)}</td>
      <td>${escapeHtml(targetText)}</td>
      <td>${escapeHtml(targetStateText)}</td>
      <td><input type="checkbox" data-action="invert" ${r.invert ? "checked" : ""} /></td>
      <td><input type="checkbox" data-action="enabled" ${r.enabled ? "checked" : ""} /></td>
      <td>${ruleStatusHtml(r)}</td>
      <td class="rule-actions">
        <button type="button" class="secondary" data-action="edit-sources">Auslöser bearbeiten</button>
        <button class="danger" data-action="delete">Löschen</button>
      </td>
    `;
    tr.querySelector('[data-action="edit-sources"]').addEventListener("click", () => startEditSources(r));
    tr.querySelector('[data-action="invert"]').addEventListener("change", (e) => updateRule(r.id, { invert: e.target.checked }));
    tr.querySelector('[data-action="enabled"]').addEventListener("change", (e) => updateRule(r.id, { enabled: e.target.checked }));
    tr.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRule(r.id));
    tr.querySelector('[data-action="up"]').addEventListener("click", () => moveRule(r.id, "up"));
    tr.querySelector('[data-action="down"]').addEventListener("click", () => moveRule(r.id, "down"));
    tbody.appendChild(tr);
  }
}

async function refreshLog() {
  const entries = await fetchJSON("/api/log");
  const container = $("#log");
  container.innerHTML = "";
  $("#logEmpty").style.display = entries.length ? "none" : "block";
  for (const entry of entries.slice(0, 30)) {
    const div = document.createElement("div");
    div.className = "log-entry";
    const time = new Date(entry.ts).toLocaleTimeString("de-DE");
    const resultBadge = entry.result === "OK" ? `<span class="badge ok">OK</span>` : `<span class="badge err">${escapeHtml(entry.result)}</span>`;
    div.innerHTML = `<span class="ts">${time}</span>${escapeHtml(entry.rule)} &rarr; <strong>${entry.action}</strong> ${resultBadge}`;
    container.appendChild(div);
  }
}

async function updateRule(id, patch) {
  try {
    await fetchJSON(`/api/rules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refreshRules();
  } catch (err) {
    alert("Fehler: " + err.message);
  }
}

$("#importRulesBtn").addEventListener("click", () => $("#importRulesFile").click());
$("#importRulesFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    alert("Die Datei ist keine gültige Regel-Sicherung (kein JSON).");
    return;
  }
  const count = Array.isArray(data) ? data.length : data && Array.isArray(data.rules) ? data.rules.length : 0;
  if (!count) {
    alert("In der Datei wurden keine Regeln gefunden.");
    return;
  }
  if (!confirm(`${count} Regel(n) aus „${file.name}“ laden? Sie werden zu den vorhandenen Regeln hinzugefügt.`)) return;
  try {
    const result = await fetchJSON("/api/rules/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    let msg = `${result.imported} Regel(n) geladen.`;
    if (result.skipped.length) {
      msg += `\n\n${result.skipped.length} übersprungen:\n` + result.skipped.map((s) => `• Regel ${s.index}: ${s.reason}`).join("\n");
    }
    alert(msg);
    await refreshRules();
  } catch (err) {
    alert("Fehler: " + err.message);
  }
});

async function deleteRule(id) {
  if (!confirm("Diese Regel wirklich löschen?")) return;
  try {
    await fetchJSON(`/api/rules/${id}`, { method: "DELETE" });
    await refreshRules();
  } catch (err) {
    alert("Fehler: " + err.message);
  }
}

/** Verschiebt die Priorität einer Regel (siehe RuleEngine.moveRule) - wirkt
 * sich nur dann sichtbar auf das tatsächliche Ziel aus, wenn mehrere Regeln
 * dasselbe Ziel haben und dadurch ein anderer Gewinner ermittelt wird. */
async function moveRule(id, direction) {
  try {
    await fetchJSON(`/api/rules/${id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    });
    await refreshRules();
  } catch (err) {
    alert("Fehler: " + err.message);
  }
}

function parseKey(key) {
  const [deviceId, channelIndex] = key.split("::");
  return { deviceId, channelIndex: Number(channelIndex) };
}

$("#targetChannelSelect").addEventListener("change", updateRuleTargetStateVisibility);

// Delegierter Klick-Handler fuer Anwenden/Aus, am stabilen Container statt an
// den Buttons selbst (siehe renderManualControls: die Zeilen werden seit v0.5.0
// nicht mehr bei jedem Live-Update neu aufgebaut, sondern nur noch inhaltlich
// aktualisiert - Delegation bleibt trotzdem die robustere Wahl).
$("#manualControls").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const key = btn.dataset.key;
  const d = findDeviceByKey(key);
  const state = manualState[key];
  console.log("[WRC6] Klick registriert:", btn.dataset.action, key, d ? d.deviceLabel : "(Gerät nicht mehr gefunden)");
  if (!d || !state) return;
  if (btn.dataset.action === "apply") {
    applyManualControl(d, state, btn);
  } else if (btn.dataset.action === "off") {
    // "Aus" bedeutet immer schlicht aus - ein evtl. im Entwurf gewaehltes
    // Signalverhalten (Blinken/Blitzen/Wallend) und eine Einblendzeit werden
    // dabei ignoriert, damit "Aus" immer der einfache, unbefristete Pfad
    // bleibt (kein "blinkend bei 0%", kein unerwarteter Auto-Timer).
    applyManualControl(d, { ...state, dimLevelPercent: 0, behaviour: "", rampTime: "" }, btn);
  }
});

// Spalte 2 und Spalte 3 sind standardmaessig eingeklappt (siehe .collapsible-*
// in style.css) - ein Klick auf die Ueberschrift klappt sie auf/zu. Die
// eigentlichen Inhalte (Regler, Tabelle) werden unveraendert im Hintergrund
// weiter aktualisiert, auch waehrend eingeklappt.
function setupCollapsibleCard(cardSelector, toggleSelector) {
  const card = $(cardSelector);
  const toggle = $(toggleSelector);
  toggle.addEventListener("click", () => {
    card.classList.toggle("expanded");
  });
}
setupCollapsibleCard("#manualControlsCard", "#manualControlsToggle");
setupCollapsibleCard("#devicesTableCard", "#devicesTableToggle");

$("#sourceSearch").addEventListener("input", (e) => {
  sourceFilters.search = e.target.value;
  renderSourceList();
});

$("#sourceOnlySelected").addEventListener("change", (e) => {
  sourceFilters.onlySelected = e.target.checked;
  renderSourceList();
});

$("#selectVisibleBtn").addEventListener("click", () => {
  for (const key of visibleSourceKeys) selectedSourceKeys.add(key);
  renderSourceList();
});

$("#deselectVisibleBtn").addEventListener("click", () => {
  for (const key of visibleSourceKeys) selectedSourceKeys.delete(key);
  renderSourceList();
});

/**
 * "Auslöser bearbeiten": laedt Quellen + Verknuepfung einer bestehenden
 * Regel in die Quellen-Auswahl des Formulars (inkl. Suche/Filter). Ziel,
 * Farbe und Signalverhalten bleiben unveraendert und werden in diesem
 * Modus ausgeblendet. Gespeichert wird per PATCH /api/rules/:id.
 */
function startEditSources(rule) {
  editingRule = rule;
  selectedSourceKeys.clear();
  for (const s of rule.sources) {
    const key = `${s.deviceId}::${s.channelIndex}::${s.condition || s.effectiveCondition}`;
    selectedSourceKeys.add(key);
    if (s.threshold !== undefined) sourceParams[key] = { op: s.op || ">", threshold: String(s.threshold) };
  }
  $("#sourceLogicSelect").value = rule.sourceLogic || "OR";
  const targetText = `${rule.target.deviceLabel}${rule.target.channelLabel ? " – " + rule.target.channelLabel : ""}`;
  $("#editBannerText").textContent = `Auslöser der Regel für ${targetText} bearbeiten (${rule.sources.length} ausgewählt). LED, Farbe und Helligkeit bleiben unverändert.`;
  $("#editBanner").style.display = "flex";
  $("#ruleFormHeading").textContent = "Auslöser bearbeiten";
  $("#ruleSubmitBtn").textContent = "Auslöser speichern";
  for (const sel of ["#ruleFormArrow", "#ruleFormTargetBlock", "#invertToggle", "#ruleTargetState"]) $(sel).style.display = "none";
  $("#ruleFormCard").classList.add("editing");
  renderSourceList();
  $("#ruleFormCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

function stopEditSources() {
  editingRule = null;
  selectedSourceKeys.clear();
  $("#sourceLogicSelect").value = "OR";
  $("#editBanner").style.display = "none";
  $("#ruleFormHeading").textContent = "Neue Regel: Wenn … dann LED";
  $("#ruleSubmitBtn").textContent = "Regel hinzufügen";
  for (const sel of ["#ruleFormArrow", "#ruleFormTargetBlock", "#invertToggle"]) $(sel).style.display = "";
  $("#ruleFormCard").classList.remove("editing");
  updateRuleTargetStateVisibility();
  renderSourceList();
}

$("#cancelEditBtn").addEventListener("click", stopEditSources);

$("#onDimLevelInput").addEventListener("input", (e) => {
  newRuleTargetState.dimLevelPercent = Number(e.target.value);
  $("#onDimLevelValue").textContent = `${newRuleTargetState.dimLevelPercent}%`;
});

$("#newRuleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (selectedSourceKeys.size === 0) {
    alert("Bitte mindestens einen Auslöser auswählen.");
    return;
  }

  let sources;
  try {
    sources = buildSelectedSources();
  } catch (err) {
    alert(err.message);
    return;
  }

  if (editingRule) {
    try {
      await fetchJSON(`/api/rules/${editingRule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources,
          sourceLogic: $("#sourceLogicSelect").value,
        }),
      });
      stopEditSources();
      await refreshRules();
    } catch (err) {
      alert("Fehler: " + err.message);
    }
    return;
  }

  const targetKey = $("#targetChannelSelect").value;
  if (!targetKey) return;

  const target = findDeviceByKey(targetKey);

  try {
    await fetchJSON("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources,
        sourceLogic: $("#sourceLogicSelect").value,
        target: parseKey(targetKey),
        invert: $("#invertCheckbox").checked,
        onDimLevel: target && target.controlType !== "SWITCH" ? newRuleTargetState.dimLevelPercent / 100 : undefined,
        onColor: target && target.supportsColor ? newRuleTargetState.color : undefined,
        onBehaviour: target && target.supportsColor ? newRuleTargetState.behaviour || undefined : undefined,
      }),
    });
    $("#invertCheckbox").checked = false;
    $("#sourceLogicSelect").value = "OR";
    newRuleTargetState = { dimLevelPercent: 100, color: "WHITE", behaviour: "" };
    selectedSourceKeys.clear();
    renderSourceList();
    await refreshRules();
  } catch (err) {
    alert("Fehler: " + err.message);
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshDevices(), refreshRules(), refreshLog()]);
}

refreshAll();
setInterval(refreshAll, 3000);
