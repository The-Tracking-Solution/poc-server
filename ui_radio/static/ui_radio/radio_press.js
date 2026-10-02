(() => {
    "use strict";

    const LONG_PRESS_MS = 2000;
    const COUNTDOWN_DELAY_MS = 300;

    function hasAction(action) {
        return Boolean(action && action !== "none");
    }

    function actionLabel(action) {
        if (!hasAction(action)) return "";
        return String(action)
            .replaceAll("_", " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function publishCountdown(active, text = "") {
        document.dispatchEvent(new CustomEvent("ui_radio:press_countdown", {
            detail: { active, text },
        }));
    }
    function publishTone(kind,source="ui"){
        document.dispatchEvent(new CustomEvent("ui_radio:key_tone",{detail:{kind,source}}));
    }

    function showCountdown(session) {
        const shortLabel = actionLabel(session.def.shortAction);
        const longLabel = actionLabel(session.def.longAction);
        const instruction = shortLabel
            ? `Laat los voor: ${shortLabel} · Houd vast voor: ${longLabel}`
            : `Houd vast voor: ${longLabel}`;

        const update = () => {
            if (session.released || session.longFired) return;
            const remainingMs = Math.max(0, LONG_PRESS_MS - (performance.now() - session.startedAt));
            publishCountdown(true, `${(remainingMs / 1000).toFixed(1)} s · ${instruction}`);
            session.countdownRaf = requestAnimationFrame(update);
        };
        update();
    }

    function hideCountdown(session) {
        window.clearTimeout(session.countdownTimer);
        cancelAnimationFrame(session.countdownRaf);
        publishCountdown(false);
    }

    function parseParams(value) {
        if (!value) return {};
        if (typeof value === "object") return value;
        try { return JSON.parse(value); } catch (_) { return {}; }
    }

    function definitionFromButton(button) {
        return {
            shortAction: button.dataset.shortAction || button.dataset.action || "none",
            shortParams: parseParams(button.dataset.shortActionParams || button.dataset.actionParams),
            longAction: button.dataset.longAction || "",
            longParams: parseParams(button.dataset.longActionParams),
        };
    }

    function definitionFromConfig(key = {}) {
        return {
            shortAction: key.short_action ?? key.action ?? "none",
            shortParams: key.short_action_params ?? key.action_params ?? {},
            longAction: key.long_action ?? "",
            longParams: key.long_action_params ?? {},
        };
    }

    function start(definition, handlers, source = "ui", meta = {}) {
        const def = {
            shortAction: definition.shortAction || "none",
            shortParams: definition.shortParams || {},
            longAction: definition.longAction || "",
            longParams: definition.longParams || {},
        };
        const startedAt = performance.now();
        const session = {
            def,
            handlers,
            source,
            meta,
            startedAt,
            released: false,
            shortHoldActive: false,
            longHoldActive: false,
            longFired: false,
            fallbackFired: false,
            longTimer: null,
            countdownTimer: null,
            countdownRaf: 0,
        };

        const isHold = (action) => Boolean(handlers.isHoldAction?.(action));
        const press = (action, params, extra = {}) => handlers.press?.(action, params || {}, source, { ...meta, ...extra });
        const release = (action, params, extra = {}) => handlers.release?.(action, params || {}, source, { ...meta, ...extra });
        const trigger = (action, params, extra = {}) => handlers.trigger?.(action, params || {}, source, { ...meta, ...extra });

        const hasShort = hasAction(def.shortAction);
        const hasLong = hasAction(def.longAction);

        // Zonder long-action bestaat geen drempel: short start direct bij het
        // fysiek indrukken van de knop.
        if (hasShort && !hasLong) {
            if (isHold(def.shortAction)) {
                session.shortHoldActive = true;
                void press(def.shortAction, def.shortParams, { elapsedMs: 0, pressKind: "short" });
            } else {
                session.fallbackFired = true;
                void trigger(def.shortAction, def.shortParams, { elapsedMs: 0, pressKind: "short" });
            }
        }

        if (hasLong) {
            session.countdownTimer = window.setTimeout(() => {
                if (!session.released) showCountdown(session);
            }, COUNTDOWN_DELAY_MS);
        }

        session.longTimer = window.setTimeout(() => {
            if (session.released || !hasLong) return;

            session.longFired = true;
            publishTone("long",source);
            hideCountdown(session);
            if (isHold(def.longAction)) {
                session.longHoldActive = true;
                void press(def.longAction, def.longParams, { elapsedMs: LONG_PRESS_MS, pressKind: "long" });
            } else {
                void trigger(def.longAction, def.longParams, { elapsedMs: LONG_PRESS_MS, pressKind: "long" });
            }
        }, LONG_PRESS_MS);

        session.release = () => {
            if (session.released) return;
            session.released = true;
            publishTone("release",source);
            window.clearTimeout(session.longTimer);
            hideCountdown(session);
            const elapsedMs = performance.now() - session.startedAt;

            if (session.shortHoldActive) {
                session.shortHoldActive = false;
                void release(def.shortAction, def.shortParams, { elapsedMs, pressKind: "short" });
                return;
            }
            if (session.longHoldActive) {
                session.longHoldActive = false;
                void release(def.longAction, def.longParams, { elapsedMs, pressKind: "long" });
                return;
            }
            if (session.longFired || session.fallbackFired) return;

            // Bij een gecombineerde knop wordt short uitsluitend uitgevoerd
            // wanneer de gebruiker vóór de 2-seconden-grens loslaat.
            if (hasShort && hasLong) {
                if (isHold(def.shortAction)) {
                    void press(def.shortAction, def.shortParams, { elapsedMs, pressKind: "short" });
                    void release(def.shortAction, def.shortParams, { elapsedMs, pressKind: "short" });
                } else {
                    void trigger(def.shortAction, def.shortParams, { elapsedMs, pressKind: "short" });
                }
            }
        };

        session.cancel = session.release;
        return session;
    }

    function begin(definition, handlers, source = "ui", meta = {}) {
        const hasAnyAction = [definition?.shortAction, definition?.longAction]
            .some((value) => hasAction(value));
        const permitted = [definition?.shortAction, definition?.longAction]
            .filter((value) => hasAction(value))
            .some((value) => handlers.canUseAction?.(value) !== false);

        if (!hasAnyAction || !permitted) {
            publishTone("error-start", source);
            let released = false;
            return {
                release: () => {
                    if (released) return;
                    released = true;
                    publishTone("error-stop", source);
                },
                cancel: () => {
                    if (released) return;
                    released = true;
                    publishTone("error-stop", source);
                },
            };
        }

        publishTone("press", source);
        return start(definition, handlers, source, meta);
    }

    function bindPointer({ root = document, selector = "button[data-key]", handlers, source = "ui" } = {}) {
        const sessions = new Map();
        let suppressClickUntil = 0;

        const cancelAll = () => {
            for (const active of sessions.values()) {
                active.button.classList.remove("is-active");
                active.session.cancel();
            }
            sessions.clear();
        };

        const down = (event) => {
            if (event.button != null && event.button !== 0) return;
            const button = event.target.closest?.(selector);
            if (!button || button.disabled) return;
            const def = definitionFromButton(button);
            const hasAction = [def.shortAction, def.longAction].some((value) => value && value !== "none");
            event.preventDefault();
            button.setPointerCapture?.(event.pointerId);
            button.classList.add("is-active");
            const session = begin(def, handlers, source, {
                button,
                pointerId: event.pointerId,
                inputSource: "virtual",
            });
            sessions.set(event.pointerId, { button, session });
        };

        const up = (event) => {
            const active = sessions.get(event.pointerId);
            if (!active) return;
            event.preventDefault();
            active.button.classList.remove("is-active");
            active.session.release();
            sessions.delete(event.pointerId);
            suppressClickUntil = performance.now() + 350;
        };

        const click = (event) => {
            if (performance.now() <= suppressClickUntil && event.target.closest?.(selector)) {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        };

        root.addEventListener("pointerdown", down);
        root.addEventListener("pointerup", up);
        root.addEventListener("pointercancel", up);
        root.addEventListener("click", click, true);
        // Geen generieke cancel op window.blur: dedicated Android-hardware
        // kan tijdens een fysieke keypress een korte Gecko-focuswisseling
        // veroorzaken. Echte releases komen via pointerup/pointercancel.
        root.addEventListener("contextmenu", (event) => {
            if (event.target.closest?.(selector)) event.preventDefault();
        });

        return () => {
            root.removeEventListener("pointerdown", down);
            root.removeEventListener("pointerup", up);
            root.removeEventListener("pointercancel", up);
            root.removeEventListener("click", click, true);
            cancelAll();
        };
    }

    window.RadioPress = {
        LONG_PRESS_MS,
        COUNTDOWN_DELAY_MS,
        start,
        begin,
        bindPointer,
        definitionFromButton,
        definitionFromConfig,
    };
})();
