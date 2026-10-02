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


const DEV_INSPECTION_MODE = false;

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
    header: 60,
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

const privateCallState = {
    state: "idle",
    callId: "",
    peerName: "",
    peerType: "dispatch",
    startedAtMs: 0,
    previousScreen: null,
};

const PRIVATE_CALL_ACTIVE_STATES = new Set(["ringing", "calling", "active"]);
const PRIVATE_CALL_TERMINAL_STATES = new Set(["declined", "ended"]);
const PRIVATE_CALL_RETURN_DELAY_MS = 5000;
let privateCallReturnTimer = null;

const runtimeDisplayState = {
    channelName: "",
    mode: "idle",
    statusName: "",
    currentStatus: null,
    remoteEmergency: false,
    remoteEmergencyPriority: 0,
    channelEmergency: false,
    channelEmergencyUsers: [],
    presence: { radios: 0, dispatchers: 0, linked: false, linked_channel_count: 1, linked_channel_names: [] },
    transientMessage: "",
    hardwareDebugMessage: "",
    audioMessage: "",
    connection: {
        lost: false,
        attempt: 0,
        retryInSeconds: 0,
        connecting: false,
    },
    sos: { active: false, countdown: false, message: "", state: "idle" },
    txDeadlineMs: 0,
    txMaxDurationMs: 0,
};

let runtimeFeedbackTimer = null;
let txCountdownTimer = null;
let hardwareDebugTimer = null;
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
    button.disabled = false;
    button.classList.toggle("is-disabled", !hasAction);
    button.setAttribute("aria-disabled", !hasAction ? "true" : "false");
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

// Publieke runtime-interface voor hardware-input. Hardwarekeys worden uit de
// actuele Screen.config gelezen en zijn daardoor onafhankelijk van zichtbaarheid.
window.RadioScreenRuntime = {
    getConfig,
    getCurrentScreen,
    getActiveUiConfig,
};

function currentRadioName() {
    return String(
        window.RadioActions?.getState?.().identity?.display_name
        || window.RADIO_USER?.name
        || "Radio"
    );
}

function currentHeaderTitle() {
    return currentRadioName();
}

function currentStatusLabel() {
    return String(
        runtimeDisplayState.currentStatus?.label_long
        || runtimeDisplayState.currentStatus?.label_short
        || ""
    ).trim();
}

function renderHeaderBar() {
    const target = byId("header_bar_text");
    target.textContent = currentRadioName();
}

function renderTitleBar(screen = getCurrentScreen(getConfig())) {
    const status = byId("title_status");
    const presence = byId("title_presence");
    const radios = byId("title_presence_radios");
    const dispatchers = byId("title_presence_dispatchers");
    const linked = byId("title_presence_linked");

    const isList = screen?.type === "list";
    const isPrivateCall = screen?.type === "private_call";

    if (isPrivateCall) {
        status.textContent = String(screen?.title || "Privé gesprek");
        presence.hidden = true;
        return;
    }

    if (isList) {
        status.textContent = String(screen?.title || "MENU");
        presence.hidden = true;
        return;
    }

    status.textContent = currentStatusLabel() || "—";
    radios.textContent = String(Math.max(0, Number(runtimeDisplayState.presence.radios || 0)));
    dispatchers.textContent = String(Math.max(0, Number(runtimeDisplayState.presence.dispatchers || 0)));
    if (linked) {
        linked.hidden = runtimeDisplayState.presence.linked !== true;
        linked.title = runtimeDisplayState.presence.linked === true
            ? `Gekoppelde kanaalgroep (${Math.max(2, Number(runtimeDisplayState.presence.linked_channel_count || 2))} kanalen)`
            : "Geen gekoppelde kanaalgroep";
    }
    presence.hidden = false;
}

function applyCurrentStatus(status = null) {
    runtimeDisplayState.currentStatus = status?.slug ? status : null;
    const emergency = Number(status?.call_request_priority) === 1;
    if (emergency && ["starting", "standby"].includes(runtimeDisplayState.sos.state)) return;
    runtimeDisplayState.sos = emergency
        ? { active: true, countdown: false, state: "active", message: status.label_long || "Noodoproep actief" }
        : { active: false, countdown: false, state: "idle", message: "" };
}


function stopTxCountdown() {
    if (txCountdownTimer) window.clearInterval(txCountdownTimer);
    txCountdownTimer = null;
    runtimeDisplayState.txDeadlineMs = 0;
    runtimeDisplayState.txMaxDurationMs = 0;
}

function startTxCountdown(maxDurationMs) {
    stopTxCountdown();
    const duration = Number(maxDurationMs || 0);
    if (!Number.isFinite(duration) || duration <= 0) return;
    runtimeDisplayState.txMaxDurationMs = duration;
    runtimeDisplayState.txDeadlineMs = Date.now() + duration;
    txCountdownTimer = window.setInterval(() => {
        if (runtimeDisplayState.mode !== "transmitting") {
            stopTxCountdown();
            return;
        }
        renderStatusLine();
        scheduleFit();
    }, 250);
}

