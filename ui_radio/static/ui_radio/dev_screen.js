"use strict";

/* =========================================================
   WERKELIJKE MOBIELE VIEWPORT
   visualViewport sluit de adres-/navigatiebalk van mobiele browsers uit.
   ========================================================= */
function updateVisibleViewportCss() {
    const viewport = window.visualViewport;
    const width = Math.max(1, Math.round(viewport?.width || document.documentElement.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(viewport?.height || document.documentElement.clientHeight || window.innerHeight));

    document.documentElement.style.setProperty("--app-viewport-width", `${width}px`);
    document.documentElement.style.setProperty("--app-viewport-height", `${height}px`);
}

function bindVisibleViewportUpdates(callback) {
    const refresh = () => {
        updateVisibleViewportCss();
        if (typeof callback === "function") {
            window.requestAnimationFrame(callback);
        }
    };

    window.addEventListener("resize", refresh, { passive: true });
    window.addEventListener("orientationchange", refresh, { passive: true });

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", refresh, { passive: true });
        window.visualViewport.addEventListener("scroll", refresh, { passive: true });
    }

    refresh();
}


const DEV_INSPECTION_MODE = new URLSearchParams(window.location.search).get("inspection") === "1";

/* Portrait-layout is leidend; geen orientation-specifieke logica. */

/*
 * De pagina gebruikt window.RADIO_UI_CONFIG wanneer die vóór dit bestand
 * wordt ingesteld. Zonder externe configuratie wordt DEFAULT_RADIO_CONFIG
 * gebruikt.
 */
const DEFAULT_RADIO_CONFIG = {
    schema_version: 2,

    /*
     * Alle gedefinieerde displays staan onder screens.
     * - detail: bestaand scherm met primary/secondary tekst
     * - list: toont automatisch alle schermen uit deze configuratie
     */
    screens: {
        main: {
            usemode: "visible",
            type: "detail",
            title: "Radio 1",
            primary: "Catering 1",
            secondary: ".."
        },
        menu: {
            usemode: "visible",
            type: "list",
            title: "MENU",
            source: "screens"
        },
        status: {
            usemode: "visible",
            type: "detail",
            title: "STATUS",
            primary: "Beschikbaar",
            secondary: "Netwerk OK"
        }
    },
    initial_screen: "menu",

    display: {
        usemode: "visible",
        active: true,
        default_color: "#e2e2e2",
        softkeys: {
            usemode: "visible",
            active: true,
            default_color: "#e2e2e2",
            keys: {
                sk1: {
                    label_primary: { type: "text", value: "Terug" },
                    action: "screen_back"
                },
                sk2: {
                    label_primary: { type: "icon", value: "home" },
                    action: "screen_open",
                    action_params: { screen: "main" },
                    color: "#f6c945"
                },
                sk3: {
                    label_primary: { type: "text", value: "Menu" },
                    action: "screen_open",
                    action_params: { screen: "menu" }
                }
            }
        }
    },
    navkeys: {
        usemode: "visible",
        active: true,
        default_color: "#303336",
        keys: {
            p1: { label_primary: "P1", action: "none", hwkey: "F1" },
            p2: { label_primary: "P2", action: "none", hwkey: "F2" },
            p3: { label_primary: "P3", action: "none", hwkey: "F3" },
            p4: { label_primary: "P4", action: "none", hwkey: "F4" },
            up: { label_primary: { type: "icon", value: "keyboard_arrow_up" }, action: "selection_up", hwkey: "ArrowUp" },
            left: { label_primary: { type: "icon", value: "keyboard_arrow_left" }, action: "screen_back", hwkey: "ArrowLeft" },
            ok: { label_primary: "OK", action: "selection_select", hwkey: "Enter", color: "#3078c8" },
            right: { label_primary: { type: "icon", value: "keyboard_arrow_right" }, action: "selection_select", hwkey: "ArrowRight" },
            down: { label_primary: { type: "icon", value: "keyboard_arrow_down" }, action: "selection_down", hwkey: "ArrowDown" }
        }
    },
    keyboard: {
        usemode: "visible",
        active: true,
        format: "2x1-3",
        default_color: "#303336",
        keys: {
            a: { label_primary: "A", action: "none", hwkey: "a", color: "#b3261e" },
            b: { label_primary: "B", action: "none", hwkey: "b" },
            c: { label_primary: { type: "icon", value: "call" }, action: "none", hwkey: "c", color: "#2e7d32" },
            d: { label_primary: "D", action: "none", hwkey: "d" }
        }
    },
    softradio: {
        usemode: "visible",
        layout: "1x3",
        default_color: "#303336",
        keys: {
            sr1: { label_primary: { type: "text", value: "SR1" }, action: "none", action_params: {} },
            sr2: { label_primary: { type: "text", value: "SR2" }, action: "none", action_params: {} },
            sr3: { label_primary: { type: "text", value: "SR3" }, action: "none", action_params: {} }
        }
    }
};

const LIMITS = {
    header: 20,
    displayPrimary: 20,
    displaySecondary: 40,
    softkey: 10
};

const TEXT_REFERENCE = {
    header: 30,
    displayPrimary: 10,
    softkey: 8
};

const BUILTIN_KEY_ORDER = {
    "3x4": ["1", "2", "3", "4", "5", "6", "7", "8", "9", "star", "0", "hash"],
    "2x1-3": ["a", "b", "c", "d"]
};

const SOFTRADIO_KEY_ORDER = {
    "1x1": ["sr1"],
    "1x2": ["sr1", "sr2"],
    "1x3": ["sr1", "sr2", "sr3"]
};

const screenState = {
    current: null,
    history: [],
    selectedIndex: 0
};

let fitFrame = null;

function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Element #${id} ontbreekt.`);
    return element;
}

function truncate(value, length) {
    return String(value ?? "").slice(0, length);
}

function readEmbeddedButtonConfig() {
    const element = document.getElementById("button-config");
    if (!element) return null;

    try {
        const config = JSON.parse(element.textContent);
        return config && typeof config === "object" ? config : null;
    } catch (error) {
        console.error("Screen.config bevat ongeldige JSON.", error);
        return null;
    }
}

const EMBEDDED_RADIO_CONFIG = readEmbeddedButtonConfig();

const KEYBOARD_KEY_ALIASES = {
    kb0: "0", kb1: "1", kb2: "2", kb3: "3", kb4: "4",
    kb5: "5", kb6: "6", kb7: "7", kb8: "8", kb9: "9",
    kbstar: "star", kbhash: "hash"
};

const KEYBOARD_CANONICAL_TO_LEGACY = Object.fromEntries(
    Object.entries(KEYBOARD_KEY_ALIASES).map(([legacyId, canonicalId]) => [canonicalId, legacyId])
);

