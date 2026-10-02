(() => {
  "use strict";

  const DEFAULT_ACTIONS = [
    ["none", "Geen actie"], ["ptt", "PTT"], ["sos", "Noodoproep starten"], ["emergency_cancel", "Noodoproep stoppen"],
    ["screen_open", "Ga naar scherm"], ["screen_back", "Ga naar vorig scherm"],
    ["channel_up", "Kanaal omhoog"], ["channel_down", "Kanaal omlaag"], ["channel_select", "Ga naar kanaal"],
    ["status_select", "Stel status in"],
    ["volume_up", "Volume omhoog"], ["volume_down", "Volume omlaag"],
    ["input_numeric", "Numerieke input"], ["input_t9", "T9 input"],
    ["selection_up", "Selectie omhoog"], ["selection_down", "Selectie omlaag"],
    ["selection_left", "Selectie links"], ["selection_right", "Selectie rechts"],
    ["selection_select", "Selecteer huidige selectie"]
  ];
  const USEMODES = [
    ["visible", "Zichtbaar"],
    ["hidden", "Verborgen"],
  ];
  const SCREEN_TYPES = [["detail", "Detail"], ["list", "Lijst"], ["private_call", "Privé gesprek"]];
  const KEYBOARD_LAYOUTS = [["none", "Geen"], ["3x4", "3 × 4"], ["2x1-3", "2 x 1-3"]];
  const SOFTRADIO_LAYOUTS = [["1x1", "1 rij × 1 kolom"], ["1x2", "1 rij × 2 kolommen (2/3 + 1/3)"], ["1x3", "1 rij × 3 kolommen"]];
  const LABEL_TYPES = [["text", "Tekst"], ["icon", "Icoon"]];
  const EXTERNAL_ORDERS = {
    topkeys: ["tk1", "tk2", "tk3", "tk4", "tk5", "tk6", "tk7", "tk8"],
    keyboard: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "star", "0", "hash"],
    leftkeys: ["tl1", "tl2", "tl3", "tl4", "tl5", "tl6"],
    rightkeys: ["tr1", "tr2", "tr3", "tr4", "tr5", "tr6"],
    softradio: ["sr1", "sr2", "sr3"],
  };
  const TOP_ROTARIES = new Set(["tk7", "tk8"]);

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[char]));

  function defaultConfig() {
    return {
      schema_version: 2, theme: {}, type: "detail", title: "Nieuw scherm", primary: "", secondary: "",
      display: { usemode: "visible", default_screen_type: "detail", softkeys: { usemode: "hidden", default_color: "#e4e4e4", keys: {} } },
      navkeys: { usemode: "visible", default_color: "#3a3d40", keys: {} },
      keyboard: { usemode: "hidden", layout: "none", default_color: "#3a3d40", keys: {} },
      softradio: { usemode: "hidden", layout: "1x3", default_color: "#3a3d40", keys: {} },
      topkeys: { usemode: "hidden", default_color: "#3a3d40", keys: {} },
      leftkeys: { usemode: "hidden", default_color: "#3a3d40", keys: {} },
      rightkeys: { usemode: "hidden", default_color: "#3a3d40", keys: {} },
    };
  }

  function normalizeGroup(group, usemode, color) {
    const result = group && typeof group === "object" && !Array.isArray(group) ? group : {};
    result.usemode = normalizeUsemode(result.usemode, usemode); result.default_color ??= color;
    result.keys = result.keys && typeof result.keys === "object" && !Array.isArray(result.keys) ? result.keys : {};
    return result;
  }

  function normalizeUsemode(value, fallback = "visible") {
    const mode = String(value ?? fallback).toLowerCase();
    if (["visible", "softradio", "display"].includes(mode)) return "visible";
    if (["hidden", "disabled", "hardware"].includes(mode)) return "hidden";
    return fallback;
  }


  function normalizeTopKeys(group) {
    const source = group && typeof group === "object" ? group : {};
    const originalKeys = source.keys && typeof source.keys === "object" ? source.keys : {};
    const keys = {};
    Object.entries(originalKeys).forEach(([rawId, rawKey]) => {
      let keyId = String(rawId).toLowerCase();
      if (keyId === "tr1") keyId = "tk7";
      if (keyId === "tr2") keyId = "tk8";
      const key = rawKey && typeof rawKey === "object" ? { ...rawKey } : rawKey;
      if ((keyId === "tk7" || keyId === "tk8") && key && typeof key === "object") {
        key.type = "rotary";
        const currentLabel = key.label_primary && typeof key.label_primary === "object" ? { ...key.label_primary } : { type: "text", value: key.label_primary ?? "" };
        if (!currentLabel.value || ["TR1", "TR2", "TK7", "TK8"].includes(String(currentLabel.value).toUpperCase())) currentLabel.value = keyId.toUpperCase();
        key.label_primary = currentLabel;
      }
      keys[keyId] = key;
    });
    source.keys = keys;
    return source;
  }


  function normalizeKeyboard(group) {
    const source = group && typeof group === "object" ? group : {};
    const originalKeys = source.keys && typeof source.keys === "object" ? source.keys : {};
    const aliases = {
      kb0: "0", kb1: "1", kb2: "2", kb3: "3", kb4: "4",
      kb5: "5", kb6: "6", kb7: "7", kb8: "8", kb9: "9",
      kbstar: "star", kbhash: "hash"
    };
    const keys = {};
    Object.entries(originalKeys).forEach(([rawId, rawKey]) => {
      const normalizedId = aliases[String(rawId).toLowerCase()] || String(rawId).toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(keys, normalizedId)) keys[normalizedId] = rawKey;
    });
    source.keys = keys;
    return source;
  }

  function normalize(config) {
    const result = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    result.schema_version ??= 2; result.theme = result.theme && typeof result.theme === "object" ? result.theme : {};
    result.type ??= "detail"; result.title ??= ""; result.primary ??= ""; result.secondary ??= "";
    result.display = result.display && typeof result.display === "object" ? result.display : {};
    result.display.usemode = normalizeUsemode(result.display.usemode, "visible"); result.display.default_screen_type ??= "detail";
    result.display.softkeys = normalizeGroup(result.display.softkeys, "hidden", "#e4e4e4");
    result.navkeys = normalizeGroup(result.navkeys, "visible", "#3a3d40");
    result.keyboard = normalizeKeyboard(normalizeGroup(result.keyboard, "hidden", "#3a3d40")); result.keyboard.layout ??= "none";
    result.softradio = normalizeGroup(result.softradio, "hidden", "#3a3d40"); result.softradio.layout ??= "1x3";
    result.topkeys = normalizeTopKeys(normalizeGroup(result.topkeys, "hidden", "#3a3d40"));
    result.leftkeys = normalizeGroup(result.leftkeys, "hidden", "#3a3d40");
    result.rightkeys = normalizeGroup(result.rightkeys, "hidden", "#3a3d40");
    return result;
  }

  function optionsHtml(options, selected, unknownLabel = "aangepast") {
    const all = [...options];
    if (selected && !all.some(([value]) => value === selected)) all.push([selected, `${selected} (${unknownLabel})`]);
    return all.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
  }
  function groupAt(config, path) { return path === "display.softkeys" ? config.display.softkeys : config[path]; }
  function field(path, label, value, type = "text") { return `<label class="bce-field"><span>${escapeHtml(label)}</span><input type="${type}" data-config-path="${escapeHtml(path)}" value="${escapeHtml(value)}"></label>`; }
  function selectField(path, label, value, options) { return `<label class="bce-field"><span>${escapeHtml(label)}</span><select data-config-path="${escapeHtml(path)}">${optionsHtml(options, value)}</select></label>`; }

  function paramEditor(action, params, screenChoices, channelChoices, statusChoices, fieldName = "action_params") {
    if (action === "screen_open") {
      const target = params?.screen || "";
      return `<select data-key-field="${fieldName}_screen">${optionsHtml([["", "— Kies een scherm —"], ...screenChoices.map(v => [v, v])], target)}</select>`;
    }
    if (action === "channel_select") {
      const target = params?.channel || "";
      return `<select data-key-field="${fieldName}_channel">${optionsHtml([["", "— Kies een kanaal —"], ...channelChoices], target)}</select>`;
    }
    if (action === "status_select") {
      const target = params?.status || "";
      return `<select data-key-field="${fieldName}_status">${optionsHtml([["", "— Kies een status —"], ...statusChoices], target)}</select>`;
    }
    if (action === "input_numeric" || action === "input_t9") {
      const target = params?.value ?? "";
      return `<input type="text" data-key-field="${fieldName}_value" value="${escapeHtml(target)}" placeholder="Waarde">`;
    }
    if (action === "volume_up" || action === "volume_down") {
      const target = params?.step ?? 5;
      return `<input type="number" min="1" max="100" step="1" data-key-field="${fieldName}_step" value="${escapeHtml(target)}" placeholder="Stap %">`;
    }
    if (!action || action === "none" || ["ptt", "sos", "emergency_cancel", "private_call_accept", "private_call_decline", "private_call_hangup", "screen_back", "channel_up", "channel_down", "selection_up", "selection_down", "selection_left", "selection_right", "selection_select"].includes(action)) {
      return `<span class="bce-no-params">Geen parameters nodig</span>`;
    }
    return `<textarea rows="2" data-key-field="${fieldName}">${escapeHtml(JSON.stringify(params || {}))}</textarea>`;
  }

  function keyRow(codekey, key, defaultColor, screenChoices, channelChoices, statusChoices, actions) {
    const label = key.label_primary && typeof key.label_primary === "object" ? key.label_primary : { type: "text", value: key.label_primary ?? "" };
    const shortAction = key.short_action ?? key.action ?? "none";
    const shortParams = key.short_action_params ?? key.action_params ?? {};
    const longAction = key.long_action ?? "";
    const longParams = key.long_action_params ?? {};
    const longOptions = [["", "— Geen long press: gebruik short —"], ...actions];
    return `<tr data-key-row data-codekey="${escapeHtml(codekey)}">
      <td><input data-key-field="codekey" value="${escapeHtml(codekey)}" readonly></td>
      <td><input type="number" step="1" data-key-field="hw_key" value="${escapeHtml(key.hw_key ?? "")}" placeholder="Android keyCode"></td>
      <td><select data-key-field="short_action" required>${optionsHtml(actions, shortAction)}</select><span class="bce-press-help">Short ≥ 0,2 s</span></td>
      <td data-params-cell>${paramEditor(shortAction, shortParams, screenChoices, channelChoices, statusChoices, "short_action_params")}</td>
      <td><select data-key-field="long_action">${optionsHtml(longOptions, longAction)}</select><span class="bce-press-help">Long ≥ 2,0 s</span></td>
      <td data-long-params-cell>${longAction ? paramEditor(longAction, longParams, screenChoices, channelChoices, statusChoices, "long_action_params") : '<span class="bce-no-params">Valt terug op short</span>'}</td>
      <td><select data-key-field="label_type">${optionsHtml(LABEL_TYPES, label.type || "text")}</select></td>
      <td><input data-key-field="label_value" value="${escapeHtml(label.value ?? "")}"></td>
      <td><input data-key-field="label_secondary" value="${escapeHtml(key.label_secondary ?? "")}"></td>
      <td class="bce-color-cell"><input type="color" data-key-field="color" value="${escapeHtml(key.color || defaultColor)}"><button type="button" class="button bce-clear-color" title="Eigen kleur verwijderen">×</button></td>
    </tr>`;
  }

  function rotaryRow(codekey, key, defaultColor, screenChoices, channelChoices, statusChoices, actions) {
    const label = key.label_primary && typeof key.label_primary === "object" ? key.label_primary : { type: "text", value: key.label_primary ?? codekey.toUpperCase() };
    const ccwAction = key.action_counter_clockwise ?? key.short_action_counter_clockwise ?? key.action ?? "none";
    const ccwParams = key.action_params_counter_clockwise ?? key.short_action_params_counter_clockwise ?? key.action_params ?? {};
    const cwAction = key.action_clockwise ?? key.short_action_clockwise ?? key.action ?? "none";
    const cwParams = key.action_params_clockwise ?? key.short_action_params_clockwise ?? key.action_params ?? {};
    return `<tr data-key-row data-codekey="${escapeHtml(codekey)}" data-rotary="1">
      <td><input data-key-field="codekey" value="${escapeHtml(codekey)}" readonly></td>
      <td><input type="number" step="1" data-key-field="hw_key_counter_clockwise" value="${escapeHtml(key.hw_key_counter_clockwise ?? key.hw_key_ccw ?? "")}" placeholder="keyCode"></td>
      <td><select data-key-field="action_counter_clockwise">${optionsHtml(actions, ccwAction)}</select></td>
      <td>${paramEditor(ccwAction, ccwParams, screenChoices, channelChoices, statusChoices, "action_params_counter_clockwise")}</td>
      <td><input type="number" step="1" data-key-field="hw_key_clockwise" value="${escapeHtml(key.hw_key_clockwise ?? key.hw_key_cw ?? "")}" placeholder="keyCode"></td>
      <td><select data-key-field="action_clockwise">${optionsHtml(actions, cwAction)}</select></td>
      <td>${paramEditor(cwAction, cwParams, screenChoices, channelChoices, statusChoices, "action_params_clockwise")}</td>
      <td><select data-key-field="label_type">${optionsHtml(LABEL_TYPES, label.type || "text")}</select></td>
      <td><input data-key-field="label_value" value="${escapeHtml(label.value ?? codekey.toUpperCase())}"></td>
      <td><input data-key-field="label_secondary" value="${escapeHtml(key.label_secondary ?? "")}"></td>
      <td class="bce-color-cell"><input type="color" data-key-field="color" value="${escapeHtml(key.color || defaultColor)}"><button type="button" class="button bce-clear-color" title="Eigen kleur verwijderen">×</button></td>
    </tr>`;
  }

  function orderedEntries(path, keys) {
    const order = EXTERNAL_ORDERS[path];
    if (!order) return Object.entries(keys || {});
    return order.filter(k => Object.prototype.hasOwnProperty.call(keys || {}, k)).map(k => [k, keys[k]]);
  }

  function groupSection(path, title, group, screenChoices, channelChoices, statusChoices, actions, extra = "", note = "") {
    const isTop = path === "topkeys";
    const entries = orderedEntries(path, group.keys);
    const normalHeaders = "<th>Codekey</th><th>HW key</th><th>Short action</th><th>Short params</th><th>Long action</th><th>Long params</th><th>Label type</th><th>Label value</th><th>Label secondary</th><th>Color</th>";
    const rotaryHeaders = "<th>Codekey</th><th>HW CCW keyCode</th><th>Action CCW</th><th>Params CCW</th><th>HW CW keyCode</th><th>Action CW</th><th>Params CW</th><th>Label type</th><th>Label value</th><th>Label secondary</th><th>Color</th>";

    if (isTop) {
      const buttonRows = entries.filter(([codekey]) => !TOP_ROTARIES.has(codekey)).map(([codekey, key]) => keyRow(codekey, key, group.default_color || "#3a3d40", screenChoices, channelChoices, statusChoices, actions)).join("");
      const rotaryRows = entries.filter(([codekey]) => TOP_ROTARIES.has(codekey)).map(([codekey, key]) => rotaryRow(codekey, key, group.default_color || "#3a3d40", screenChoices, channelChoices, statusChoices, actions)).join("");
      return `<section class="bce-section" data-group="${escapeHtml(path)}">
        <h3>Top keys (TK1-TK6 / rotary TK7-TK8)</h3><div class="bce-section-body">
          ${note ? `<p class="bce-section-note">${escapeHtml(note)}</p>` : ""}
          <div class="bce-section-settings">${selectField(`${path}.usemode`, "Usemode", group.usemode, USEMODES)}${field(`${path}.default_color`, "Standaardkleur", group.default_color, "color")}${extra}</div>
          <h4 class="bce-subtable-title">TK1-TK6 (knoppen)</h4>
          <div class="bce-table-wrap"><table class="bce-key-table bce-topkey-buttons"><thead><tr>${normalHeaders}</tr></thead>
          <tbody>${buttonRows || '<tr class="bce-empty"><td colspan="10">Geen TK1-TK6 knoppen gedefinieerd.</td></tr>'}</tbody></table></div>
          <h4 class="bce-subtable-title">TK7-TK8 (rotary)</h4>
          <div class="bce-table-wrap"><table class="bce-key-table bce-topkey-rotary"><thead><tr>${rotaryHeaders}</tr></thead>
          <tbody>${rotaryRows || '<tr class="bce-empty"><td colspan="11">Geen TK7-TK8 rotary-controls gedefinieerd.</td></tr>'}</tbody></table></div>
          <button type="button" class="button bce-add-row">Volgende Top key toevoegen</button>
        </div></section>`;
    }

    const rows = entries.map(([codekey, key]) => keyRow(codekey, key, group.default_color || "#3a3d40", screenChoices, channelChoices, statusChoices, actions)).join("");
    return `<section class="bce-section" data-group="${escapeHtml(path)}">
      <h3>${escapeHtml(title)}</h3><div class="bce-section-body">
        ${note ? `<p class="bce-section-note">${escapeHtml(note)}</p>` : ""}
        <div class="bce-section-settings">${selectField(`${path}.usemode`, "Usemode", group.usemode, USEMODES)}${field(`${path}.default_color`, "Standaardkleur", group.default_color, "color")}${extra}</div>
        <div class="bce-table-wrap"><table class="bce-key-table"><thead><tr>${normalHeaders}</tr></thead>
        <tbody>${rows || '<tr class="bce-empty"><td colspan="10">Geen knoppen gedefinieerd.</td></tr>'}</tbody></table></div>
        <button type="button" class="button bce-add-row">Volgende knop toevoegen</button>
      </div></section>`;
  }

  function getPath(object, path) { return path.split(".").reduce((current, part) => current?.[part], object); }
  function setPath(object, path, value) { const parts = path.split("."); const last = parts.pop(); const target = parts.reduce((current, part) => (current[part] ||= {}), object); target[last] = value; }


  function cloneValue(value) { return JSON.parse(JSON.stringify(value ?? {})); }
  function deepMerge(base, override) {
    if (!base || typeof base !== "object" || Array.isArray(base)) return cloneValue(override);
    const result = cloneValue(base);
    if (!override || typeof override !== "object" || Array.isArray(override)) return result;
    Object.entries(override).forEach(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = deepMerge(result[key], value);
      else result[key] = cloneValue(value);
    });
    return result;
  }
  function groupKeys(config, path) {
    const group = path === "display.softkeys" ? config?.display?.softkeys : config?.[path];
    return group && typeof group === "object" && group.keys && typeof group.keys === "object" ? group.keys : {};
  }
  function effectiveGroup(config, path) {
    return path === "display.softkeys" ? (config?.display?.softkeys || {}) : (config?.[path] || {});
  }
  function setSparseKeys(config, path, keys) {
    if (path === "display.softkeys") {
      config.display ||= {};
      config.display.softkeys ||= {};
      if (Object.keys(keys).length) config.display.softkeys.keys = keys;
      else {
        delete config.display.softkeys.keys;
        if (!Object.keys(config.display.softkeys).length) delete config.display.softkeys;
        if (!Object.keys(config.display).length) delete config.display;
      }
      return;
    }
    config[path] ||= {};
    if (Object.keys(keys).length) config[path].keys = keys;
    else {
      delete config[path].keys;
      if (!Object.keys(config[path]).length) delete config[path];
    }
  }
  function overrideGroupSection(path, title, overrideConfig, baseConfig, allowedConfig, screenChoices, channelChoices, statusChoices, actions) {
    const overrideKeys = groupKeys(overrideConfig, path);
    const baseGroup = effectiveGroup(baseConfig, path);
    const allowedKeys = groupKeys(allowedConfig, path);
    const entries = orderedEntries(path, overrideKeys);
    const normalHeaders = "<th>Codekey</th><th>HW key</th><th>Short action</th><th>Short params</th><th>Long action</th><th>Long params</th><th>Label type</th><th>Label value</th><th>Label secondary</th><th>Color</th><th></th>";
    const rotaryHeaders = "<th>Codekey</th><th>HW CCW keyCode</th><th>Action CCW</th><th>Params CCW</th><th>HW CW keyCode</th><th>Action CW</th><th>Params CW</th><th>Label type</th><th>Label value</th><th>Label secondary</th><th>Color</th><th></th>";
    const rowWithRemove = (html) => html.replace('</tr>', '<td><button type="button" class="button bce-remove-override">Verwijder override</button></td></tr>');
    let tables = "";
    if (path === "topkeys") {
      const buttons = entries.filter(([id]) => !TOP_ROTARIES.has(id)).map(([id, key]) => rowWithRemove(keyRow(id, deepMerge(baseGroup.keys?.[id] || {}, key), baseGroup.default_color || "#3a3d40", screenChoices, channelChoices, statusChoices, actions))).join("");
      const rotaries = entries.filter(([id]) => TOP_ROTARIES.has(id)).map(([id, key]) => rowWithRemove(rotaryRow(id, deepMerge(baseGroup.keys?.[id] || {}, key), baseGroup.default_color || "#3a3d40", screenChoices, channelChoices, statusChoices, actions))).join("");
      tables = `<h4 class="bce-subtable-title">TK1-TK6</h4><div class="bce-table-wrap"><table class="bce-key-table"><thead><tr>${normalHeaders}</tr></thead><tbody>${buttons || '<tr class="bce-empty"><td colspan="11">Geen overrides.</td></tr>'}</tbody></table></div><h4 class="bce-subtable-title">TK7-TK8 rotary</h4><div class="bce-table-wrap"><table class="bce-key-table"><thead><tr>${rotaryHeaders}</tr></thead><tbody>${rotaries || '<tr class="bce-empty"><td colspan="12">Geen overrides.</td></tr>'}</tbody></table></div>`;
    } else {
      const rows = entries.map(([id, key]) => rowWithRemove(keyRow(id, deepMerge(baseGroup.keys?.[id] || {}, key), baseGroup.default_color || "#3a3d40", screenChoices, channelChoices, statusChoices, actions))).join("");
      tables = `<div class="bce-table-wrap"><table class="bce-key-table"><thead><tr>${normalHeaders}</tr></thead><tbody>${rows || '<tr class="bce-empty"><td colspan="11">Geen overrides.</td></tr>'}</tbody></table></div>`;
    }
    const available = orderedEntries(path, allowedKeys).filter(([id]) => !Object.prototype.hasOwnProperty.call(overrideKeys, id));
    const chooser = available.length ? `<div class="bce-add-specific"><select class="bce-key-choice"><option value="">— Kies knop —</option>${available.map(([id]) => `<option value="${escapeHtml(id)}">${escapeHtml(id.toUpperCase())}</option>`).join("")}</select><button type="button" class="button bce-add-specific-key">Knop toevoegen</button></div>` : '<div class="help">Alle beschikbare knoppen uit HardwareConfig zijn al toegevoegd.</div>';
    return `<section class="bce-section" data-group="${escapeHtml(path)}"><h3>${escapeHtml(title)}</h3><div class="bce-section-body">${tables}${chooser}</div></section>`;
  }
  function initializeEditors() {
    document.querySelectorAll("[data-screen-config-editor]").forEach((root) => {
      if (root.dataset.initialized === "1") return; root.dataset.initialized = "1";
      const textarea = root.querySelector("textarea"), visual = root.querySelector("[data-bce-visual]"), message = root.querySelector("[data-bce-message]");
      const editorScope = root.dataset.editorScope || "full";
      let config = defaultConfig(), screenChoices = [], channelChoices = [], statusChoices = [], actions = DEFAULT_ACTIONS, parentConfigs = {};
      try { screenChoices = JSON.parse(root.dataset.screenChoices || "[]"); } catch (_) {}
      try { channelChoices = JSON.parse(root.dataset.channelChoices || "[]"); } catch (_) {}
      try { statusChoices = JSON.parse(root.dataset.statusChoices || "[]"); } catch (_) {}
      try { actions = JSON.parse(root.dataset.actionChoices || "[]"); if (!Array.isArray(actions) || !actions.length) actions = DEFAULT_ACTIONS; } catch (_) { actions = DEFAULT_ACTIONS; }
      try { parentConfigs = JSON.parse(root.dataset.parentConfigs || "{}"); } catch (_) { parentConfigs = {}; }
      const parentSelect = root.dataset.parentSelectId ? document.getElementById(root.dataset.parentSelectId) : null;
      const parentLayer = () => parentConfigs[String(parentSelect?.value || "")] || null;
      function notify(text, type = "error") { message.hidden = false; message.className = `bce-message ${type}`; message.textContent = text; }
      function clearMessage() { message.hidden = true; message.textContent = ""; }
      function sync() { textarea.value = JSON.stringify(config, null, 2); textarea.dispatchEvent(new Event("change", { bubbles: true })); }
      function readParams(row, action, name) {
        if (action === "screen_open") { const v=row.querySelector(`[data-key-field="${name}_screen"]`)?.value||""; return v?{screen:v}:{}; }
        if (action === "channel_select") { const v=row.querySelector(`[data-key-field="${name}_channel"]`)?.value||""; return v?{channel:v}:{}; }
        if (action === "status_select") { const v=row.querySelector(`[data-key-field="${name}_status"]`)?.value||""; return v?{status:v}:{}; }
        if (action === "input_numeric" || action === "input_t9") return {value:row.querySelector(`[data-key-field="${name}_value"]`)?.value??""};
        if (action === "volume_up" || action === "volume_down") { const v=row.querySelector(`[data-key-field="${name}_step"]`)?.value; return v?{step:Number(v)}:{}; }
        const input=row.querySelector(`[data-key-field="${name}"]`); if(!input) return {}; try { const r=JSON.parse(input.value||"{}"); input.setCustomValidity(""); return r; } catch(_) { input.setCustomValidity("Action params moet geldige JSON zijn."); throw new Error("invalid params"); }
      }
      function rowToKey(row, old={}) {
        if (row.dataset.rotary === "1") {
          const intOrNull=v=>String(v??"").trim()===""?null:Number.parseInt(String(v).trim(),10);
          const ccw=row.querySelector('[data-key-field="action_counter_clockwise"]').value||"none", cw=row.querySelector('[data-key-field="action_clockwise"]').value||"none";
          const key={...old,type:"rotary",hw_key_counter_clockwise:intOrNull(row.querySelector('[data-key-field="hw_key_counter_clockwise"]').value),action_counter_clockwise:ccw,action_params_counter_clockwise:readParams(row,ccw,"action_params_counter_clockwise"),hw_key_clockwise:intOrNull(row.querySelector('[data-key-field="hw_key_clockwise"]').value),action_clockwise:cw,action_params_clockwise:readParams(row,cw,"action_params_clockwise"),label_primary:{type:row.querySelector('[data-key-field="label_type"]').value,value:row.querySelector('[data-key-field="label_value"]').value}};
          const sec=row.querySelector('[data-key-field="label_secondary"]').value.trim(); if(sec) key.label_secondary=sec; else delete key.label_secondary;
          const color=row.querySelector('[data-key-field="color"]').value; if(color) key.color=color;
          return key;
        }
        const shortAction=row.querySelector('[data-key-field="short_action"]').value||"none", longAction=row.querySelector('[data-key-field="long_action"]').value||"";
        const v=row.querySelector('[data-key-field="hw_key"]').value.trim();
        const key={...old,hw_key:v===""?null:Number.parseInt(v,10),short_action:shortAction,short_action_params:readParams(row,shortAction,"short_action_params"),label_primary:{type:row.querySelector('[data-key-field="label_type"]').value,value:row.querySelector('[data-key-field="label_value"]').value}};
        delete key.action; delete key.action_params;
        if(longAction){key.long_action=longAction;key.long_action_params=readParams(row,longAction,"long_action_params");}else{delete key.long_action;delete key.long_action_params;}
        const sec=row.querySelector('[data-key-field="label_secondary"]').value; if(sec) key.label_secondary=sec; else delete key.label_secondary;
        key.color=row.querySelector('[data-key-field="color"]').value;
        return key;
      }
      function collectGroup(section) {
        const path=section.dataset.group, keys={}; let valid=true;
        section.querySelectorAll('tr[data-key-row]').forEach(row=>{ const id=row.querySelector('[data-key-field="codekey"]').value.trim(); if(!id)return; try{keys[id]=rowToKey(row, groupKeys(config,path)[id]||{});}catch(_){valid=false;} });
        if(valid){ if(editorScope==="override") setSparseKeys(config,path,keys); else groupAt(config,path).keys=keys; }
        return valid;
      }
      function collectAll(){let valid=true;visual.querySelectorAll('[data-group]').forEach(s=>{if(!collectGroup(s))valid=false;});if(valid)sync();return valid;}
      function renderOverride(){
        const layer=parentLayer(); if(!layer){visual.innerHTML='<section class="bce-section"><div class="bce-section-body"><p>Kies eerst de bovenliggende HardwareConfig/HardwareProfile.</p></div></section>'; return;}
        const base=layer.base||{}, allowed=layer.allowed||{};
        const sections=[["topkeys","Top keys"],["leftkeys","Left keys"],["rightkeys","Right keys"],["display.softkeys","Softkeys"],["navkeys","Navigatietoetsen"],["keyboard","Keyboard"],["softradio","Softradio"]];
        visual.innerHTML=sections.filter(([p])=>Object.keys(groupKeys(allowed,p)).length).map(([p,t])=>overrideGroupSection(p,t,config,base,allowed,screenChoices,channelChoices,statusChoices,actions)).join("") || '<section class="bce-section"><div class="bce-section-body"><p>Deze HardwareConfig definieert geen knoppen.</p></div></section>';
        visual.querySelectorAll('[data-group]').forEach(section=>{
          section.addEventListener('change',event=>{if(event.target.matches('[data-key-field="short_action"], [data-key-field="long_action"], [data-key-field^="action_"]')){collectGroup(section);render();return;}collectGroup(section);sync();});
          section.addEventListener('input',event=>{if(!event.target.matches('textarea[data-key-field*="action_params"]')){collectGroup(section);sync();}});
          section.querySelector('.bce-add-specific-key')?.addEventListener('click',()=>{collectGroup(section);const id=section.querySelector('.bce-key-choice')?.value;if(!id)return;const path=section.dataset.group, inherited=groupKeys(base,path)[id]||groupKeys(allowed,path)[id];const keys={...groupKeys(config,path),[id]:cloneValue(inherited)};setSparseKeys(config,path,keys);sync();render();});
          section.querySelectorAll('.bce-remove-override').forEach(btn=>btn.addEventListener('click',()=>{const row=btn.closest('tr[data-key-row]'),id=row?.dataset.codekey,path=section.dataset.group;const keys={...groupKeys(config,path)};delete keys[id];setSparseKeys(config,path,keys);sync();render();}));
        });
      }
      function addNextKey(section){collectGroup(section);const path=section.dataset.group,group=groupAt(config,path),allowed=EXTERNAL_ORDERS[path];if(allowed){const id=allowed.find(k=>!Object.prototype.hasOwnProperty.call(group.keys,k));if(!id)return;group.keys[id]=(path==="topkeys"&&TOP_ROTARIES.has(id))?{type:"rotary",label_primary:{type:"text",value:id.toUpperCase()},hw_key_counter_clockwise:null,action_counter_clockwise:"none",action_params_counter_clockwise:{},hw_key_clockwise:null,action_clockwise:"none",action_params_clockwise:{}}:{hw_key:null,short_action:"none",short_action_params:{},label_primary:{type:"text",value:id.toUpperCase()}};}sync();render();}
      function render(){
        if(editorScope==="override"){renderOverride();return;}
        if(editorScope==="topkeys") visual.innerHTML=groupSection("topkeys","Top keys",config.topkeys,screenChoices,channelChoices,statusChoices,actions);
        else visual.innerHTML=`<section class="bce-section"><h3>Display</h3><div class="bce-section-body"><div class="bce-section-settings">${selectField("type","Schermtype",config.type,SCREEN_TYPES)}${field("title","Titel",config.title)}${field("primary","Primaire tekst",config.primary)}${field("secondary","Secundaire tekst",config.secondary)}</div></div></section>${groupSection("topkeys","Top keys",config.topkeys,screenChoices,channelChoices,statusChoices,actions)}${groupSection("leftkeys","Left keys",config.leftkeys,screenChoices,channelChoices,statusChoices,actions)}${groupSection("rightkeys","Right keys",config.rightkeys,screenChoices,channelChoices,statusChoices,actions)}${groupSection("display.softkeys","Softkeys",config.display.softkeys,screenChoices,channelChoices,statusChoices,actions)}${groupSection("navkeys","Navigatietoetsen",config.navkeys,screenChoices,channelChoices,statusChoices,actions)}${groupSection("keyboard","Keyboard",config.keyboard,screenChoices,channelChoices,statusChoices,actions,selectField("keyboard.layout","Layout",config.keyboard.layout,KEYBOARD_LAYOUTS))}${groupSection("softradio","Softradio",config.softradio,screenChoices,channelChoices,statusChoices,actions,selectField("softradio.layout","Layout",config.softradio.layout,SOFTRADIO_LAYOUTS))}`;
        visual.querySelectorAll('[data-config-path]').forEach(el=>{const save=()=>{setPath(config,el.dataset.configPath,el.value);sync();};el.addEventListener('input',save);el.addEventListener('change',save);});
        visual.querySelectorAll('[data-group]').forEach(section=>{section.addEventListener('change',()=>{collectGroup(section);sync();});section.addEventListener('input',()=>{collectGroup(section);sync();});section.querySelector('.bce-add-row')?.addEventListener('click',()=>addNextKey(section));});sync();
      }
      function parse(){try{const parsed=JSON.parse(textarea.value||"{}");if(parsed.screens||parsed.initial_screen)throw new Error("Dit record bevat nog meerdere schermen.");if(editorScope==="override")config=parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};else if(editorScope==="topkeys"){config=parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};config.topkeys=normalizeTopKeys(normalizeGroup(config.topkeys,"hidden","#3a3d40"));}else config=normalize(Object.keys(parsed).length?parsed:defaultConfig());clearMessage();render();}catch(error){notify(`Ongeldige JSON: ${error.message}`);}}
      root.querySelector('[data-bce-action="reload"]').addEventListener('click',parse);
      root.querySelector('[data-bce-action="format"]').addEventListener('click',()=>{try{textarea.value=JSON.stringify(JSON.parse(textarea.value||"{}"),null,2);parse();}catch(error){notify(`Ongeldige JSON: ${error.message}`);}});
      textarea.addEventListener('input',clearMessage); parentSelect?.addEventListener('change',()=>render());
      root.closest('form')?.addEventListener('submit',event=>{if(!collectAll()){event.preventDefault();notify("Opslaan gestopt: controleer de ongeldige action params.");}});
      parse();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializeEditors, { once: true }); else initializeEditors();
})();