function txCountdownSeconds() {
    if (!runtimeDisplayState.txDeadlineMs) return null;
    return Math.max(0, Math.ceil((runtimeDisplayState.txDeadlineMs - Date.now()) / 1000));
}

function currentChannelName() {
    const actionState = window.RadioActions?.getState?.();
    const channel = actionState?.channels?.[actionState.channelIndex];
    return String(channel?.name || runtimeDisplayState.channelName || "");
}

function renderStatusLine() {
    const target = byId("secundairy_text");
    target.replaceChildren();

    if (runtimeDisplayState.connection.lost) {
        const text = document.createElement("span");
        text.className = "runtime-status-text";
        const attempt = Math.max(1, Number(runtimeDisplayState.connection.attempt || 1));
        const seconds = Math.max(0, Number(runtimeDisplayState.connection.retryInSeconds || 0));
        text.textContent = runtimeDisplayState.connection.connecting
            ? `Reconnect poging ${attempt}…`
            : `Reconnect poging ${attempt} in ${seconds} sec`;
        target.appendChild(text);
        return;
    }

    const localEmergency = runtimeDisplayState.sos.active || runtimeDisplayState.sos.countdown;

    // Eigen noodoproep: de secundaire regel heeft een vaste flow.
    // Tijdens TX heeft de gewone mic + radionaam-status voorrang.
    if (localEmergency && runtimeDisplayState.mode !== "transmitting") {
        if (runtimeDisplayState.sos.state === "starting") {
            target.textContent = "Start noodoproep";
            return;
        }
        if (["standby", "active"].includes(runtimeDisplayState.sos.state)) {
            target.textContent = "cancel? druk kort op noodknop";
            return;
        }
    }

    if (window.RADIO_USER?.debug === true && runtimeDisplayState.hardwareDebugMessage) {
        target.textContent = truncate(runtimeDisplayState.hardwareDebugMessage, LIMITS.displaySecondary);
        return;
    }

    if (runtimeDisplayState.audioMessage) {
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined runtime-status-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "volume_up";
        const text = document.createElement("span");
        text.className = "runtime-status-text";
        text.textContent = truncate(runtimeDisplayState.audioMessage, LIMITS.displaySecondary);
        target.append(icon, text);
        return;
    }

    // De automatische noodzending (prio 99) heeft op ontvangers een eigen vorm.
    if (runtimeDisplayState.mode === "receiving"
        && runtimeDisplayState.remoteEmergency
        && Number(runtimeDisplayState.remoteEmergencyPriority) === 99) {
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined runtime-status-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "mic";
        const text = document.createElement("span");
        text.className = "runtime-status-text";
        text.textContent = `${runtimeDisplayState.statusName || "Radio"} [${currentChannelName()}]`;
        target.append(icon, text);
        return;
    }

    const status = {
        waiting: {
            icon: "timer",
            text: runtimeDisplayState.statusName || "Wachten op zendtoestemming",
        },
        transmitting: {
            icon: "mic",
            text: (() => {
                const seconds = txCountdownSeconds();
                return seconds === null ? currentRadioName() : `${currentRadioName()} (${seconds} s)`;
            })(),
        },
        receiving: { icon: "ear_sound", text: runtimeDisplayState.statusName || "Radio" },
        blocked: {
            icon: "block",
            text: runtimeDisplayState.statusName || "Zendtoestemming niet beschikbaar",
        },
        enabling: {
            icon: "power_settings_new",
            text: runtimeDisplayState.statusName || "Activeren",
        },
    }[runtimeDisplayState.mode];

    if (!status && runtimeDisplayState.transientMessage) {
        target.textContent = truncate(runtimeDisplayState.transientMessage, LIMITS.displaySecondary);
        return;
    }

    if (!status) {
        if (localEmergency) {
            target.textContent = "cancel? druk kort op noodknop";
        } else if (runtimeDisplayState.channelEmergency) {
            const emergencyNames = runtimeDisplayState.channelEmergencyUsers
                .map((user) => String(user?.name || "").trim())
                .filter(Boolean);
            const icon = document.createElement("span");
            icon.className = "material-symbols-outlined runtime-status-icon";
            icon.setAttribute("aria-hidden", "true");
            icon.textContent = "mobile";
            const text = document.createElement("span");
            text.className = "runtime-status-text";
            text.textContent = emergencyNames.length ? emergencyNames.join(" · ") : "Radio";
            target.append(icon, text);
        }
        return;
    }

    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined runtime-status-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = status.icon;
    target.appendChild(icon);

    // Wanneer een noodradio later opnieuw zendt (niet de prio-99 autozending),
    // krijgt de ontvanger ear_sound + e911_emergency + radionaam.
    if (runtimeDisplayState.mode === "receiving" && runtimeDisplayState.remoteEmergency) {
        const emergencyIcon = document.createElement("span");
        emergencyIcon.className = "material-symbols-outlined runtime-status-icon";
        emergencyIcon.setAttribute("aria-hidden", "true");
        emergencyIcon.textContent = "e911_emergency";
        target.appendChild(emergencyIcon);
    }

    if (status.text) {
        const text = document.createElement("span");
        text.className = "runtime-status-text";
        text.textContent = truncate(status.text, LIMITS.displaySecondary);
        target.appendChild(text);
    }
}