function normalizeKeyboardObject(keyboard) {
    if (!keyboard || typeof keyboard !== "object" || !keyboard.keys || typeof keyboard.keys !== "object") return;
    for (const [legacyId, canonicalId] of Object.entries(KEYBOARD_KEY_ALIASES)) {
        if (!keyboard.keys[canonicalId] && keyboard.keys[legacyId]) {
            keyboard.keys[canonicalId] = keyboard.keys[legacyId];
        }
    }
}

function normalizeKeyboardKeyIds(config) {
    if (!config || typeof config !== "object") return config;

    // Legacy/root-configuraties.
    normalizeKeyboardObject(config.keyboard);

    // Productie- en previewconfiguraties bevatten de bediening per Screen.
    for (const screen of Object.values(config.screens ?? {})) {
        normalizeKeyboardObject(screen?.keyboard);
    }

    return config;
}

function keyboardKeyConfig(keys, keyId) {
    if (!keys || typeof keys !== "object") return null;
    return keys[keyId] ?? keys[KEYBOARD_CANONICAL_TO_LEGACY[keyId]] ?? null;
}

function getConfig() {
    return normalizeKeyboardKeyIds(window.RADIO_UI_CONFIG ?? EMBEDDED_RADIO_CONFIG ?? DEFAULT_RADIO_CONFIG);
}

function normalizeHexColor(color, fallback = "#303336") {
    if (typeof color !== "string") return fallback;
    const value = color.trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) {
        return `#${value.slice(1).split("").map((part) => part + part).join("")}`;
    }
    return fallback;
}

function srgbToLinear(channel) {
    const value = channel / 255;
    return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hexColor) {
    const hex = normalizeHexColor(hexColor).slice(1);
    const red = srgbToLinear(parseInt(hex.slice(0, 2), 16));
    const green = srgbToLinear(parseInt(hex.slice(2, 4), 16));
    const blue = srgbToLinear(parseInt(hex.slice(4, 6), 16));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first, second) {
    const lighter = Math.max(first, second);
    const darker = Math.min(first, second);
    return (lighter + 0.05) / (darker + 0.05);
}

function getContrastColor(backgroundColor) {
    const luminance = relativeLuminance(backgroundColor);
    return contrastRatio(1, luminance) >= contrastRatio(luminance, 0)
        ? "#ffffff"
        : "#000000";
}

function resolveButtonColor(keyConfig = {}, groupConfig = {}) {
    return normalizeHexColor(keyConfig.color ?? groupConfig.default_color, "#303336");
}

function applyButtonColors(button, keyConfig, groupConfig) {
    const background = resolveButtonColor(keyConfig, groupConfig);
    button.style.setProperty("--key-background", background);
    button.style.setProperty("--key-foreground", getContrastColor(background));
}

function normalizeLabel(label) {
    if (typeof label === "string" || typeof label === "number") {
        return { type: "text", value: String(label) };
    }
    if (label && typeof label === "object") {
        return {
            type: label.type === "icon" ? "icon" : "text",
            value: String(label.value ?? "")
        };
    }
    return { type: "text", value: "" };
}

function createLabelElement(label, className) {
    const normalized = normalizeLabel(label);
    const element = document.createElement("span");
    element.className = className;
    if (normalized.type === "icon") {
        element.classList.add("material-symbols-outlined", "key-icon");
        element.setAttribute("aria-hidden", "true");
    }
    element.textContent = normalized.value;
    return element;
}


/*
 * Usemode heeft nog maar twee standen:
 * - visible: sectie wordt in de radio getoond
 * - hidden: sectie wordt niet in de radio getoond
 *
 * Oude waarden blijven als leescompatibiliteit ondersteund:
 * softradio/display -> visible, disabled/hardware -> hidden.
 */
function normalizeUsemode(config, fallback = "visible") {
    // In de rechter dev-inspectie tonen we alle secties, ongeacht usemode/active.
    if (DEV_INSPECTION_MODE) return "visible";
    if (config?.active === false) return "hidden";

    const value = String(config?.usemode ?? fallback).trim().toLowerCase();
    if (["visible", "softradio", "display"].includes(value)) return "visible";
    if (["hidden", "disabled", "hardware"].includes(value)) return "hidden";
    return fallback;
}

function isVisibleElement(config, fallback = "visible") {
    return normalizeUsemode(config, fallback) === "visible";
}
function configureButton(button, keyId, keyConfig, groupConfig) {
    button.dataset.key = keyId;
    const shortAction = keyConfig.short_action ?? keyConfig.action ?? "none";
    const shortParams = keyConfig.short_action_params ?? keyConfig.action_params ?? {};
    const longAction = keyConfig.long_action ?? "";
    const longParams = keyConfig.long_action_params ?? {};
    button.dataset.shortAction = shortAction;
    button.dataset.shortActionParams = JSON.stringify(shortParams);
    button.dataset.longAction = longAction;
    button.dataset.longActionParams = JSON.stringify(longParams);
    // Legacy datasets blijven beschikbaar voor oudere debugtools.
    button.dataset.action = shortAction;
    button.dataset.actionParams = JSON.stringify(shortParams);
    const hasAction = [shortAction, longAction].some((action) => String(action || "").trim() && action !== "none");
    button.disabled = !hasAction;
    button.classList.toggle("is-disabled", button.disabled);
    button.setAttribute("aria-disabled", button.disabled ? "true" : "false");
    const hardwareKey = keyConfig.hw_key ?? keyConfig.hwkey;
    if (hardwareKey) button.dataset.hwkey = hardwareKey;
    applyButtonColors(button, keyConfig, groupConfig);
    const label = normalizeLabel(keyConfig.label_primary);
    button.setAttribute("aria-label", label.value || keyId);
}

/* Geeft een compacte lijst terug van alle schermen in de JSON. */
function getDefinedScreens(config = getConfig()) {
    return Object.entries(config.screens ?? {}).map(([id, screen]) => ({
        id,
        type: screen.type ?? "detail",
        title: screen.title ?? id,
        screen
    }));
}

/* Publieke helper: bruikbaar vanuit andere scripts of de browserconsole. */
window.getDefinedScreens = getDefinedScreens;

function getCurrentScreen(config = getConfig()) {
    return config.screens?.[screenState.current] ?? null;
}

/*
 * Schermspecifieke bediening heeft voorrang op de root-configuratie.
 * Rootvelden blijven als compatibiliteitsfallback beschikbaar voor oudere JSON.
 */
function getActiveUiConfig(config = getConfig(), screen = getCurrentScreen(config)) {
    return {
        ...config,
        display: screen?.display ?? config.display ?? {},
        navkeys: screen?.navkeys ?? config.navkeys ?? {},
        keyboard: screen?.keyboard ?? config.keyboard ?? {},
        softradio: screen?.softradio ?? config.softradio ?? null,
        topkeys: screen?.topkeys ?? config.topkeys ?? {},
        leftkeys: screen?.leftkeys ?? config.leftkeys ?? {},
        rightkeys: screen?.rightkeys ?? config.rightkeys ?? {},
        screenUsemode: normalizeUsemode(screen)
    };
}

