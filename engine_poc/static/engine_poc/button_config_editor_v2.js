(() => {
  "use strict";

  const ACTIONS = [
    "", "screen_open", "screen_back", "list_up", "list_down",
    "list_left", "list_right", "list_select", "keypad_input"
  ];

  const deepClone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
  const slugify = (value) => String(value || "screen").toLowerCase().trim().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "screen";

  function defaultDisplay() {
    return {
      usemode: "softradio",
      default_screen_type: "detail",
      softkeys: { usemode: "disabled", default_color: "#e4e4e4", keys: {} }
    };
  }

  function defaultNavkeys() {
    return {
      usemode: "softradio",
      default_color: "#3a3d40",
      keys: {
        p1: {label_primary:{type:"text",value:"F1"},label_secondary:"Menu",action:"screen_open",action_params:{screen:"screen_list"},hw_key:"F1"},
        p2: {label_primary:{type:"text",value:"F2"},label_secondary:"Retour",action:"screen_back",action_params:{},hw_key:"F2"},
        p3: {label_primary:{type:"text",value:"F3"},label_secondary:"",action_params:{},hw_key:"F3"},
        p4: {label_primary:{type:"text",value:"F4"},label_secondary:"",action_params:{},hw_key:"F4"},
        up: {label_primary:{type:"icon",value:"keyboard_arrow_up"},action:"list_up",action_params:{},hw_key:"ArrowUp"},
        down: {label_primary:{type:"icon",value:"keyboard_arrow_down"},action:"list_down",action_params:{},hw_key:"ArrowDown"},
        left: {label_primary:{type:"icon",value:"keyboard_arrow_left"},action:"list_left",action_params:{},hw_key:"ArrowLeft"},
        right: {label_primary:{type:"icon",value:"keyboard_arrow_right"},action:"list_right",action_params:{},hw_key:"ArrowRight"},
        ok: {color:"#ffca28",label_primary:{type:"text",value:"OK"},label_secondary:"Selecteer",action:"list_select",action_params:{},hw_key:"Enter"}
      }
    };
  }

  function defaultKeyboard() {
    return {usemode:"disabled", layout:"none", default_color:"#3a3d40", keys:{}};
  }

  function defaultScreen(id) {
    return {
      type: "detail", title: id, primary: "", secondary: "",
      display: defaultDisplay(), navkeys: defaultNavkeys(), keyboard: defaultKeyboard()
    };
  }

  function readLabel(label) {
    if (label && typeof label === "object") return {type: label.type || "text", value: label.value ?? ""};
    return {type:"text", value: label ?? ""};
  }

  function initialize(root) {
    const textarea = root.querySelector("textarea");
    const screenList = root.querySelector("[data-bce-screen-list]");
    const editor = root.querySelector("[data-bce-screen-editor]");
    const empty = root.querySelector("[data-bce-empty]");
    const preview = root.querySelector("[data-bce-preview]");
    const message = root.querySelector("[data-bce-message]");
    let config = null;
    let activeId = null;

    function notify(text, type="error") {
      message.textContent = text;
      message.className = `bce-message ${type}`;
      message.hidden = false;
    }
    function clearMessage() { message.hidden = true; }

    function parse() {
      try {
        config = JSON.parse(textarea.value || "{}");
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("De configuratie moet een JSON-object zijn.");
        config.schema_version = 2;
        config.theme ||= {};
        config.screens ||= {};
        if (!config.initial_screen || !config.screens[config.initial_screen]) config.initial_screen = Object.keys(config.screens)[0] || "";
        activeId = config.initial_screen || Object.keys(config.screens)[0] || null;
        clearMessage();
        render();
      } catch (error) {
        config = null;
        notify(`JSON kan niet worden geladen: ${error.message}`);
      }
    }

    function sync() {
      textarea.value = JSON.stringify(config, null, 2);
      textarea.dispatchEvent(new Event("change", {bubbles:true}));
    }

    function ensureScreen(screen) {
      screen.type ||= "detail";
      screen.title ??= "";
      screen.primary ??= "";
      screen.secondary ??= "";
      screen.display ||= defaultDisplay();
      screen.display.softkeys ||= {usemode:"disabled", default_color:"#e4e4e4", keys:{}};
      screen.display.softkeys.keys ||= {};
      screen.navkeys ||= defaultNavkeys();
      screen.navkeys.keys ||= {};
      screen.keyboard ||= defaultKeyboard();
      screen.keyboard.keys ||= {};
      [screen.display.softkeys.keys, screen.navkeys.keys, screen.keyboard.keys].forEach(keys => {
        Object.values(keys || {}).forEach(key => delete key.usemode);
      });
      if (screen.type === "list") screen.list ||= {source:"screens", exclude_self:true, show_type:true, empty_text:"Geen schermen beschikbaar"};
      return screen;
    }

    function render() {
      renderScreenList();
      if (!activeId || !config.screens[activeId]) {
        editor.hidden = true;
        empty.hidden = false;
        preview.innerHTML = "";
        return;
      }
      empty.hidden = true;
      editor.hidden = false;
      const screen = ensureScreen(config.screens[activeId]);
      editor.innerHTML = screenEditorHtml(activeId, screen);
      bindScreenEditor(screen);
      renderPreview(screen);
      sync();
    }

    function renderScreenList() {
      const ids = Object.keys(config.screens);
      screenList.innerHTML = ids.map(id => {
        const screen = config.screens[id] || {};
        return `<button type="button" class="bce-screen-item ${id===activeId?"active":""}" data-screen-id="${esc(id)}">
          <span><strong>${esc(screen.title || id)}</strong><span class="bce-screen-meta">${esc(id)} · ${esc(screen.type || "detail")}</span></span>
          ${id===config.initial_screen?'<span class="bce-initial-badge">start</span>':""}
        </button>`;
      }).join("");
      screenList.querySelectorAll("[data-screen-id]").forEach(btn => btn.addEventListener("click", () => { activeId=btn.dataset.screenId; render(); }));
    }

    function input(name, value, label, type="text", extra="") {
      return `<div class="bce-field"><label>${esc(label)}</label><input type="${type}" data-field="${esc(name)}" value="${esc(value)}" ${extra}></div>`;
    }
    function checkbox(name, value, label) {
      return `<div class="bce-field"><label class="bce-inline"><input type="checkbox" data-field="${esc(name)}" ${value?"checked":""}> ${esc(label)}</label></div>`;
    }
    function select(name, value, label, options) {
      return `<div class="bce-field"><label>${esc(label)}</label><select data-field="${esc(name)}">${options.map(([v,t])=>`<option value="${esc(v)}" ${String(v)===String(value)?"selected":""}>${esc(t)}</option>`).join("")}</select></div>`;
    }

    function screenEditorHtml(id, screen) {
      return `
      <section class="bce-section"><h3>Scherm</h3><div class="bce-section-body">
        <div class="bce-grid three">
          ${input("screen_id", id, "Technische naam")}
          ${input("title", screen.title, "Titel")}
          ${select("type", screen.type, "Type", [["detail","Detail"],["list","Lijst"]])}
          ${input("primary", screen.primary, "Primaire tekst")}
          ${input("secondary", screen.secondary, "Secundaire tekst")}
          ${select("initial", id===config.initial_screen?"yes":"no", "Beginscherm", [["no","Nee"],["yes","Ja"]])}
        </div>
        <div class="bce-actions">
          <button type="button" class="button" data-action="duplicate-screen">Scherm dupliceren</button>
          <button type="button" class="button bce-danger" data-action="delete-screen">Scherm verwijderen</button>
        </div>
      </div></section>
      ${screen.type === "list" ? listSectionHtml(screen) : ""}
      ${groupSectionHtml("display", "Display", screen.display, false)}
      ${groupSectionHtml("softkeys", "Softkeys", screen.display.softkeys, false)}
      ${groupSectionHtml("navkeys", "Navigatietoetsen", screen.navkeys, false)}
      ${groupSectionHtml("keyboard", "Keyboard", screen.keyboard, true)}
      `;
    }

    function listSectionHtml(screen) {
      const list = screen.list || {};
      return `<section class="bce-section"><h3>Lijstinstellingen</h3><div class="bce-section-body"><div class="bce-grid">
        ${select("list.source", list.source || "screens", "Bron", [["screens","Alle schermen"],["items","Handmatige items"]])}
        ${input("list.empty_text", list.empty_text || "Geen items beschikbaar", "Tekst lege lijst")}
        ${checkbox("list.exclude_self", list.exclude_self !== false, "Huidig scherm uitsluiten")}
        ${checkbox("list.show_type", list.show_type !== false, "Schermtype tonen")}
      </div></div></section>`;
    }

    function groupSectionHtml(groupName, title, group, keyboard) {
      const keys = group.keys || {};
      const settings = groupName === "display" ? "" : `
        ${input(`${groupName}.default_color`, group.default_color || "#3a3d40", "Standaardkleur", "color")}
        ${keyboard ? select(`${groupName}.layout`, group.layout || "none", "Layout", [["none","Geen"],["3x4","3 × 4"],["2x1-3","2 × 1-3"],["custom","Aangepast"]]) : ""}`;
      const keyRows = groupName === "display" ? "" : Object.entries(keys).map(([keyId,key]) => keyRowHtml(groupName,keyId,key)).join("");
      return `<section class="bce-section"><h3>${esc(title)}</h3><div class="bce-section-body">
        <div class="bce-grid">${select(`${groupName}.usemode`, group.usemode || "softradio", "Gebruik", [["disabled","Niet gebruiken"],["softradio","Soft-radio"],["hardware","Hardware"],["display","Alleen display"]])}${settings}</div>
        ${groupName === "display" ? "" : `<div class="bce-actions"><button type="button" class="button" data-add-key="${esc(groupName)}">+ Toets</button></div>
        <div class="bce-key-table-wrap"><table class="bce-key-table">
          <thead><tr><th>Codekey</th><th>HW key</th><th>Action</th><th>Action params</th><th>Label type</th><th>Label value</th><th>Label secondary</th><th>Color</th></tr></thead>
          <tbody>${keyRows || '<tr><td colspan="8" class="bce-empty-row">Geen toetsen gedefinieerd.</td></tr>'}</tbody>
        </table></div>`}
      </div></section>`;
    }

    function keyRowHtml(groupName, keyId, key) {
      const label = readLabel(key.label_primary);
      const action = key.action || "";
      const params = JSON.stringify(key.action_params || {});
      const actionOptions = ACTIONS.map(a => `<option value="${esc(a)}" ${a===action?"selected":""}>${esc(a || "— geen actie —")}</option>`).join("");
      return `<tr data-key-row="${esc(groupName)}:${esc(keyId)}">
        <td><code class="bce-codekey">${esc(keyId.toUpperCase())}</code></td>
        <td><input type="text" data-field="key.${esc(groupName)}.${esc(keyId)}.hw_key" value="${esc(key.hw_key || "")}"></td>
        <td><select data-field="key.${esc(groupName)}.${esc(keyId)}.action">${actionOptions}</select></td>
        <td><textarea rows="2" data-field="key.${esc(groupName)}.${esc(keyId)}.action_params" spellcheck="false">${esc(params)}</textarea></td>
        <td><select data-field="key.${esc(groupName)}.${esc(keyId)}.label_type"><option value="text" ${label.type==="text"?"selected":""}>text</option><option value="icon" ${label.type==="icon"?"selected":""}>icon</option></select></td>
        <td><input type="text" data-field="key.${esc(groupName)}.${esc(keyId)}.label_value" value="${esc(label.value)}"></td>
        <td><input type="text" data-field="key.${esc(groupName)}.${esc(keyId)}.secondary" value="${esc(key.label_secondary || "")}"></td>
        <td><div class="bce-color-cell"><input type="color" data-field="key.${esc(groupName)}.${esc(keyId)}.color" value="${esc(key.color || groupDefaultColor(groupName))}"><input type="text" data-field="key.${esc(groupName)}.${esc(keyId)}.color" value="${esc(key.color || "")}" placeholder="standaard"></div></td>
      </tr>`;
    }

    function groupDefaultColor(groupName) {
      const screen = activeId && config?.screens?.[activeId];
      const group = groupName === "softkeys" ? screen?.display?.softkeys : screen?.[groupName];
      return group?.default_color || "#3a3d40";
    }

    function bindScreenEditor(screen) {
      editor.querySelectorAll("[data-field]").forEach(el => el.addEventListener("change", () => updateField(el, screen)));
      editor.querySelectorAll("[data-field][type=text]").forEach(el => el.addEventListener("input", () => updateField(el, screen, false)));
      editor.querySelector("[data-action='delete-screen']")?.addEventListener("click", deleteScreen);
      editor.querySelector("[data-action='duplicate-screen']")?.addEventListener("click", duplicateScreen);
      editor.querySelectorAll("[data-add-key]").forEach(btn => btn.addEventListener("click", () => addKey(btn.dataset.addKey, screen)));
    }

    function updateField(el, screen, rerender=true) {
      const name = el.dataset.field;
      const value = el.type === "checkbox" ? el.checked : el.value;
      if (name === "screen_id") {
        const newId = slugify(value);
        if (newId !== activeId && config.screens[newId]) return notify(`Scherm '${newId}' bestaat al.`);
        if (newId !== activeId) {
          const oldId = activeId;
          config.screens[newId] = config.screens[oldId]; delete config.screens[oldId]; activeId = newId;
          if (config.initial_screen === oldId) config.initial_screen = newId;
          Object.values(config.screens).forEach(s => [s.navkeys?.keys,s.keyboard?.keys,s.display?.softkeys?.keys].forEach(keys => Object.values(keys||{}).forEach(k => { if(k.action==="screen_open" && k.action_params?.screen===oldId) k.action_params.screen=newId; })));
        }
      } else if (name === "initial") {
        if (value === "yes") config.initial_screen = activeId;
      } else if (name.startsWith("list.")) {
        screen.list ||= {}; screen.list[name.split(".")[1]] = value;
      } else if (name.startsWith("key.")) {
        updateKeyField(name, value, screen);
      } else if (name.includes(".")) {
        const [group, prop] = name.split(".");
        const target = group === "softkeys" ? screen.display.softkeys : screen[group];
        target[prop] = value;
      } else {
        screen[name] = value;
        if (name === "type" && value === "list") screen.list ||= {source:"screens",exclude_self:true,show_type:true,empty_text:"Geen schermen beschikbaar"};
      }
      clearMessage(); sync(); renderPreview(screen); if (rerender && ["screen_id","type","initial"].includes(name)) render(); else renderScreenList();
    }

    function updateKeyField(name, value, screen) {
      const [, groupName, keyId, prop] = name.split(".");
      const group = groupName === "softkeys" ? screen.display.softkeys : screen[groupName];
      const key = group.keys[keyId];
      if (prop === "label_type") { key.label_primary = readLabel(key.label_primary); key.label_primary.type=value; }
      else if (prop === "label_value") { key.label_primary = readLabel(key.label_primary); key.label_primary.value=value; }
      else if (prop === "secondary") key.label_secondary=value;
      else if (prop === "action") {
        if (value) key.action=value; else delete key.action;
      }
      else if (prop === "action_params") {
        try {
          const parsed = JSON.parse(value || "{}");
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object verwacht");
          key.action_params = parsed;
          clearMessage();
        } catch (error) {
          notify(`Ongeldige action_params voor ${keyId.toUpperCase()}: ${error.message}`);
          return;
        }
      }
      else if (prop === "hw_key") key.hw_key=value;
      else if (prop === "color") { if(value) key.color=value; else delete key.color; }
    }

    function addKey(groupName, screen) {
      const group = groupName === "softkeys" ? screen.display.softkeys : screen[groupName];
      let base="key", i=1; while(group.keys[`${base}${i}`]) i++;
      group.keys[`${base}${i}`]={label_primary:{type:"text",value:`K${i}`},label_secondary:"",action_params:{},hw_key:""}; render();
    }
    function removeKey(spec, screen) { const [groupName,keyId]=spec.split(":"); const group=groupName==="softkeys"?screen.display.softkeys:screen[groupName]; if(confirm(`Toets '${keyId}' verwijderen?`)){delete group.keys[keyId];render();} }
    function deleteScreen() { if(!confirm(`Scherm '${activeId}' verwijderen?`)) return; delete config.screens[activeId]; const ids=Object.keys(config.screens); activeId=ids[0]||null; if(config.initial_screen && !config.screens[config.initial_screen]) config.initial_screen=activeId||""; render(); }
    function duplicateScreen() { let id=`${activeId}_copy`,i=2; while(config.screens[id]) id=`${activeId}_copy${i++}`; config.screens[id]=deepClone(config.screens[activeId]); config.screens[id].title=`${config.screens[id].title || activeId} kopie`; activeId=id; render(); }

    function renderPreview(screen) {
      const labelHtml = key => { const l=readLabel(key.label_primary); return `<span>${esc(l.value)}</span>${key.label_secondary?`<span class="secondary">${esc(key.label_secondary)}</span>`:""}`; };
      const navOrder=["p1","up","p2","left","ok","right","p3","down","p4"];
      const navKeys=["disabled","hardware"].includes(screen.navkeys?.usemode)?[]:navOrder.filter(k=>screen.navkeys?.keys?.[k]).map(k=>screen.navkeys.keys[k]);
      const kbKeys=["disabled","hardware"].includes(screen.keyboard?.usemode)?[]:Object.values(screen.keyboard?.keys||{});
      const softKeys=["disabled","hardware"].includes(screen.display?.softkeys?.usemode)?[]:Object.values(screen.display?.softkeys?.keys||{});
      preview.innerHTML=`<div class="bce-preview-display"><h4>${esc(screen.title)}</h4><div class="primary">${esc(screen.primary)}</div><div class="secondary">${esc(screen.secondary)}</div>${softKeys.length?`<div class="bce-preview-softkeys">${softKeys.map(k=>`<div class="bce-preview-softkey">${labelHtml(k)}</div>`).join("")}</div>`:""}</div>${navKeys.length?`<div class="bce-preview-nav">${navKeys.map(k=>`<div class="bce-preview-button" style="background:${esc(k.color||screen.navkeys.default_color||"#3a3d40")}">${labelHtml(k)}</div>`).join("")}</div>`:""}${kbKeys.length?`<div class="bce-preview-keyboard">${kbKeys.map(k=>`<div class="bce-preview-button" style="background:${esc(k.color||screen.keyboard.default_color||"#3a3d40")}">${labelHtml(k)}</div>`).join("")}</div>`:""}`;
    }

    root.querySelector("[data-bce-action='add-screen']").addEventListener("click", () => { if(!config)return; let id="nieuw_scherm",i=2;while(config.screens[id])id=`nieuw_scherm_${i++}`;config.screens[id]=defaultScreen(id);activeId=id;if(!config.initial_screen)config.initial_screen=id;render(); });
    root.querySelector("[data-bce-action='reload-json']").addEventListener("click", parse);
    root.querySelector("[data-bce-action='format-json']").addEventListener("click", () => { try { textarea.value=JSON.stringify(JSON.parse(textarea.value),null,2); notify("JSON is geformatteerd.","success"); } catch(e){notify(`Ongeldige JSON: ${e.message}`);} });
    textarea.form?.addEventListener("submit", () => { if(config) sync(); });
    parse();
  }

  document.addEventListener("DOMContentLoaded", () => document.querySelectorAll("[data-button-config-editor]").forEach(initialize));
})();
