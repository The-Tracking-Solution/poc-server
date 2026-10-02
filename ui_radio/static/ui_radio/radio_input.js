(() => {
    "use strict";

    const T9_TIMEOUT_MS = 900;
    const T9_MAP = {
        "0": " ", "1": "1", "2": "ABC", "3": "DEF", "4": "GHI",
        "5": "JKL", "6": "MNO", "7": "PQRS", "8": "TUV", "9": "WXYZ",
        "*": "*", "#": "#",
    };

    const state = {
        numericValue: "",
        t9Value: "",
        t9LastKey: null,
        t9LastAt: 0,
        t9CycleIndex: 0,
    };

    function emit(mode, value, key) {
        document.dispatchEvent(new CustomEvent("ui_radio:input", { detail: { mode, value, key } }));
    }

    function numeric(params = {}) {
        const key = String(params.value ?? "");
        state.numericValue += key;
        emit("numeric", state.numericValue, key);
        return { value: state.numericValue, key };
    }

    function t9(params = {}) {
        const key = String(params.value ?? "");
        const chars = T9_MAP[key] || key;
        const now = Date.now();
        if (state.t9LastKey === key && now - state.t9LastAt <= T9_TIMEOUT_MS && state.t9Value.length) {
            state.t9CycleIndex = (state.t9CycleIndex + 1) % Math.max(1, chars.length);
            state.t9Value = state.t9Value.slice(0, -1) + chars[state.t9CycleIndex];
        } else {
            state.t9CycleIndex = 0;
            state.t9Value += chars[0] || "";
        }
        state.t9LastKey = key;
        state.t9LastAt = now;
        emit("t9", state.t9Value, key);
        return { value: state.t9Value, key };
    }

    function reset(mode) {
        if (!mode || mode === "numeric") state.numericValue = "";
        if (!mode || mode === "t9") {
            state.t9Value = "";
            state.t9LastKey = null;
            state.t9CycleIndex = 0;
            state.t9LastAt = 0;
        }
    }

    window.RadioInput = { numeric, t9, reset, getState: () => ({ ...state }) };
})();