function renderDetailScreen(screen) {
    byId("detail-screen").hidden = false;
    byId("list-screen").hidden = true;
    byId("radio-name").textContent = truncate(screen.title ?? "", LIMITS.header);
    byId("channel-name").textContent = truncate(screen.primary ?? "", LIMITS.displayPrimary);
    byId("feedback-text").textContent = truncate(screen.secondary ?? "", LIMITS.displaySecondary);
}

function renderScreenList(config, screen) {
    const detail = byId("detail-screen");
    const listScreen = byId("list-screen");
    const host = byId("screen-list");

    detail.hidden = true;
    listScreen.hidden = false;
    byId("radio-name").textContent = truncate(screen.title ?? "MENU", LIMITS.header);
    host.replaceChildren();

    // Ondersteunt zowel de oude vlakke lijstconfiguratie als:
    // screen.list = { source: "screens", items: [...] }
    const listConfig = screen.list ?? screen;
    const items = listConfig.source === "screens"
        ? getDefinedScreens(config).filter((item) => item.id !== screenState.current)
        : (listConfig.items ?? []).map((item, index) => ({
            id: item.screen ?? item.id ?? `item-${index}`,
            type: item.type ?? "detail",
            title: item.label ?? item.title ?? item.screen ?? item.id ?? `Item ${index + 1}`,
            screen: item
        }));

    if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "screen-list-empty";
        empty.textContent = (screen.list ?? screen).empty_text ?? "Geen schermen gedefinieerd";
        host.appendChild(empty);
        screenState.selectedIndex = 0;
        return;
    }

    screenState.selectedIndex = Math.max(0, Math.min(screenState.selectedIndex, items.length - 1));

    items.forEach((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "screen-list-item";
        button.dataset.screenId = item.id;
        button.dataset.listIndex = String(index);
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", index === screenState.selectedIndex ? "true" : "false");
        if (index === screenState.selectedIndex) button.classList.add("is-selected");

        const label = document.createElement("span");
        label.className = "screen-list-item-label";
        label.textContent = item.title;

        const type = document.createElement("span");
        type.className = "screen-list-item-type";
        type.textContent = item.type;

        button.append(label, type);
        host.appendChild(button);
    });

    ensureSelectedListItemVisible();
}

function applyDynamicLayout(config) {
    const device = byId("radio-device");
    const displaySection = byId("display-section");
    const navigationSection = byId("navigation-section");
    const keypadSection = byId("keypad-section");
    const softradioSection = byId("softradio-section");
    const radioScreen = byId("radio-screen");
    const softkeyPanel = byId("softkey-panel");
    const leftColumn = device ? device.querySelector(".radio-column-left") : null;
    const rightColumn = device ? device.querySelector(".radio-column-right") : null;

    /* Landscape-kolommen bestaan alleen wanneer minstens één area in die
       kolom zichtbaar is. Is één hele kolom leeg, dan gebruikt de andere
       kolom automatisch de volledige radio-area als éénkoloms-layout. */
    const leftColumnVisible = !displaySection.hidden || !navigationSection.hidden;
    const rightColumnVisible = !keypadSection.hidden || !softradioSection.hidden;
    if (leftColumn) leftColumn.hidden = !leftColumnVisible;
    if (rightColumn) rightColumn.hidden = !rightColumnVisible;
    if (device) {
        device.classList.toggle(
            "radio-single-column",
            leftColumnVisible !== rightColumnVisible
        );
    }

    const rows = [];
    // Basisverhouding wanneer alle secties zichtbaar zijn: 30 / 20 / 40 / 10.
    // Door alleen zichtbare rijen toe te voegen, wordt vrijgekomen ruimte
    // automatisch naar verhouding over de resterende secties verdeeld.
    if (!displaySection.hidden) rows.push("minmax(0, 30fr)");
    if (!navigationSection.hidden) rows.push("minmax(0, 20fr)");
    if (!keypadSection.hidden) rows.push("minmax(0, 40fr)");
    if (!softradioSection.hidden) rows.push("minmax(0, 10fr)");

    device.style.setProperty(
        "--device-rows",
        rows.length ? rows.join(" ") : "minmax(0, 1fr)"
    );

    // In landscape worden dezelfde vier areas uitsluitend anders gegroepeerd:
    // links DISPLAY / NAVIGATION = 32 / 20, rechts KEYPAD / SOFTRADIO = 32 / 8.
    // Alleen zichtbare secties tellen mee, zodat elke kolom zijn volledige hoogte gebruikt
    // en de oorspronkelijke onderlinge verhouding behoudt.
    const leftRows = [];
    if (!displaySection.hidden) leftRows.push("minmax(0, 32fr)");
    if (!navigationSection.hidden) leftRows.push("minmax(0, 20fr)");
    device.style.setProperty(
        "--left-device-rows",
        leftRows.length ? leftRows.join(" ") : "minmax(0, 1fr)"
    );

    const rightRows = [];
    if (!keypadSection.hidden) rightRows.push("minmax(0, 32fr)");
    if (!softradioSection.hidden) rightRows.push("minmax(0, 8fr)");
    device.style.setProperty(
        "--right-device-rows",
        rightRows.length ? rightRows.join(" ") : "minmax(0, 1fr)"
    );

    // Wanneer softkeys ontbreken, verdelen header en scherminhoud de
    // vrijgekomen ruimte volgens hun oorspronkelijke verhouding 14:70.
    radioScreen.style.setProperty(
        "--display-rows",
        softkeyPanel.hidden
            ? "minmax(0, 14fr) minmax(0, 70fr)"
            : "minmax(0, 14fr) minmax(0, 70fr) minmax(0, 16fr)"
    );
}

function renderCurrentScreen(config = getConfig()) {
    const screen = getCurrentScreen(config);
    if (!screen) {
        const first = getDefinedScreens(config)[0];
        if (!first) return;
        screenState.current = first.id;
        return renderCurrentScreen(config);
    }

    const activeUiConfig = getActiveUiConfig(config, screen);
    const screenActive = normalizeUsemode(screen) === "visible";
    const displayActive = screenActive && isVisibleElement(activeUiConfig.display);

    // Ook een leeg displayblok reserveert zijn 30fr zolang usemode=visible.
    // De inhoud van title/primary/secondary bepaalt niet de layout-hoogte.
    byId("display-section").hidden = !displayActive;
    byId("display-section").classList.toggle("is-empty-section", false);
    byId("detail-screen").hidden = !displayActive;
    byId("list-screen").hidden = !displayActive;
    if (displayActive) {
        if (screen.type === "list") renderScreenList(config, screen);
        else renderDetailScreen(screen);
    }

    // Knoppen kunnen per scherm verschillen en moeten daarom bij iedere
    // schermwissel opnieuw worden opgebouwd.
    renderSoftkeys(activeUiConfig);
    renderNavigation(activeUiConfig);
    renderKeypad(activeUiConfig);
    renderSoftradio(activeUiConfig);
    renderExternalKeys(activeUiConfig);
    applyDynamicLayout(activeUiConfig);

    scheduleFit();
    document.dispatchEvent(new CustomEvent("ui_radio:screen", {
        detail: { id: screenState.current, screen }
    }));
}