function getRuntimeDisplayColorState() {
    // Nood heeft altijd hoogste visuele prioriteit.
    if (runtimeDisplayState.sos.active || runtimeDisplayState.sos.countdown
        || runtimeDisplayState.remoteEmergency || runtimeDisplayState.channelEmergency) {
        return "emergency";
    }
    if (runtimeDisplayState.mode === "transmitting") return "transmitting";
    if (runtimeDisplayState.mode === "receiving") return "receiving";
    return "idle";
}

function renderPrimaryLine(fallback = "") {
    const target = byId("primairy_txt");
    target.replaceChildren();

    if (runtimeDisplayState.connection.lost) {
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined runtime-connection-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "mobiledata_off";
        target.appendChild(icon);
        return;
    }

    const localEmergency = runtimeDisplayState.sos.active || runtimeDisplayState.sos.countdown;
    const remotePriority99 = runtimeDisplayState.remoteEmergency
        && runtimeDisplayState.mode === "receiving"
        && Number(runtimeDisplayState.remoteEmergencyPriority) === 99;

    if (localEmergency) {
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined runtime-status-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "e911_emergency";
        const text = document.createElement("span");
        text.className = "runtime-status-text";
        text.textContent = "Verzend noodoproep";
        target.append(icon, text);
        return;
    }

    if (remotePriority99) {
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined runtime-status-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "e911_emergency";
        const text = document.createElement("span");
        text.className = "runtime-status-text";
        text.textContent = "NOODOPROEP";
        target.append(icon, text);
        return;
    }

    // Zolang een kanaal in nood staat blijft de standby-primary zichtbaar,
    // ook tijdens normale of latere noodradio-zendingen.
    if (runtimeDisplayState.channelEmergency) {
        const icon = document.createElement("span");
        icon.className = "material-symbols-outlined runtime-status-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "e911_emergency";
        const text = document.createElement("span");
        text.className = "runtime-status-text";
        text.textContent = currentChannelName() || fallback || "Kanaal";
        target.append(icon, text);
        return;
    }

    const primaryChannel = currentChannelName() || fallback || "Kanaal";
    const linkedNames = Array.isArray(runtimeDisplayState.presence.linked_channel_names)
        ? runtimeDisplayState.presence.linked_channel_names.filter(Boolean)
        : [];

    if (
        runtimeDisplayState.mode === "receiving"
        && runtimeDisplayState.presence.linked === true
        && linkedNames.length
    ) {
        const primary = document.createElement("span");
        primary.className = "runtime-primary-channel";
        primary.textContent = primaryChannel;

        const flow = document.createElement("span");
        flow.className = "material-symbols-outlined runtime-primary-link-icon";
        flow.setAttribute("aria-hidden", "true");
        flow.textContent = "flowchart";

        const linked = document.createElement("span");
        linked.className = "runtime-primary-linked-channels";
        linked.textContent = linkedNames.join(", ");

        target.append(primary, flow, linked);
        return;
    }

    target.textContent = truncate(primaryChannel, LIMITS.displayPrimary);
}

function applyRuntimeDisplayColorState() {
    const display = byId("radio-screen");
    if (!display) return;
    display.dataset.radioState = getRuntimeDisplayColorState();
}

function renderRuntimeDisplay() {
    const screen = getCurrentScreen(getConfig());
    if (!screen || screen.type === "list" || byId("detail-screen").hidden) return;

    if (screen.type === "private_call") {
        renderPrivateCallScreen(screen);
        scheduleFit();
        return;
    }

    renderHeaderBar();
    renderTitleBar(screen);
    renderPrimaryLine();
    renderStatusLine();
    applyRuntimeDisplayColorState();
    scheduleFit();
}

function setRuntimeMode(mode, statusName = "") {
    runtimeDisplayState.mode = mode;
    runtimeDisplayState.statusName = statusName || "";
    runtimeDisplayState.transientMessage = "";
    window.clearTimeout(runtimeFeedbackTimer);
    runtimeFeedbackTimer = null;
    renderRuntimeDisplay();
}

function showTransientRuntimeMessage(message, durationMs = 1600) {
    runtimeDisplayState.transientMessage = String(message || "");
    window.clearTimeout(runtimeFeedbackTimer);
    renderRuntimeDisplay();
    runtimeFeedbackTimer = window.setTimeout(() => {
        runtimeDisplayState.transientMessage = "";
        renderRuntimeDisplay();
    }, durationMs);
}

function showHardwareDebugMessage(message) {
    runtimeDisplayState.hardwareDebugMessage = String(message || "");
    window.clearTimeout(hardwareDebugTimer);
    renderRuntimeDisplay();
    hardwareDebugTimer = window.setTimeout(() => {
        runtimeDisplayState.hardwareDebugMessage = "";
        hardwareDebugTimer = null;
        renderRuntimeDisplay();
    }, 1000);
}

