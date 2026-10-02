(() => {
    "use strict";

    let bound = false;
    let handlers = null;
    const activeKeys = new Map();
    const pendingEvents = [];
    const MAX_PENDING_EVENTS = 32;

    function queuePending(kind, payload) {
        pendingEvents.push({ kind, payload });
        if (pendingEvents.length > MAX_PENDING_EVENTS) pendingEvents.shift();
    }

    function flushPending() {
        if (!handlers || !window.RadioPress || pendingEvents.length === 0) return;
        const events = pendingEvents.splice(0, pendingEvents.length);
        for (const item of events) {
            if (item.kind === "android") androidKey({ detail: item.payload });
        }
    }

    function reportHardwareInput(event, phase, definition = null) {
        const input = String(event.key || event.code || event.keyCode || "onbekend");
        const button = String(definition?.codekey || "").toUpperCase();
        const action = String(definition?.shortAction || definition?.longAction || "none");
        const state = String(phase || "input").toUpperCase();
        const message = definition
            ? `${button} → ${action.toUpperCase()} · ${state}`
            : `NIET GEKOPPELD: ${input} · ${state}`;
        document.dispatchEvent(new CustomEvent("ui_radio:hardware-debug", {
            detail: { message, phase, definition },
        }));
    }

    function eventValues(event) {
        return [event.key, event.code, event.keyCode, event.which]
            .filter((value) => value !== undefined && value !== null && value !== "")
            .map((value) => String(value).trim().toLowerCase());
    }

    function normalizedHardwareValue(value) {
        if (value === undefined || value === null) return "";
        return String(value).trim().toLowerCase();
    }

    function numberOrNull(value) {
        if (value === undefined || value === null || value === "") return null;
        const number = Number(value);
        return Number.isInteger(number) ? number : null;
    }

    function hardwareDefinitions() {
        const config = window.RadioScreenRuntime?.getActiveUiConfig?.();
        if (!config) return [];
        const definitions = [];
        const groupNames = ["topkeys", "leftkeys", "rightkeys", "display.softkeys", "navkeys", "keyboard", "softradio"];

        for (const groupName of groupNames) {
            const group = groupName.split(".").reduce((current, part) => current?.[part], config);
            const keys = group?.keys;
            if (!keys || typeof keys !== "object") continue;

            for (const [codekey, key] of Object.entries(keys)) {
                if (!key || typeof key !== "object") continue;
                if (key.type === "rotary") {
                    const rotaryDefinitions = [
                        {
                            hwkey: key.hw_key_counter_clockwise ?? key.hw_key_ccw,
                            scanCode: key.hw_scan_code_counter_clockwise ?? key.hw_scan_code_ccw,
                            shortAction: key.short_action_counter_clockwise ?? key.action_counter_clockwise ?? key.action ?? "none",
                            shortParams: key.short_action_params_counter_clockwise ?? key.action_params_counter_clockwise ?? key.action_params ?? {},
                            longAction: key.long_action_counter_clockwise ?? "",
                            longParams: key.long_action_params_counter_clockwise ?? {},
                            direction: "counter_clockwise",
                        },
                        {
                            hwkey: key.hw_key_clockwise ?? key.hw_key_cw,
                            scanCode: key.hw_scan_code_clockwise ?? key.hw_scan_code_cw,
                            shortAction: key.short_action_clockwise ?? key.action_clockwise ?? key.action ?? "none",
                            shortParams: key.short_action_params_clockwise ?? key.action_params_clockwise ?? key.action_params ?? {},
                            longAction: key.long_action_clockwise ?? "",
                            longParams: key.long_action_params_clockwise ?? {},
                            direction: "clockwise",
                        },
                    ];
                    for (const item of rotaryDefinitions) {
                        if (item.hwkey) definitions.push({ ...item, groupName, codekey });
                    }
                    continue;
                }

                const hwkey = key.hw_key ?? key.hwkey;
                if (hwkey) {
                    const pressDef = window.RadioPress?.definitionFromConfig?.(key) || {
                        shortAction: key.short_action ?? key.action ?? "none",
                        shortParams: key.short_action_params ?? key.action_params ?? {},
                        longAction: key.long_action ?? "",
                        longParams: key.long_action_params ?? {},
                    };
                    definitions.push({ hwkey, scanCode: key.hw_scan_code, ...pressDef, groupName, codekey });
                }
            }
        }
        return definitions;
    }

    function matchingDefinition(event) {
        const values = new Set(eventValues(event));
        return hardwareDefinitions().find((definition) =>
            values.has(String(definition.hwkey || "").trim().toLowerCase())
        ) || null;
    }

    function visibleButton(definition) {
        return Array.from(document.querySelectorAll("button[data-hwkey]")).find((button) =>
            String(button.dataset.hwkey || "").trim().toLowerCase() === String(definition.hwkey || "").trim().toLowerCase()
        ) || null;
    }

    function resolvedDefinition(definition) {
        const button = visibleButton(definition);
        if (!button || !window.RadioPress?.definitionFromButton) return { definition, button };
        const buttonDefinition = window.RadioPress.definitionFromButton(button);
        return {
            button,
            definition: {
                ...definition,
                ...buttonDefinition,
            },
        };
    }

    function keyIdentity(event) {
        return String(event.code || event.key || event.keyCode || event.which || "").toLowerCase();
    }

    function parseAndroidDetail(detail) {
        if (!detail) return null;
        if (typeof detail === "object") return detail;
        try {
            const parsed = JSON.parse(String(detail));
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    function matchingAndroidDefinition(detail) {
        const keyCode = numberOrNull(detail?.key_code);
        const scanCode = numberOrNull(detail?.scan_code);
        if (keyCode === null) return null;
        return hardwareDefinitions().find((definition) => {
            const configuredKeyCode = numberOrNull(definition.hwkey);
            if (configuredKeyCode === null || configuredKeyCode !== keyCode) return false;
            const configuredScanCode = numberOrNull(definition.scanCode);
            return configuredScanCode === null || configuredScanCode === scanCode;
        }) || null;
    }

    function androidIdentity(detail) {
        const keyCode = numberOrNull(detail?.key_code);
        const scanCode = numberOrNull(detail?.scan_code);
        return `android:${keyCode ?? "?"}:${scanCode ?? "*"}`;
    }

    function keydown(event) {
        const definition = matchingDefinition(event);
        // Android kan tijdens vasthouden veel repeats sturen. Die mogen de
        // nuttige DOWN-/actie- of zendstatus niet telkens opnieuw bedekken.
        if (!event.repeat) reportHardwareInput(event, "down", definition);
        if (event.repeat || !handlers || !window.RadioPress) return;
        if (!definition) return;
        const hasAction = [definition.shortAction, definition.longAction].some((value) => value && value !== "none");
        if (!hasAction) return;

        event.preventDefault();
        const identity = keyIdentity(event);
        if (activeKeys.has(identity)) return;
        const resolved = resolvedDefinition(definition);
        const button = resolved.button;
        button?.classList.add("is-active");
        const session = window.RadioPress.begin(resolved.definition, handlers, "ui", {
            inputSource: "hardware",
            hardwareKey: definition.hwkey,
            codekey: definition.codekey,
            groupName: definition.groupName,
        });
        activeKeys.set(identity, { definition: resolved.definition, button, session });
    }

    function keyup(event) {
        const definition = matchingDefinition(event);
        reportHardwareInput(event, "up", definition);
        if (!handlers) return;
        const identity = keyIdentity(event);
        const active = activeKeys.get(identity);
        if (!active) return;
        event.preventDefault();
        activeKeys.delete(identity);
        active.button?.classList.remove("is-active");
        active.session.release();
    }


    function androidKey(event) {
        const detail = parseAndroidDetail(event.detail);
        if (!detail) return;
        if (!handlers || !window.RadioPress) {
            queuePending("android", detail);
            return;
        }
        const definition = matchingAndroidDefinition(detail);
        const phase = String(detail.phase || "").toLowerCase();
        const identity = androidIdentity(detail);

        document.dispatchEvent(new CustomEvent("ui_radio:hardware-debug", {
            detail: {
                message: definition
                    ? `${String(definition.codekey || "").toUpperCase()} → ${String(definition.shortAction || definition.longAction || "none").toUpperCase()} · ${phase.toUpperCase()}`
                    : `NIET GEKOPPELD: Android keyCode ${detail.key_code} · ${phase.toUpperCase()}`,
                phase,
                definition,
                android: detail,
            },
        }));

        if (!definition) return;
        const hasAction = [definition.shortAction, definition.longAction].some((value) => value && value !== "none");
        if (!hasAction) return;

        if (phase === "down") {
            if (detail.repeat === true || activeKeys.has(identity)) return;
            const resolved = resolvedDefinition(definition);
            const button = resolved.button;
            button?.classList.add("is-active");
            const session = window.RadioPress.begin(resolved.definition, handlers, "ui", {
                inputSource: "hardware",
                hardwareKey: definition.hwkey,
                scanCode: definition.scanCode,
                androidKeyCode: detail.key_code,
                androidScanCode: detail.scan_code,
                codekey: definition.codekey,
                groupName: definition.groupName,
            });
            activeKeys.set(identity, { definition: resolved.definition, button, session });
            return;
        }

        if (phase === "up") {
            const active = activeKeys.get(identity);
            if (!active) return;
            activeKeys.delete(identity);
            active.button?.classList.remove("is-active");
            active.session.release();
        }
    }

    function bind(nextHandlers) {
        if (nextHandlers) handlers = nextHandlers;
        if (!bound) {
            bound = true;
            document.addEventListener("keydown", keydown);
            document.addEventListener("keyup", keyup);
            document.addEventListener("ui_radio:android-key", androidKey);
        }
        flushPending();
    }

    function unbind() {
        if (!bound) return;
        document.removeEventListener("keydown", keydown);
        document.removeEventListener("keyup", keyup);
        document.removeEventListener("ui_radio:android-key", androidKey);
        for (const active of activeKeys.values()) active.session.cancel();
        activeKeys.clear();
        pendingEvents.length = 0;
        bound = false;
        handlers = null;
    }

    window.RadioHardware = { bind, unbind, definitions: hardwareDefinitions, reportHardwareInput };
})();