function openScreen(screenId, { remember = true } = {}) {
    bindVisibleViewportUpdates(() => {
        if (!DEV_INSPECTION_MODE) fitDevViewerToStage();
        scheduleFit();
    });

    const config = getConfig();
    if (!config.screens?.[screenId]) return false;

    if (remember && screenState.current && screenState.current !== screenId) {
        screenState.history.push(screenState.current);
    }

    screenState.current = screenId;
    screenState.selectedIndex = 0;
    renderCurrentScreen(config);
    return true;
}

function goBack() {
    const previous = screenState.history.pop();
    if (!previous) return false;
    screenState.current = previous;
    screenState.selectedIndex = 0;
    renderCurrentScreen();
    return true;
}

function getListButtons() {
    return Array.from(document.querySelectorAll("#screen-list .screen-list-item"));
}

function ensureSelectedListItemVisible() {
    const selected = document.querySelector("#screen-list .screen-list-item.is-selected");
    selected?.scrollIntoView({ block: "nearest" });
}

function selectListIndex(nextIndex) {
    const buttons = getListButtons();
    if (!buttons.length) return;
    screenState.selectedIndex = (nextIndex + buttons.length) % buttons.length;
    buttons.forEach((button, index) => {
        const selected = index === screenState.selectedIndex;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-selected", selected ? "true" : "false");
    });
    ensureSelectedListItemVisible();
}

function openSelectedListItem() {
    const button = getListButtons()[screenState.selectedIndex];
    return button ? openScreen(button.dataset.screenId) : false;
}


/*
 * Externe hardwaretoetsen rond de radio.
 *
 * JSON per Screen:
 *   topkeys.keys   -> TK1, TK2, TK7, TK3, TK4, TK8, TK5, TK6
 *   leftkeys.keys  -> TL1 t/m TL6
 *   rightkeys.keys -> TR1 t/m TR6
 *
 * Niet gedefinieerde keys worden niet aangemaakt en reserveren dus geen ruimte.
 */
const EXTERNAL_KEY_ORDER = {
    topkeys: ["tk1", "tk2", "tk7", "tk3", "tk4", "tk8", "tk5", "tk6"],
    leftkeys: ["tl1", "tl2", "tl3", "tl4", "tl5", "tl6"],
    rightkeys: ["tr1", "tr2", "tr3", "tr4", "tr5", "tr6"]
};

function externalKeyLabel(keyId, keyConfig = {}) {
    const label = normalizeLabel(keyConfig.label_primary);
    if (label.value) return keyConfig.label_primary;
    return { type: "text", value: keyId.toUpperCase() };
}

function createExternalPushButton(groupName, keyId, keyConfig, groupConfig) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `external-key external-${groupName}-key`;
    configureButton(button, `${groupName}.${keyId}`, keyConfig, groupConfig);
    button.appendChild(createLabelElement(externalKeyLabel(keyId, keyConfig), "key-primary"));

    const secondary = document.createElement("span");
    secondary.className = "key-secondary";
    secondary.textContent = keyConfig.label_secondary ?? "";
    button.appendChild(secondary);
    return button;
}

function createRotaryKey(groupName, keyId, keyConfig, groupConfig) {
    const rotary = document.createElement("div");
    rotary.className = "rotary-key";
    rotary.dataset.key = `${groupName}.${keyId}`;
    applyButtonColors(rotary, keyConfig, groupConfig);

    const label = createLabelElement(externalKeyLabel(keyId, keyConfig), "rotary-label");
    rotary.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "rotary-controls";

    const steps = [
        {
            direction: "counter_clockwise",
            icon: "rotate_left",
            hwkey: keyConfig.hw_key_counter_clockwise ?? keyConfig.hw_key_ccw,
            shortAction: keyConfig.short_action_counter_clockwise ?? keyConfig.action_counter_clockwise ?? keyConfig.action ?? "none",
            shortParams: {
                ...(keyConfig.short_action_params_counter_clockwise ?? keyConfig.action_params_counter_clockwise ?? keyConfig.action_params ?? {}),
                direction: "counter_clockwise"
            },
            longAction: keyConfig.long_action_counter_clockwise ?? "",
            longParams: {
                ...(keyConfig.long_action_params_counter_clockwise ?? {}),
                direction: "counter_clockwise"
            }
        },
        {
            direction: "clockwise",
            icon: "rotate_right",
            hwkey: keyConfig.hw_key_clockwise ?? keyConfig.hw_key_cw,
            shortAction: keyConfig.short_action_clockwise ?? keyConfig.action_clockwise ?? keyConfig.action ?? "none",
            shortParams: {
                ...(keyConfig.short_action_params_clockwise ?? keyConfig.action_params_clockwise ?? keyConfig.action_params ?? {}),
                direction: "clockwise"
            },
            longAction: keyConfig.long_action_clockwise ?? "",
            longParams: {
                ...(keyConfig.long_action_params_clockwise ?? {}),
                direction: "clockwise"
            }
        }
    ];

    for (const step of steps) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `rotary-step rotary-${step.direction}`;
        button.dataset.key = `${groupName}.${keyId}.${step.direction}`;
        button.dataset.shortAction = step.shortAction;
        button.dataset.shortActionParams = JSON.stringify(step.shortParams);
        button.dataset.longAction = step.longAction;
        button.dataset.longActionParams = JSON.stringify(step.longParams);
        button.dataset.action = step.shortAction;
        button.dataset.actionParams = JSON.stringify(step.shortParams);
        button.disabled = ![step.shortAction, step.longAction].some((action) => String(action || "").trim() && action !== "none");
        button.setAttribute("aria-disabled", button.disabled ? "true" : "false");
        button.setAttribute("aria-label", `${keyId.toUpperCase()} ${step.direction}`);
        if (step.hwkey) {
            button.dataset.hwkey = String(step.hwkey);
            button.dataset.rotaryDirection = step.direction;
        }
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined key-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = step.icon;
        button.appendChild(icon);
        controls.appendChild(button);
    }

    rotary.appendChild(controls);
    return rotary;
}


function normalizeExternalGroupKeys(groupName, groupConfig = {}) {
    const group = { ...groupConfig };
    const sourceKeys = groupConfig?.keys ?? {};
    const keys = {};

    for (const [rawId, rawConfig] of Object.entries(sourceKeys)) {
        let keyId = String(rawId).toLowerCase();
        if (groupName === "topkeys") {
            if (keyId === "tr1") keyId = "tk7";
            if (keyId === "tr2") keyId = "tk8";
        }

        const keyConfig = rawConfig && typeof rawConfig === "object" ? { ...rawConfig } : rawConfig;
        if (groupName === "topkeys" && (keyId === "tk7" || keyId === "tk8") && keyConfig && typeof keyConfig === "object") {
            keyConfig.type = "rotary";
            const label = normalizeLabel(keyConfig.label_primary);
            if (!label.value || ["TR1", "TR2", "TK7", "TK8"].includes(String(label.value).toUpperCase())) {
                keyConfig.label_primary = { ...label, value: keyId.toUpperCase() };
            }
        }
        keys[keyId] = keyConfig;
    }

    group.keys = keys;
    return group;
}