function privateCallStateLabel() {
    return {
        ringing: "Inkomende privéoproep",
        calling: "Bellen…",
        active: "Privégesprek actief",
        declined: "Privégesprek afgewezen",
        ended: "Privégesprek beëindigd",
    }[privateCallState.state] || "Privé gesprek";
}

function syncPrivateCallVisualState() {
    const display = byId("radio-screen");
    if (!display) return;
    const active = PRIVATE_CALL_ACTIVE_STATES.has(privateCallState.state);
    display.classList.toggle("is-private-call", active);
    display.dataset.radioState = active ? "private-call" : "idle";
}

function renderPrivateCallScreen(screen) {
    byId("detail-screen").hidden = false;
    byId("list-screen").hidden = true;
    renderHeaderBar();
    renderTitleBar(screen);

    const primary = byId("primairy_txt");
    const secondary = byId("secundairy_text");
    primary.replaceChildren();
    secondary.replaceChildren();

    primary.textContent = privateCallState.peerName || screen.primary || "Privé gesprek";
    secondary.textContent = privateCallStateLabel() || screen.secondary || "";
    syncPrivateCallVisualState();
}

function renderDetailScreen(screen) {
    byId("detail-screen").hidden = false;
    byId("list-screen").hidden = true;
    renderHeaderBar();
    renderTitleBar(screen);
    renderPrimaryLine(screen.primary || "");
    renderStatusLine();
    applyRuntimeDisplayColorState();
}

