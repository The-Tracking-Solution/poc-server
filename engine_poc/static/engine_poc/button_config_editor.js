(() => {
  "use strict";

  const ACTIONS = [
    ["", "— Geen actie / zichtbaar uitgeschakeld —"],
    ["screen_open", "Scherm openen"],
    ["screen_back", "Vorig scherm"],
    ["list_up", "Lijst omhoog"],
    ["list_down", "Lijst omlaag"],
    ["list_left", "Lijst links"],
    ["list_right", "Lijst rechts"],
    ["list_select", "Lijst selecteren"],
    ["keypad_input", "Toets invoeren"],
    ["channel_select", "Kanaal selecteren"],
    ["channel_up", "Kanaal omhoog"],
    ["channel_down", "Kanaal omlaag"],
    ["status_select", "Status selecteren"],
    ["ptt", "PTT"],
    ["emergency", "Noodoproep"],
  ];
  const USEMODES = [
        ["disabled", "Uitgeschakeld"],
        ["display", "Weergave"],
        ["hardware", "Hardware"],
  ];
  const SCREEN_TYPES = [["detail", "Detail"], ["list", "Lijst"]];
  const KEYBOARD_LAYOUTS = [["none", "Geen"], ["3x4", "3 × 4"], ["2x1-3", "2 x 1-3"]];
  const LABEL_TYPES = [["text", "Tekst"], ["icon", "Icoon"]];

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[char]));

  function defaultConfig() {
    return {
      schema_version: 2,
      theme: {},
      type: "detail",
      title: "Nieuw scherm",
      primary: "",
      secondary: "",
      display: {
        usemode: "softradio",
        default_screen_type: "detail",
        softkeys: { usemode: "disabled", default_color: "#e4e4e4", keys: {} },
      },
      navkeys: { usemode: "softradio", default_color: "#3a3d40", keys: {} },
      keyboard: { usemode: "disabled", layout: "none", default_color: "#3a3d40", keys: {} },
    };
  }

  function normalize(config) {
    const result = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    result.schema_version ??= 2;
    result.theme = result.theme && typeof result.theme === "object" ? result.theme : {};
    result.type ??= "detail";
    result.title ??= "";
    result.primary ??= "";
    result.secondary ??= "";
    result.display = result.display && typeof result.display === "object" ? result.display : {};
    result.display.usemode ??= "softradio";
    result.display.default_screen_type ??= "detail";
    result.display.softkeys = normalizeGroup(result.display.softkeys, "disabled", "#e4e4e4");
    result.navkeys = normalizeGroup(result.navkeys, "softradio", "#3a3d40");
    result.keyboard = normalizeGroup(result.keyboard, "disabled", "#3a3d40");
    result.keyboard.layout ??= "none";
    return result;
  }

  function normalizeGroup(group, usemode, color) {
    const result = group && typeof group === "object" ? group : {};
    result.usemode ??= usemode;
    result.default_color ??= color;
    result.keys = result.keys && typeof result.keys === "object" && !Array.isArray(result.keys) ? result.keys : {};
    return result;
  }

  function optionsHtml(options, selected, unknownLabel = "aangepast") {
    const all = [...options];
    if (selected && !all.some(([value]) => value === selected)) all.push([selected, `${selected} (${unknownLabel})`]);
    return all.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
  }

  function groupAt(config, path) {
    return path === "display.softkeys" ? config.display.softkeys : config[path];
  }

  function field(path, label, value, type = "text") {
    return `<label class="bce-field"><span>${escapeHtml(label)}</span><input type="${type}" data-config-path="${escapeHtml(path)}" value="${escapeHtml(value)}"></label>`;
  }

  function selectField(path, label, value, options) {
    return `<label class="bce-field"><span>${escapeHtml(label)}</span><select data-config-path="${escapeHtml(path)}">${optionsHtml(options, value)}</select></label>`;
  }

  function keyRow(groupPath, codekey, key, defaultColor, screenChoices) {
    const label = key.label_primary && typeof key.label_primary === "object"
      ? key.label_primary
      : { type: "text", value: key.label_primary ?? "" };
    const action = key.action || "";
    const params = key.action_params && typeof key.action_params === "object" ? key.action_params : {};
    const target = params.screen || "";
    const paramEditor = action === "screen_open"
      ? `<select data-key-field="action_screen">${optionsHtml([["", "— Kies een scherm —"], ...screenChoices.map(v => [v, v])], target)}</select>`
      : `<textarea rows="2" data-key-field="action_params">${escapeHtml(JSON.stringify(params))}</textarea>`;

    return `<tr data-key-row data-codekey="${escapeHtml(codekey)}">
      <td><input data-key-field="codekey" value="${escapeHtml(codekey)}" ${codekey ? "readonly" : ""}></td>
      <td><input data-key-field="hw_key" value="${escapeHtml(key.hw_key || "")}"></td>
      <td><select data-key-field="action">${optionsHtml(ACTIONS, action)}</select></td>
      <td data-params-cell>${paramEditor}</td>
      <td><select data-key-field="label_type">${optionsHtml(LABEL_TYPES, label.type || "text")}</select></td>
      <td><input data-key-field="label_value" value="${escapeHtml(label.value ?? "")}"></td>
      <td><input data-key-field="label_secondary" value="${escapeHtml(key.label_secondary ?? "")}"></td>
      <td class="bce-color-cell"><input type="color" data-key-field="color" value="${escapeHtml(key.color || defaultColor)}"><button type="button" class="button bce-clear-color" title="Eigen kleur verwijderen">×</button></td>
      <td><button type="button" class="button deletelink bce-remove-row">Verwijderen</button></td>
    </tr>`;
  }

  function groupSection(path, title, group, screenChoices, extra = "") {
    const rows = Object.entries(group.keys || {}).map(([codekey, key]) => keyRow(path, codekey, key, group.default_color || "#3a3d40", screenChoices)).join("");
    return `<section class="bce-section" data-group="${escapeHtml(path)}">
      <h3>${escapeHtml(title)}</h3>
      <div class="bce-section-body">
        <div class="bce-section-settings">
          ${selectField(`${path}.usemode`, "Usemode", group.usemode, USEMODES)}
          ${field(`${path}.default_color`, "Standaardkleur", group.default_color, "color")}
          ${extra}
        </div>
        <div class="bce-table-wrap"><table class="bce-key-table">
          <thead><tr><th>Codekey</th><th>HW key</th><th>Action</th><th>Action params</th><th>Label type</th><th>Label value</th><th>Label secondary</th><th>Color</th><th></th></tr></thead>
          <tbody>${rows || '<tr class="bce-empty"><td colspan="9">Geen knoppen gedefinieerd.</td></tr>'}</tbody>
        </table></div>
        <button type="button" class="button bce-add-row">Knop toevoegen</button>
      </div>
    </section>`;
  }

  function getPath(object, path) {
    return path.split(".").reduce((current, part) => current?.[part], object);
  }

  function setPath(object, path, value) {
    const parts = path.split(".");
    const last = parts.pop();
    const target = parts.reduce((current, part) => (current[part] ||= {}), object);
    target[last] = value;
  }

  document.querySelectorAll("[data-screen-config-editor]").forEach((root) => {
    if (root.dataset.initialized === "1") return;
    root.dataset.initialized = "1";

    const textarea = root.querySelector("textarea");
    const visual = root.querySelector("[data-bce-visual]");
    const message = root.querySelector("[data-bce-message]");
    let config = defaultConfig();
    let screenChoices = [];

    try { screenChoices = JSON.parse(root.dataset.screenChoices || "[]"); } catch (_) { screenChoices = []; }

    function notify(text, type = "error") {
      message.hidden = false;
      message.className = `bce-message ${type}`;
      message.textContent = text;
    }
    function clearMessage() { message.hidden = true; message.textContent = ""; }
    function sync() {
      textarea.value = JSON.stringify(config, null, 2);
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function collectGroup(section) {
      const path = section.dataset.group;
      const group = groupAt(config, path);
      const keys = {};
      let valid = true;

      section.querySelectorAll("tr[data-key-row]").forEach((row) => {
        const codekey = row.querySelector('[data-key-field="codekey"]').value.trim();
        if (!codekey) return;
        const oldCodekey = row.dataset.codekey;
        const old = group.keys[oldCodekey] || {};
        const action = row.querySelector('[data-key-field="action"]').value;
        let params = {};

        if (action === "screen_open") {
          params = { screen: row.querySelector('[data-key-field="action_screen"]').value };
          if (!params.screen) params = {};
        } else {
          const paramsField = row.querySelector('[data-key-field="action_params"]');
          try {
            params = JSON.parse(paramsField?.value || "{}");
            paramsField?.setCustomValidity("");
          } catch (_) {
            paramsField.setCustomValidity("Action params moet geldige JSON zijn.");
            valid = false;
            return;
          }
        }

        const key = {
          ...old,
          hw_key: row.querySelector('[data-key-field="hw_key"]').value.trim(),
          action_params: params,
          label_primary: {
            type: row.querySelector('[data-key-field="label_type"]').value,
            value: row.querySelector('[data-key-field="label_value"]').value,
          },
        };
        if (action) key.action = action; else delete key.action;
        const secondary = row.querySelector('[data-key-field="label_secondary"]').value;
        if (secondary) key.label_secondary = secondary; else delete key.label_secondary;
        const colorInput = row.querySelector('[data-key-field="color"]');
        if (colorInput.dataset.inherit !== "1") key.color = colorInput.value; else delete key.color;
        keys[codekey] = key;
      });

      if (valid) group.keys = keys;
      return valid;
    }

    function collectAll() {
      let valid = true;
      visual.querySelectorAll("[data-group]").forEach((section) => { if (!collectGroup(section)) valid = false; });
      if (valid) sync();
      return valid;
    }

    function render() {
      visual.innerHTML = `<section class="bce-section"><h3>Display</h3><div class="bce-section-body"><div class="bce-section-settings">
        ${selectField("type", "Schermtype", config.type, SCREEN_TYPES)}
        ${field("title", "Titel", config.title)}
        ${field("primary", "Primaire tekst", config.primary)}
        ${field("secondary", "Secundaire tekst", config.secondary)}
        ${selectField("display.usemode", "Display-usemode", config.display.usemode, USEMODES)}
        ${selectField("display.default_screen_type", "Standaard schermtype", config.display.default_screen_type, SCREEN_TYPES)}
      </div></div></section>
      ${groupSection("display.softkeys", "Softkeys", config.display.softkeys, screenChoices)}
      ${groupSection("navkeys", "Navigatietoetsen", config.navkeys, screenChoices)}
      ${groupSection("keyboard", "Keyboard", config.keyboard, screenChoices, selectField("keyboard.layout", "Layout", config.keyboard.layout, KEYBOARD_LAYOUTS))}`;

      visual.querySelectorAll("[data-config-path]").forEach((fieldElement) => {
        const save = () => { setPath(config, fieldElement.dataset.configPath, fieldElement.value); sync(); };
        fieldElement.addEventListener("input", save);
        fieldElement.addEventListener("change", save);
      });

      visual.querySelectorAll("[data-group]").forEach((section) => {
        section.addEventListener("change", (event) => {
          if (event.target.matches('[data-key-field="action"]')) {
            collectGroup(section);
            render();
            return;
          }
          collectGroup(section); sync(); clearMessage();
        });
        section.addEventListener("input", (event) => {
          if (!event.target.matches('[data-key-field="action_params"]')) { collectGroup(section); sync(); }
        });
        section.querySelector(".bce-add-row").addEventListener("click", () => {
          collectGroup(section);
          const group = groupAt(config, section.dataset.group);
          let index = Object.keys(group.keys).length + 1;
          let codekey = `key_${index}`;
          while (group.keys[codekey]) { index += 1; codekey = `key_${index}`; }
          group.keys[codekey] = { hw_key: "", action_params: {}, label_primary: { type: "text", value: "" } };
          sync(); render();
        });
        section.querySelectorAll(".bce-remove-row").forEach((button) => button.addEventListener("click", () => {
          const row = button.closest("tr[data-key-row]");
          delete groupAt(config, section.dataset.group).keys[row.dataset.codekey];
          sync(); render();
        }));
        section.querySelectorAll(".bce-clear-color").forEach((button) => button.addEventListener("click", () => {
          const input = button.parentElement.querySelector('[data-key-field="color"]');
          input.dataset.inherit = "1";
          input.value = groupAt(config, section.dataset.group).default_color || "#3a3d40";
          collectGroup(section); sync();
        }));
      });
      sync();
    }

    function parse() {
      try {
        const parsed = JSON.parse(textarea.value || "{}");
        if (parsed.screens || parsed.initial_screen) throw new Error("Dit record bevat nog meerdere schermen. Voer eerst de datamigratie uit.");
        config = normalize(Object.keys(parsed).length ? parsed : defaultConfig());
        clearMessage(); render();
      } catch (error) { notify(`Ongeldige JSON: ${error.message}`); }
    }

    root.querySelector('[data-bce-action="reload"]').addEventListener("click", parse);
    root.querySelector('[data-bce-action="format"]').addEventListener("click", () => {
      try { textarea.value = JSON.stringify(JSON.parse(textarea.value || "{}"), null, 2); parse(); }
      catch (error) { notify(`Ongeldige JSON: ${error.message}`); }
    });
    textarea.addEventListener("input", () => clearMessage());
    root.closest("form")?.addEventListener("submit", (event) => {
      if (!collectAll()) {
        event.preventDefault();
        notify("Opslaan gestopt: controleer de ongeldige action params.");
      }
    });
    parse();
  });
})();