function renderExternalGroup(hostId, groupName, groupConfig) {
    const host = byId(hostId);
    host.replaceChildren();
    groupConfig = normalizeExternalGroupKeys(groupName, groupConfig);

    // Disabled betekent in de echte viewer: niet tonen.
    if (normalizeUsemode(groupConfig) === "hidden") {
        host.hidden = true;
        return;
    }

    const keys = groupConfig?.keys ?? {};
    const preferredOrder = EXTERNAL_KEY_ORDER[groupName] ?? [];
    const orderedIds = [
        ...preferredOrder.filter((keyId) => Object.hasOwn(keys, keyId)),
        ...Object.keys(keys).filter((keyId) => !preferredOrder.includes(keyId))
    ];

    for (const keyId of orderedIds) {
        const keyConfig = keys[keyId];
        if (!keyConfig || normalizeUsemode(keyConfig) === "hidden") continue;

        const isRotary = groupName === "topkeys" && (
            keyConfig.type === "rotary" ||
            keyId === "tk7" ||
            keyId === "tk8" ||
            keyConfig.hw_key_clockwise ||
            keyConfig.hw_key_counter_clockwise ||
            keyConfig.hw_key_cw ||
            keyConfig.hw_key_ccw
        );

        host.appendChild(
            isRotary
                ? createRotaryKey(groupName, keyId, keyConfig, groupConfig)
                : createExternalPushButton(groupName, keyId, keyConfig, groupConfig)
        );
    }

    host.hidden = host.childElementCount === 0;
}

function renderExternalKeys(config) {
    renderExternalGroup("external-top-keys", "topkeys", config.topkeys ?? {});
    renderExternalGroup("external-left-keys", "leftkeys", config.leftkeys ?? {});
    renderExternalGroup("external-right-keys", "rightkeys", config.rightkeys ?? {});

    // Ook complete lege zijden reserveren geen ruimte. De radio krijgt die
    // ruimte automatisch terug, zonder de interne radio-layout te wijzigen.
    const shell = byId("dev-hardware-shell");
    const topVisible = !byId("external-top-keys").hidden;
    const leftVisible = !byId("external-left-keys").hidden;
    const rightVisible = !byId("external-right-keys").hidden;
    const centerWeight = 78 + (leftVisible ? 0 : 11) + (rightVisible ? 0 : 11);

    shell.style.gridTemplateColumns = [
        leftVisible ? "minmax(4.5rem, 11fr)" : "0",
        `minmax(0, ${centerWeight}fr)`,
        rightVisible ? "minmax(4.5rem, 11fr)" : "0"
    ].join(" ");
    shell.style.gridTemplateRows = topVisible
        ? "minmax(4rem, 10fr) minmax(0, 90fr)"
        : "0 minmax(0, 100fr)";
}