function renderScreenList(config, screen) {
    const detail = byId("detail-screen");
    const listScreen = byId("list-screen");
    const host = byId("screen-list");

    detail.hidden = true;
    listScreen.hidden = false;
    renderHeaderBar();
    renderTitleBar(screen);
    applyRuntimeDisplayColorState();
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
    // Basisverhouding van het center-deel onder TK: DISPLAY / NK / KB / SR
    // = 32 / 20 / 32 / 8. Samen met TK=8 vormt dit exact 100%.
    // Verborgen secties worden weggelaten; CSS fr-eenheden verdelen de
    // vrijgekomen ruimte daardoor automatisch evenredig over wat zichtbaar blijft.
    if (!displaySection.hidden) rows.push("minmax(0, 32fr)");
    if (!navigationSection.hidden) rows.push("minmax(0, 20fr)");
    if (!keypadSection.hidden) rows.push("minmax(0, 32fr)");
    if (!softradioSection.hidden) rows.push("minmax(0, 8fr)");

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

    // DISPLAY bestaat uit MENUBAR / TITLEBAR / CONTENT / SK = 15 / 10 / 60 / 15.
    // Ook hier worden hidden onderdelen simpelweg weggelaten, zodat de resterende
    // onderdelen hun relatieve verhouding behouden en samen 100% vullen.
    const menuBar = byId("header_bar");
    const titleBar = byId("title_bar");
    const screenContent = byId("screen-content");
    const displayRows = [];
    if (!menuBar.hidden) displayRows.push("minmax(0, 15fr)");
    if (!titleBar.hidden) displayRows.push("minmax(0, 10fr)");
    if (!screenContent.hidden) displayRows.push("minmax(0, 60fr)");
    if (!softkeyPanel.hidden) displayRows.push("minmax(0, 15fr)");

    radioScreen.style.setProperty(
        "--display-rows",
        displayRows.length ? displayRows.join(" ") : "minmax(0, 1fr)"
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
        const radioScreen = byId("radio-screen");
        radioScreen.dataset.screenType = screen.type || "detail";
        if (screen.type === "list") renderScreenList(config, screen);
        else if (screen.type === "private_call") renderPrivateCallScreen(screen);
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

function privateCallScreenId(config = getConfig()) {
    return Object.entries(config.screens || {}).find(([, screen]) => screen?.type === "private_call")?.[0] || null;
}

function clearPrivateCallReturnTimer() {
    if (privateCallReturnTimer !== null) {
        window.clearTimeout(privateCallReturnTimer);
        privateCallReturnTimer = null;
    }
}

function privateCallReturnScreenId(config = getConfig()) {
    const target = privateCallScreenId(config);
    const previous = privateCallState.previousScreen;
    if (previous && previous !== target && config.screens?.[previous]) return previous;
    if (config.initial_screen && config.initial_screen !== target && config.screens?.[config.initial_screen]) {
        return config.initial_screen;
    }
    return getDefinedScreens(config).find(item => item.id !== target)?.id || null;
}

function leavePrivateCallScreen({ dueToReceive = false } = {}) {
    clearPrivateCallReturnTimer();
    const config = getConfig();
    const target = privateCallScreenId(config);
    const returnId = privateCallReturnScreenId(config);
    privateCallState.previousScreen = null;
    privateCallState.state = "idle";

    const display = byId("radio-screen");
    display?.classList.remove("is-private-call");

    if (returnId && screenState.current === target) {
        screenState.current = returnId;
        renderCurrentScreen(config);
    } else {
        renderCurrentScreen(config);
    }

    // Bij RX wordt na de schermwissel meteen de normale ontvangstweergave
    // gerenderd door de receive-handler.
    if (!dueToReceive) renderRuntimeDisplay();
}

function schedulePrivateCallReturn() {
    clearPrivateCallReturnTimer();
    privateCallReturnTimer = window.setTimeout(() => {
        privateCallReturnTimer = null;
        leavePrivateCallScreen();
    }, PRIVATE_CALL_RETURN_DELAY_MS);
}

function setPrivateCallState(next = {}) {
    Object.assign(privateCallState, next || {});
    const config = getConfig();
    const target = privateCallScreenId(config);

    if (PRIVATE_CALL_ACTIVE_STATES.has(privateCallState.state)) {
        clearPrivateCallReturnTimer();
        if (target && screenState.current !== target) {
            privateCallState.previousScreen = screenState.current;
            openScreen(target, { remember: false });
        } else {
            renderCurrentScreen(config);
        }
    } else if (PRIVATE_CALL_TERMINAL_STATES.has(privateCallState.state)) {
        // Laat de eindstatus nog vijf seconden zien, maar vanaf dit moment in
        // de neutrale light/dark displaykleur. RX breekt deze wachttijd af.
        renderCurrentScreen(config);
        if (runtimeDisplayState.mode === "receiving") leavePrivateCallScreen({ dueToReceive: true });
        else schedulePrivateCallReturn();
    } else if (privateCallState.state === "idle") {
        leavePrivateCallScreen();
    } else {
        renderCurrentScreen(config);
    }

    document.dispatchEvent(new CustomEvent("ui_radio:private-call-state", { detail: { ...privateCallState } }));
    return Boolean(target);
}

window.RadioPrivateCall = {
    getState: () => ({ ...privateCallState }),
    setState: setPrivateCallState,
    incoming: (data = {}) => setPrivateCallState({ ...data, state: "ringing" }),
    calling: (data = {}) => setPrivateCallState({ ...data, state: "calling" }),
    accept: () => setPrivateCallState({ state: "active", startedAtMs: Date.now() }),
    decline: () => setPrivateCallState({ state: "declined" }),
    hangup: () => setPrivateCallState({ state: "ended" }),
};

function openScreen(screenId, { remember = true } = {}) {
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
            directAction: keyConfig.action_counter_clockwise ?? keyConfig.short_action_counter_clockwise ?? keyConfig.action ?? "none",
            directParams: {
                ...(keyConfig.action_params_counter_clockwise ?? keyConfig.short_action_params_counter_clockwise ?? keyConfig.action_params ?? {}),
                direction: "counter_clockwise"
            },

        },
        {
            direction: "clockwise",
            icon: "rotate_right",
            hwkey: keyConfig.hw_key_clockwise ?? keyConfig.hw_key_cw,
            directAction: keyConfig.action_clockwise ?? keyConfig.short_action_clockwise ?? keyConfig.action ?? "none",
            directParams: {
                ...(keyConfig.action_params_clockwise ?? keyConfig.short_action_params_clockwise ?? keyConfig.action_params ?? {}),
                direction: "clockwise"
            },

        }
    ];

    for (const step of steps) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `rotary-step rotary-${step.direction}`;
        button.dataset.key = `${groupName}.${keyId}.${step.direction}`;
        button.dataset.directAction = step.directAction;
        button.dataset.directActionParams = JSON.stringify(step.directParams);
        button.dataset.action = step.directAction;
        button.dataset.actionParams = JSON.stringify(step.directParams);
        button.dataset.rotaryDirect = "1";
        const hasStepAction = String(step.directAction || "").trim() && step.directAction !== "none";
        button.disabled = false;
        button.classList.toggle("is-disabled",!hasStepAction);
        button.setAttribute("aria-disabled", hasStepAction ? "false" : "true");
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

    // Horizontaal: LK 10% / CENTER 80% / RK 10%. Als LK of RK hidden is,
    // krijgt CENTER die ruimte terug. TK blijft altijd exact even breed als CENTER.
    const shell = byId("dev-hardware-shell");
    const topVisible = !byId("external-top-keys").hidden;
    const leftVisible = !byId("external-left-keys").hidden;
    const rightVisible = !byId("external-right-keys").hidden;
    const centerWeight = 80 + (leftVisible ? 0 : 10) + (rightVisible ? 0 : 10);

    shell.style.gridTemplateColumns = [
        leftVisible ? "minmax(0, 10fr)" : "0",
        `minmax(0, ${centerWeight}fr)`,
        rightVisible ? "minmax(0, 10fr)" : "0"
    ].join(" ");

    // Verticaal: TK 8%, daaronder DISPLAY/NK/KB/SR samen 92%.
    // Als TK hidden is, krijgt het center-deel de volledige 100% hoogte.
    shell.style.gridTemplateRows = topVisible
        ? "minmax(0, 8fr) minmax(0, 92fr)"
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

function fitSingleLineToMax(element, maxSize, options = {}) {
    const {
        minSize = 8,
        widthRatio = 0.98,
        heightRatio = 0.88,
    } = options;

    if (!element || element.clientWidth <= 0 || element.clientHeight <= 0) return minSize;

    const text = String(element.textContent || "").trim();
    const computed = window.getComputedStyle(element);
    const availableWidth = Math.max(1, element.clientWidth * widthRatio);
    const availableHeight = Math.max(1, element.clientHeight * heightRatio);
    const lineHeightFactor = 1.22;

    // Begin altijd op de bestaande/maximale vormgeving.
    let size = Math.max(minSize, Number(maxSize) || minSize);
    size = Math.min(size, availableHeight / lineHeightFactor);
    element.style.fontSize = `${size}px`;

    if (!text) return size;

    const canvas = fitSingleLineToMax.canvas
        || (fitSingleLineToMax.canvas = document.createElement("canvas"));
    const context = canvas.getContext("2d");
    if (!context) return size;

    const fontFamily = computed.fontFamily;
    const fontWeight = computed.fontWeight || "700";
    const measureAt = candidate => {
        context.font = `${fontWeight} ${candidate}px ${fontFamily}`;
        // scrollWidth bevat ook iconen/gaps; voor gewone tekst is canvas nauwkeuriger.
        return context.measureText(text).width;
    };

    const measured = measureAt(size);
    if (measured <= availableWidth && element.scrollWidth <= element.clientWidth + 1) {
        return size;
    }

    // Directe schaalberekening, daarna een kleine safety-loop voor rounding/iconen.
    const ratio = Math.min(1, availableWidth / Math.max(1, measured));
    size = Math.max(minSize, size * ratio);
    element.style.fontSize = `${size}px`;

    let guard = 0;
    while (element.scrollWidth > element.clientWidth + 1 && size > minSize && guard < 30) {
        size = Math.max(minSize, size - 1);
        element.style.fontSize = `${size}px`;
        guard += 1;
    }

    return size;
}

function fitDisplayText() {
    // HEADER/TITLE: vaste responsieve grootte; deze zones mogen NIET door
    // de autofit-logica naar een miniatuurfont worden teruggeschaald.
    const radio = byId("radio-device");
    const radioHeight = Math.max(1, radio.clientHeight);
    const headerSize = Math.max(12, Math.min(32, radioHeight * 0.027));
    const titleSize = Math.max(11, Math.min(28, radioHeight * 0.023));

    const headerText = byId("header_bar_text");
    const titleStatus = byId("title_status");
    const titlePresence = byId("title_presence");
    headerText.style.fontSize = `${headerSize}px`;
    titleStatus.style.fontSize = `${titleSize}px`;
    titlePresence.style.fontSize = `${titleSize}px`;

    if (!byId("detail-screen").hidden) {
        const primary = byId("primairy_txt");
        const secondary = byId("secundairy_text");

        // Primary/secondary behouden wel autofit: bestaande maat = maximum,
        // en uitsluitend verkleinen wanneer de actuele inhoud niet past.
        const primaryMax = fitTextByW(primary, TEXT_REFERENCE.displayPrimary, {
            widthRatio: 0.90,
            heightRatio: 0.84,
            minSize: 12,
            maxSize: 320,
        });
        fitSingleLineToMax(primary, primaryMax, {
            minSize: 10,
            widthRatio: 0.96,
            heightRatio: 0.84,
        });

        const secondaryMax = primaryMax * 0.5;
        fitSingleLineToMax(secondary, secondaryMax, {
            minSize: 8,
            widthRatio: 0.96,
            heightRatio: 0.84,
        });
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

function executeAction(action, params = {}, source = "ui") {
    if (window.RadioActions) return window.RadioActions.trigger(action, params, source);
    switch (action) {
        case "selection_up": selectListIndex(screenState.selectedIndex - 1); return true;
        case "selection_down": selectListIndex(screenState.selectedIndex + 1); return true;
        case "selection_left": selectListIndex(screenState.selectedIndex - 1); return true;
        case "selection_right": selectListIndex(screenState.selectedIndex + 1); return true;
        case "selection_select": return openSelectedListItem();
        case "screen_open": return openScreen(params.screen);
        case "screen_back": return goBack();
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

    // Uitvoering gebeurt via RadioPress zodat short/long press voor iedere
    // toets dezelfde timing en fallback-regels gebruikt.
    document.dispatchEvent(new CustomEvent("ui_radio:key", { detail }));
}


/* =========================================================
   PRODUCTIE INITIALISATIE
   ========================================================= */

async function initializeTenantRadio() {
    updateVisibleViewportCss();
    const config = getConfig();
    const firstScreen = getDefinedScreens(config)[0]?.id ?? null;

    screenState.current = config.initial_screen && config.screens?.[config.initial_screen]
        ? config.initial_screen
        : firstScreen;

    renderCurrentScreen(config);

    document.addEventListener("click", handleButtonPress);

    // Alle zichtbare toetsen gebruiken één centrale short/long-press engine.
    // Alleen short voert direct uit. Met een long-action beslist loslaten vóór
    // 2,0 s voor short; vasthouden tot 2,0 s voert long uit. Vanaf 0,3 s wordt
    // daarbij een aftelklok met de beschikbare actie(s) getoond.
    window.RadioPress?.bindPointer({
        root: document,
        selector: "button[data-key]",
        source: "ui",
        handlers: {
            trigger: (action, params, source, meta) => window.RadioActions?.trigger(action, params, source, meta),
            press: (action, params, source, meta) => window.RadioActions?.press(action, params, source, meta),
            release: (action, params, source, meta) => window.RadioActions?.release(action, params, source, meta),
            isHoldAction: (action) => window.RadioActions?.isHoldAction(action),
            canUseAction: (action) => window.RadioActions?.canUseAction?.(action) !== false,
        },
    });

    // Runtime-display: kanaalnaam is altijd de primaire regel.
    // De secundaire regel toont alleen de actuele radiostatus:
    // timer = wachten op zendtoestemming, mic = zelf zenden, ear_sound = ontvangen, block = fout/geblokkeerd.
    document.addEventListener("ui_radio:ready", (event) => {
        runtimeDisplayState.channelName = event.detail?.channel?.name || "";
        runtimeDisplayState.channelEmergency = event.detail?.channelEmergency === true;
        runtimeDisplayState.channelEmergencyUsers = event.detail?.emergencyUsers || [];
        runtimeDisplayState.presence = {
            radios: Number(event.detail?.presence?.radios || 0),
            dispatchers: Number(event.detail?.presence?.dispatchers || 0),
            linked: event.detail?.presence?.linked === true,
            linked_channel_count: Math.max(1, Number(event.detail?.presence?.linked_channel_count || 1)),
            linked_channel_names: Array.isArray(event.detail?.presence?.linked_channel_names)
                ? event.detail.presence.linked_channel_names.map(String)
                : [],
        };
        applyCurrentStatus(event.detail?.status || null);
        renderRuntimeDisplay();
    });

    document.addEventListener("ui_radio:connection", (event) => {
        const detail = event.detail || {};
        runtimeDisplayState.connection = {
            lost: detail.lost === true,
            attempt: Number(detail.attempt || 0),
            retryInSeconds: Number(detail.retry_in_seconds || 0),
            connecting: detail.connecting === true,
        };
        renderRuntimeDisplay();
    });

    document.addEventListener("ui_radio:presence", (event) => {
        runtimeDisplayState.presence = {
            radios: Number(event.detail?.radios || 0),
            dispatchers: Number(event.detail?.dispatchers || 0),
            linked: event.detail?.linked === true,
            linked_channel_count: Math.max(1, Number(event.detail?.linked_channel_count || 1)),
            linked_channel_names: Array.isArray(event.detail?.linked_channel_names)
                ? event.detail.linked_channel_names.map(String)
                : [],
        };
        renderTitleBar();
        scheduleFit();
    });

    document.addEventListener("ui_radio:status", (event) => {
        applyCurrentStatus(event.detail || null);
        renderRuntimeDisplay();
    });

    document.addEventListener("ui_radio:channel", (event) => {
        runtimeDisplayState.channelName = event.detail?.name || "";
        renderRuntimeDisplay();
    });

    document.addEventListener("ui_radio:channel-emergency", (event) => {
        runtimeDisplayState.channelEmergency = event.detail?.active === true;
        runtimeDisplayState.channelEmergencyUsers = event.detail?.users || [];
        renderRuntimeDisplay();
    });

    document.addEventListener("ui_radio:emergency-block", (event) => {
        if (event.detail?.active) setRuntimeMode("blocked", event.detail.message || `Geblokkeerd door noodoproep: [${currentChannelName()}]`);
        else if (runtimeDisplayState.mode === "blocked") setRuntimeMode("idle");
    });

    document.addEventListener("ui_radio:ptt", (event) => {
        const state = event.detail?.state;
        const message = String(event.detail?.message || "");
        if (["requesting", "waiting"].includes(state)) {
            stopTxCountdown();
            setRuntimeMode("waiting", message || "Wachten op zendtoestemming");
        } else if (state === "active") {
            setRuntimeMode("transmitting", currentRadioName());
            startTxCountdown(event.detail?.max_tx_duration_ms);
        } else if (["blocked", "error"].includes(state)) {
            stopTxCountdown();
            setRuntimeMode("blocked", message || event.detail?.error || "Zendtoestemming niet beschikbaar");
        } else if (state === "idle") {
            stopTxCountdown();
            // Na eigen PTT kan ontvangst inmiddels al actief zijn.
            const receiving = window.RadioActions?.getState?.().receivingSpeaker;
            if (receiving) setRuntimeMode("receiving", receiving.name);
            else setRuntimeMode("idle");
        }
        if (event.detail?.source === "hardware") {
            const debugMessage = {
                requesting: "PTT AANVRAAG GESTART",
                waiting: "PTT WACHT OP TOESTEMMING",
                active: "ZENDEN ACTIEF",
                blocked: "PTT GEBLOKKEERD",
                error: "PTT FOUT",
                idle: "PTT LOSGELATEN",
            }[state];
            if (debugMessage) showHardwareDebugMessage(debugMessage);
        }
    });

    document.addEventListener("ui_radio:sos", (event) => {
        const detail = event.detail || {};
        const state = detail.state || "";
        if (state === "starting") {
            runtimeDisplayState.sos = { active: true, countdown: false, state, message: detail.message || "Verzend noodoproep" };
        } else if (state === "standby") {
            runtimeDisplayState.sos = { active: true, countdown: false, state, message: detail.message || "cancel? druk kort op noodknop" };
        } else if (state === "countdown") {
            runtimeDisplayState.sos = { active: false, countdown: true, state, message: detail.message || "" };
        } else if (state === "active") {
            runtimeDisplayState.sos = { active: true, countdown: false, state, message: detail.message || "Noodoproep actief" };
        } else if (state === "error") {
            runtimeDisplayState.sos = { active: false, countdown: true, state, message: detail.message || "Noodoproep fout" };
        } else if (["inactive", "cancelled"].includes(state)) {
            runtimeDisplayState.sos = { active: false, countdown: false, state: "idle", message: "" };
        }
        renderRuntimeDisplay();
    });

    document.addEventListener("ui_radio:receive", (event) => {
        // Eigen zendstatus heeft voorrang boven ontvangstmeldingen.
        const actionState = window.RadioActions?.getState?.();
        if (actionState?.pttPressed || actionState?.pttGranted) return;
        if (event.detail?.state === "active") {
            runtimeDisplayState.remoteEmergency = event.detail?.emergency === true;
            runtimeDisplayState.remoteEmergencyPriority = Number(event.detail?.effective_priority || 0);
            const sender = event.detail?.name || "Radio";
            if (PRIVATE_CALL_TERMINAL_STATES.has(privateCallState.state)) {
                leavePrivateCallScreen({ dueToReceive: true });
            }
            setRuntimeMode("receiving", sender);
        } else {
            runtimeDisplayState.remoteEmergency = false;
            runtimeDisplayState.remoteEmergencyPriority = 0;
            setRuntimeMode("idle");
        }
    });

    // Lokale actiefeedback verschijnt tijdelijk op de secundaire regel. De
    // zend-/ontvangststatus blijft leidend zolang die actief is.
    document.addEventListener("ui_radio:feedback", (event) => {
        const detail = event.detail || {};
        if (detail.kind === "active") return;
        const message = String(detail.message || "");
        if (/^PTT aanvragen|^Zenden|^PTT vrijgegeven/i.test(message)) return;
        if (!message) return;
        showTransientRuntimeMessage(message, detail.kind === "error" ? 2400 : 1800);
    });

    document.addEventListener("ui_radio:hardware-debug", (event) => {
        if (window.RADIO_USER?.debug !== true) return;
        showHardwareDebugMessage(event.detail?.message || "Hardware input");
    });

    document.addEventListener("ui_radio:audio-message", (event) => {
        const detail = event.detail || {};
        runtimeDisplayState.audioMessage = detail.state === "active"
            ? String(detail.message || "")
            : "";
        renderRuntimeDisplay();
    });

    document.addEventListener("ui_radio:audio", (event) => {
        const detail = event.detail || {};
        const message = detail.message || ({
            connecting: "Activeren",
            connected: "Audio verbonden",
            closed: "Controlverbinding verbroken",
            error: "Controlverbinding mislukt",
        }[detail.state] || "");

        // Tijdens initialisatie/kanaalwissel blijft 'Activeren' zichtbaar tot
        // RX + muted TX-publisher volledig gereed zijn. Dit is alleen visueel;
        // er wordt hiervoor geen audio-aankondiging afgespeeld.
        if (detail.state === "connecting") {
            setRuntimeMode("enabling", "Activeren");
            return;
        }
        if (detail.state === "connected" && runtimeDisplayState.mode === "enabling") {
            setRuntimeMode("idle");
            return;
        }
        if (detail.state === "error" && runtimeDisplayState.mode === "enabling") {
            setRuntimeMode("blocked", message || "Audioverbinding niet beschikbaar");
            return;
        }
        if (message && detail.type === "error") {
            showTransientRuntimeMessage(message, 2400);
        } else if (message && detail.state) {
            showTransientRuntimeMessage(message, 1800);
        }
    });

    await window.RadioActions?.initialize({
        screenOpen: (screenId) => openScreen(screenId),
        screenBack: () => goBack(),
        selectionUp: () => { selectListIndex(screenState.selectedIndex - 1); return true; },
        selectionDown: () => { selectListIndex(screenState.selectedIndex + 1); return true; },
        selectionLeft: () => { selectListIndex(screenState.selectedIndex - 1); return true; },
        selectionRight: () => { selectListIndex(screenState.selectedIndex + 1); return true; },
        selectionSelect: () => openSelectedListItem(),
    });

    runtimeDisplayState.channelName = currentChannelName();
    renderRuntimeDisplay();

    bindVisibleViewportUpdates(scheduleFit);
    if ("ResizeObserver" in window) {
        const observer = new ResizeObserver(scheduleFit);
        observer.observe(byId("radio-device"));
    }
    if (document.fonts?.ready) document.fonts.ready.then(scheduleFit);
}

document.addEventListener("DOMContentLoaded", initializeTenantRadio);