function renderSoftkeys(config) {
    const panel = byId("softkey-panel");
    const softkeys = config.display?.softkeys;
    const visible = config.screenUsemode === "visible"
        && isVisibleElement(config.display)
        && isVisibleElement(softkeys);
    panel.hidden = !visible;
    panel.replaceChildren();
    if (!visible) return;

    for (const [keyId, keyConfig] of Object.entries(softkeys.keys ?? {})) {
        if (!isVisibleElement(keyConfig)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "softkey";
        configureButton(button, keyId, keyConfig, softkeys);
        button.appendChild(createLabelElement(keyConfig.label_primary, "softkey-label"));
        panel.appendChild(button);
    }
    panel.style.setProperty("--softkey-count", String(Math.max(1, panel.children.length)));
}

function renderNavigation(config) {
    const section = byId("navigation-section");
    const host = byId("navigation-grid");
    const nav = config.navkeys;
    const visible = isVisibleElement(nav);
    section.hidden = !visible;
    host.replaceChildren();
    section.classList.toggle("is-empty-section", visible);
    if (!visible) return;

    const keys = nav?.keys ?? {};
    for (const id of ["p1", "p2", "p3", "p4"]) {
        const keyConfig = keys[id];
        if (!keyConfig || !isVisibleElement(keyConfig)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `radio-button function-key ${id}`;
        configureButton(button, id, keyConfig, nav);
        button.appendChild(createLabelElement(keyConfig.label_primary, "key-primary"));
        const secondary = document.createElement("span");
        secondary.className = "key-secondary";
        secondary.textContent = keyConfig.label_secondary ?? "";
        button.appendChild(secondary);
        host.appendChild(button);
    }

    const directionPad = document.createElement("div");
    directionPad.className = "direction-pad";
    directionPad.setAttribute("aria-label", "Navigatie");
    for (const id of ["up", "left", "ok", "right", "down"]) {
        const keyConfig = keys[id];
        if (!keyConfig || !isVisibleElement(keyConfig)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `direction-button nav-${id}`;
        configureButton(button, id, keyConfig, nav);
        button.appendChild(createLabelElement(keyConfig.label_primary, "nav-label"));
        directionPad.appendChild(button);
    }
    host.appendChild(directionPad);
    if (host.querySelector("button")) {
        section.classList.remove("is-empty-section");
    }
}

function renderKeypad(config) {
    const section = byId("keypad-section");
    const host = byId("keypad-host");
    const keyboard = config.keyboard;
    const visible = isVisibleElement(keyboard);
    const layout = keyboard?.format ?? keyboard?.layout ?? "3x4";

    /*
     * De usemode van het blok bepaalt UITSLUITEND of de sectie ruimte krijgt.
     * Een zichtbaar keyboard reserveert dus altijd zijn 40fr, ook wanneer:
     * - keys leeg is;
     * - geen enkele key zichtbaar is;
     * - layout "none" is.
     *
     * De inhoud bepaalt alleen wat er binnen dat gereserveerde vlak staat.
     */
    section.hidden = !visible;
    host.replaceChildren();
    host.dataset.keypadLayout = layout;
    section.classList.toggle("is-empty-section", visible);
    if (!visible) return;

    if (layout === "none") return;

    const keypad = document.createElement("div");
    keypad.className = `keypad keypad-${layout}`;
    const keys = keyboard?.keys ?? {};
    const order = BUILTIN_KEY_ORDER[layout] ?? Object.keys(keys);

    for (const keyId of order) {
        const keyConfig = keyboardKeyConfig(keys, keyId);
        if (!keyConfig || !isVisibleElement(keyConfig)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `keypad-button key-${keyId}`;
        configureButton(button, keyId, keyConfig, keyboard);
        button.appendChild(createLabelElement(keyConfig.label_primary, "key-primary"));
        const secondary = document.createElement("span");
        secondary.className = "key-secondary";
        secondary.textContent = keyConfig.label_secondary ?? "";
        button.appendChild(secondary);
        keypad.appendChild(button);
    }

    if (keypad.childElementCount) {
        section.classList.remove("is-empty-section");
        host.appendChild(keypad);
    }
}

function renderSoftradio(config) {
    const section = byId("softradio-section");
    const host = byId("softradio-host");
    const softradio = config.softradio;

    // Links tonen we de sectie alleen wanneer deze werkelijk bestaat en
    // zichtbaar staat. Rechts (inspection=1) tonen we de volledige radio,
    // ook wanneer de sectie hidden of nog niet gedefinieerd is.
    const exists = softradio && typeof softradio === "object";
    const visible = DEV_INSPECTION_MODE ? true : (exists && isVisibleElement(softradio));
    section.hidden = !visible;
    host.replaceChildren();
    section.classList.toggle("is-empty-section", visible);
    if (!visible) return;

    const group = exists ? softradio : { usemode: "hidden", layout: "1x3", default_color: "#303336", keys: {} };
    const layout = ["1x1", "1x2", "1x3"].includes(group.layout) ? group.layout : "1x3";
    const keys = group.keys ?? {};
    const order = SOFTRADIO_KEY_ORDER[layout];

    const grid = document.createElement("div");
    grid.className = `softradio-grid softradio-layout-${layout}`;
    host.dataset.softradioLayout = layout;

    for (const keyId of order) {
        const keyConfig = keys[keyId];
        if (!keyConfig) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = `keypad-button softradio-button softradio-${keyId}`;
        configureButton(button, keyId, keyConfig, group);
        button.appendChild(createLabelElement(keyConfig.label_primary, "key-primary"));
        const secondary = document.createElement("span");
        secondary.className = "key-secondary";
        secondary.textContent = keyConfig.label_secondary ?? "";
        button.appendChild(secondary);
        grid.appendChild(button);
    }

    if (grid.childElementCount) {
        section.classList.remove("is-empty-section");
        host.appendChild(grid);
    }
}

function fitTextByW(element, numberOfWs, options = {}) {
    const { widthRatio = 0.90, heightRatio = 0.86, minSize = 8, maxSize = 320 } = options;
    if (!element || element.clientWidth <= 0 || element.clientHeight <= 0) return minSize;
    const canvas = fitTextByW.canvas || (fitTextByW.canvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    if (!context) return minSize;
    const style = window.getComputedStyle(element);
    const referenceSize = 100;
    context.font = `${style.fontWeight || "700"} ${referenceSize}px ${style.fontFamily}`;
    const referenceWidth = Math.max(1, context.measureText("W".repeat(numberOfWs)).width);
    const widthSize = referenceSize * ((element.clientWidth * widthRatio) / referenceWidth);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const lineHeightFactor = Number.isFinite(lineHeight)
        ? lineHeight / Math.max(1, Number.parseFloat(style.fontSize) || 16)
        : 1.22;
    const heightSize = (element.clientHeight * heightRatio) / Math.max(1, lineHeightFactor);
    const finalSize = Math.max(minSize, Math.min(widthSize, heightSize, maxSize));
    element.style.fontSize = `${finalSize}px`;
    return finalSize;
}

function fitDisplayText() {
    fitTextByW(byId("radio-name"), TEXT_REFERENCE.header, { widthRatio: 0.90, heightRatio: 0.82, minSize: 8, maxSize: 180 });
    if (!byId("detail-screen").hidden) {
        const primary = byId("channel-name");
        fitTextByW(primary, TEXT_REFERENCE.displayPrimary, { widthRatio: 0.90, heightRatio: 0.84, minSize: 12, maxSize: 320 });
        const primarySize = parseFloat(window.getComputedStyle(primary).fontSize);
        byId("feedback-text").style.fontSize = `${primarySize * 0.5}px`;
    }
}

function fitSoftkeysToEightW() {
    const elements = Array.from(document.querySelectorAll(".softkey-label:not(.key-icon)"))
        .filter((element) => element.clientWidth > 0 && element.clientHeight > 0);
    if (!elements.length) return;
    let sharedSize = Number.POSITIVE_INFINITY;
    for (const element of elements) {
        sharedSize = Math.min(sharedSize, fitTextByW(element, TEXT_REFERENCE.softkey, {
            widthRatio: 0.90, heightRatio: 0.80, minSize: 8, maxSize: 160
        }));
    }
    elements.forEach((element) => { element.style.fontSize = `${sharedSize}px`; });
}


/*
 * Schaal een knoplabel op basis van de werkelijke tekst.
 * Dit voorkomt dat lange KeySec-labels buiten de knop vallen.
 */
function fitActualText(element, options = {}) {
    const {
        minSize = 7,
        widthRatio = 0.94,
        heightRatio = 0.82
    } = options;

    if (!element || element.classList.contains("key-icon")) return;
    if (element.clientWidth <= 0 || element.clientHeight <= 0) return;

    const text = (element.textContent ?? "").trim();
    if (!text) return;

    /*
     * Herstel eerst de CSS-basisgrootte. De vorige implementatie gebruikte
     * scrollHeight op een element met height: 100%. Daardoor werd altijd de
     * volledige rijhoogte gemeten en kromp vrijwel ieder label naar minSize.
     */
    element.style.fontSize = "";

    const computed = window.getComputedStyle(element);
    const baseSize = Number.parseFloat(computed.fontSize) || 16;
    const availableWidth = element.clientWidth * widthRatio;
    const availableHeight = element.clientHeight * heightRatio;

    const canvas = fitActualText.canvas ||
        (fitActualText.canvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    if (!context) return;

    const fontStyle = computed.fontStyle || "normal";
    const fontWeight = computed.fontWeight || "400";
    const fontFamily = computed.fontFamily || "sans-serif";

    /*
     * Meet de echte tekst op de huidige CSS-grootte.
     * Canvas is hier betrouwbaarder dan scrollWidth/scrollHeight bij
     * flex-items met overflow:hidden en een vaste hoogte.
     */
    context.font = `${fontStyle} ${fontWeight} ${baseSize}px ${fontFamily}`;
    const metrics = context.measureText(text);
    const measuredWidth = Math.max(metrics.width, 1);

    const lineHeight = Number.parseFloat(computed.lineHeight);
    const measuredHeight = Number.isFinite(lineHeight)
        ? lineHeight
        : baseSize * 1.2;

    const widthScale = availableWidth / measuredWidth;
    const heightScale = availableHeight / Math.max(measuredHeight, 1);

    const targetSize = Math.max(
        minSize,
        Math.min(baseSize, baseSize * widthScale, baseSize * heightScale)
    );

    element.style.fontSize = `${targetSize}px`;
}

function fitButtonLabels() {
    const primaryLabels = document.querySelectorAll(
        ".keypad-button .key-primary:not(.key-icon), " +
        ".function-key .key-primary:not(.key-icon), " +
        ".external-key .key-primary:not(.key-icon), " +
        ".rotary-label:not(.key-icon)"
    );

    const secondaryLabels = document.querySelectorAll(
        ".keypad-button .key-secondary, " +
        ".function-key .key-secondary, " +
        ".external-key .key-secondary"
    );

    primaryLabels.forEach((element) => {
        fitActualText(element, {
            minSize: 8,
            widthRatio: 0.92,
            heightRatio: 0.78
        });
    });

    secondaryLabels.forEach((element) => {
        fitActualText(element, {
            minSize: 7,
            widthRatio: 0.94,
            heightRatio: 0.76
        });
    });
}

function fitAllText() {
    fitDisplayText();
    fitSoftkeysToEightW();
    fitButtonLabels();
}

function scheduleFit() {
    window.cancelAnimationFrame(fitFrame);
    fitFrame = window.requestAnimationFrame(fitAllText);
}

function activateButton(button) {
    button.classList.add("is-active");
    window.setTimeout(() => button.classList.remove("is-active"), 130);
}

function executeAction(action, params = {}) {
    switch (action) {
        case "selection_up": selectListIndex(screenState.selectedIndex - 1); return true;
        case "selection_down": selectListIndex(screenState.selectedIndex + 1); return true;
        case "selection_left": selectListIndex(screenState.selectedIndex - 1); return true;
        case "selection_right": selectListIndex(screenState.selectedIndex + 1); return true;
        case "selection_select": return openSelectedListItem();
        case "screen_open": return openScreen(params.screen);
        case "screen_back": return goBack();
        case "input_numeric":
        case "input_t9":
        case "channel_up":
        case "channel_down":
        case "channel_select":
        case "status_select":
        case "volume_up":
        case "volume_down":
        case "ptt":
        case "sos":
        case "none":
            document.dispatchEvent(new CustomEvent("ui_radio:dev-action", { detail: { action, params } }));
            return true;
        default: return false;
    }
}

function handleButtonPress(event) {
    const listItem = event.target.closest(".screen-list-item[data-screen-id]");
    if (listItem) {
        screenState.selectedIndex = Number(listItem.dataset.listIndex) || 0;
        openScreen(listItem.dataset.screenId);
        return;
    }

    const button = event.target.closest("button[data-key]");
    if (!button) return;
    activateButton(button);

    let actionParams = {};
    try { actionParams = JSON.parse(button.dataset.actionParams || "{}"); }
    catch { actionParams = {}; }

    const detail = {
        key: button.dataset.key,
        action: button.dataset.action || "",
        action_params: actionParams,
        hwkey: button.dataset.hwkey || ""
    };

    // De daadwerkelijke uitvoering loopt via RadioPress zodat short/long press
    // in dev exact hetzelfde aanvoelt als in tenant, zonder hardwarekeys.
    document.dispatchEvent(new CustomEvent("ui_radio:key", { detail }));
}

function devSetDisplayColorState(state = "idle") {
    const display = byId("radio-screen");
    if (!display) return;
    display.dataset.radioState = state;
}

const devHoldState = { ptt: false, emergencyActive: false, sosPressed: false, sosCompleted: false, sosTimer: null, sosStartedAt: 0, sosMode: null };

function devSetSecondary(message) {
    byId("feedback-text").textContent = truncate(message || "", LIMITS.displaySecondary);
    scheduleFit();
}

function devRestoreDisplay() {
    renderCurrentScreen(getConfig());
    devSetDisplayColorState(devHoldState.emergencyActive ? "emergency" : "idle");
}

function devSosPress(meta = {}) {
    if (devHoldState.sosPressed) return true;
    devHoldState.sosPressed = true;
    devHoldState.sosCompleted = false;
    devHoldState.sosMode = devHoldState.emergencyActive ? "deactivate" : "activate";
    const totalMs = devHoldState.sosMode === "deactivate" ? 5000 : 2000;
    devHoldState.sosStartedAt = performance.now() - Math.max(0, Number(meta.elapsedMs || 0));
    devSetDisplayColorState("emergency");
    const tick = () => {
        if (!devHoldState.sosPressed || devHoldState.sosCompleted) return;
        const elapsed = performance.now() - devHoldState.sosStartedAt;
        const remaining = Math.max(0, totalMs - elapsed);
        byId("channel-name").textContent = "NOODOPROEP";
        devSetSecondary(`${devHoldState.sosMode === "deactivate" ? "Deactiveren" : "Activeren"} over ${(remaining / 1000).toFixed(1)} s`);
        if (elapsed >= totalMs) {
            window.clearInterval(devHoldState.sosTimer);
            devHoldState.sosTimer = null;
            devHoldState.sosCompleted = true;
            devHoldState.emergencyActive = devHoldState.sosMode === "activate";
            devSetDisplayColorState(devHoldState.emergencyActive ? "emergency" : "idle");
            devSetSecondary(devHoldState.emergencyActive ? "Noodoproep actief" : "Noodoproep gedeactiveerd");
        }
    };
    tick();
    devHoldState.sosTimer = window.setInterval(tick, 100);
    return true;
}

function devSosRelease() {
    if (!devHoldState.sosPressed) return false;
    devHoldState.sosPressed = false;
    window.clearInterval(devHoldState.sosTimer);
    devHoldState.sosTimer = null;
    if (!devHoldState.sosCompleted) devRestoreDisplay();
    devHoldState.sosCompleted = false;
    devHoldState.sosMode = null;
    return true;
}

function devIsHoldAction(action) { return action === "ptt" || action === "sos"; }
function devPressAction(action, params, source, meta = {}) {
    if (action === "ptt") { devHoldState.ptt = true; devSetDisplayColorState("transmitting"); devSetSecondary("Zenden (dev)"); return true; }
    if (action === "sos") return devSosPress(meta);
    return false;
}
function devReleaseAction(action) {
    if (action === "ptt") { devHoldState.ptt = false; devRestoreDisplay(); return true; }
    if (action === "sos") return devSosRelease();
    return false;
}

// Hardware key mappings blijven onderdeel van de JSON-configuratie, maar
// worden bewust NIET gebruikt op /dev/screen/. De dev-viewer reageert
// uitsluitend op zichtbare muis/touch/click-bediening.


/* =========================================================
   DEV RADIOFORMAAT
   ========================================================= */

const DEV_SIZE_STORAGE_KEY = "radio-ui:dev-screen-size";
const DEV_SIZE_DEFAULT = { width: 390, height: 844 };
const DEV_SIZE_LIMITS = { minWidth: 120, maxWidth: 4096, minHeight: 200, maxHeight: 4096 };

function clampNumber(value, minimum, maximum, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, number));
}

function readStoredDevSize() {
    try {
        const saved = JSON.parse(window.localStorage.getItem(DEV_SIZE_STORAGE_KEY) || "null");
        if (!saved || typeof saved !== "object") return { ...DEV_SIZE_DEFAULT };
        return {
            width: clampNumber(saved.width, DEV_SIZE_LIMITS.minWidth, DEV_SIZE_LIMITS.maxWidth, DEV_SIZE_DEFAULT.width),
            height: clampNumber(saved.height, DEV_SIZE_LIMITS.minHeight, DEV_SIZE_LIMITS.maxHeight, DEV_SIZE_DEFAULT.height)
        };
    } catch {
        return { ...DEV_SIZE_DEFAULT };
    }
}

function getRequestedDevSize() {
    return {
        width: clampNumber(byId("dev-radio-width").value, DEV_SIZE_LIMITS.minWidth, DEV_SIZE_LIMITS.maxWidth, DEV_SIZE_DEFAULT.width),
        height: clampNumber(byId("dev-radio-height").value, DEV_SIZE_LIMITS.minHeight, DEV_SIZE_LIMITS.maxHeight, DEV_SIZE_DEFAULT.height)
    };
}

function fitDevViewerToStage() {
    const stage = byId("dev-viewer-stage");
    const scaleBox = byId("dev-viewer-scale-box");
    const shell = byId("dev-hardware-shell");

    // offsetWidth/offsetHeight zijn de ongeschaalde, logische afmetingen.
    const logicalWidth = shell.offsetWidth;
    const logicalHeight = shell.offsetHeight;
    if (!logicalWidth || !logicalHeight) return;

    const style = window.getComputedStyle(stage);
    const availableWidth = Math.max(1, stage.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight));
    const availableHeight = Math.max(1, stage.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom));

    // Nooit vergroten: alleen proportioneel verkleinen wanneer het scherm te klein is.
    const scale = Math.min(1, availableWidth / logicalWidth, availableHeight / logicalHeight);

    shell.style.transform = `scale(${scale})`;
    scaleBox.style.width = `${logicalWidth * scale}px`;
    scaleBox.style.height = `${logicalHeight * scale}px`;

    const requested = getRequestedDevSize();
    byId("dev-size-status").textContent = `${requested.width} × ${requested.height}px · ${Math.round(scale * 100)}%`;
}

function applyDevRadioSize({ persist = true } = {}) {
    const shell = byId("dev-hardware-shell");
    const size = getRequestedDevSize();

    byId("dev-radio-width").value = String(size.width);
    byId("dev-radio-height").value = String(size.height);

    shell.style.setProperty("--dev-radio-width", `${size.width}px`);
    shell.style.setProperty("--dev-radio-height", `${size.height}px`);

    if (persist) {
        try {
            window.localStorage.setItem(DEV_SIZE_STORAGE_KEY, JSON.stringify(size));
        } catch { /* localStorage is optioneel in de dev-viewer. */ }
    }

    // Eerst layout laten berekenen, daarna de benodigde schaal bepalen.
    window.requestAnimationFrame(() => {
        fitDevViewerToStage();
        scheduleFit();
    });
}

function initializeDevSizeViewer() {
    const stored = readStoredDevSize();
    byId("dev-radio-width").value = String(stored.width);
    byId("dev-radio-height").value = String(stored.height);

    byId("dev-size-apply").addEventListener("click", () => applyDevRadioSize());
    [byId("dev-radio-width"), byId("dev-radio-height")].forEach((field) => {
        field.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                applyDevRadioSize();
            }
        });
        field.addEventListener("change", () => applyDevRadioSize());
    });

    applyDevRadioSize({ persist: false });
    window.addEventListener("resize", fitDevViewerToStage);

    if ("ResizeObserver" in window) {
        const stageObserver = new ResizeObserver(fitDevViewerToStage);
        stageObserver.observe(byId("dev-viewer-stage"));
    }
}

function initializeFullRadioFrame() {
    if (DEV_INSPECTION_MODE) return;
    const frame = document.getElementById("dev-full-radio-frame");
    if (!frame) return;

    const sendCurrentScreen = () => {
        if (!frame.contentWindow || !screenState.current) return;
        frame.contentWindow.postMessage(
            { type: "ui_radio:set-screen", screenId: screenState.current },
            window.location.origin
        );
    };

    const url = new URL(window.location.href);
    url.searchParams.set("inspection", "1");
    frame.src = url.pathname + url.search;

    // Zodra het rechter iframe klaar is, synchroniseren we het scherm dat
    // links op dat moment actief is.
    frame.addEventListener("load", sendCurrentScreen);

    // Iedere schermwissel links (menu, softkey, F-toets, back, etc.) wordt
    // direct doorgestuurd naar de volledige radio rechts.
    document.addEventListener("ui_radio:screen", sendCurrentScreen);
}

function initializeInspectionScreenSync() {
    if (!DEV_INSPECTION_MODE) return;

    window.addEventListener("message", (event) => {
        if (event.origin !== window.location.origin) return;
        if (!event.data || event.data.type !== "ui_radio:set-screen") return;

        const screenId = event.data.screenId;
        if (typeof screenId !== "string" || !screenId) return;

        openScreen(screenId, { remember: false });
    });
}

function initialize() {
    updateVisibleViewportCss();
    if (!DEV_INSPECTION_MODE) {
        initializeDevSizeViewer();
        initializeFullRadioFrame();
    } else {
        initializeInspectionScreenSync();
    }

    const config = getConfig();
    const firstScreen = getDefinedScreens(config)[0]?.id ?? null;
    screenState.current = config.initial_screen && config.screens?.[config.initial_screen]
        ? config.initial_screen
        : firstScreen;
    renderCurrentScreen(config);
    if (!DEV_INSPECTION_MODE) {
        window.requestAnimationFrame(() => fitDevViewerToStage());
    } else {
        byId("dev-hardware-shell").style.transform = "none";
        scheduleFit();
    }

    document.addEventListener("click", handleButtonPress);
    window.RadioPress?.bindPointer({
        root: document,
        selector: "button[data-key]",
        source: "dev",
        handlers: {
            trigger: (action, params) => executeAction(action, params),
            press: devPressAction,
            release: devReleaseAction,
            isHoldAction: devIsHoldAction,
        },
    });
    window.addEventListener("resize", scheduleFit);

    if ("ResizeObserver" in window) {
        const observer = new ResizeObserver(scheduleFit);
        observer.observe(byId("radio-device"));
    }
    if (document.fonts?.ready) document.fonts.ready.then(scheduleFit);
}

// Optionele runtime-simulatie in dev: dezelfde state-namen als tenant.
document.addEventListener("ui_radio:receive", (event) => {
    if (devHoldState.ptt || devHoldState.emergencyActive) return;
    devSetDisplayColorState(event.detail?.state === "active" ? "receiving" : "idle");
});

document.addEventListener("ui_radio:dev-display-state", (event) => {
    const state = String(event.detail?.state || "idle");
    if (["idle", "transmitting", "receiving", "emergency"].includes(state)) {
        devSetDisplayColorState(state);
    }
});

document.addEventListener("DOMContentLoaded", initialize);
