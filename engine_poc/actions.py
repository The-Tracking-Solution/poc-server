"""Centrale Action Registry voor Screen.config.

De registry is de enige Python-bron voor welke actions bestaan en welke
parameters/uitvoeringsvorm ze hebben. Admin en validators gebruiken deze data.
"""

ACTION_REGISTRY = {
    "none": {
        "label": "Geen actie",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "ptt": {
        "label": "PTT",
        "scope": "backend",
        "event": "hold",
        "params": {},
    },
    "sos": {
        "label": "Noodoproep starten",
        "scope": "backend",
        "event": "click",
        "params": {},
    },
    "emergency_cancel": {
        "label": "Noodoproep stoppen",
        "scope": "backend",
        "event": "click",
        "params": {},
    },
    "private_call_accept": {
        "label": "Privégesprek accepteren",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "private_call_decline": {
        "label": "Privégesprek afwijzen",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "private_call_hangup": {
        "label": "Privégesprek beëindigen",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "screen_open": {
        "label": "Ga naar scherm",
        "scope": "local",
        "event": "click",
        "params": {"screen": "screen"},
    },
    "screen_back": {
        "label": "Ga naar vorig scherm",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "channel_up": {
        "label": "Kanaal omhoog",
        "scope": "backend",
        "event": "click",
        "params": {},
    },
    "channel_down": {
        "label": "Kanaal omlaag",
        "scope": "backend",
        "event": "click",
        "params": {},
    },
    "channel_select": {
        "label": "Ga naar kanaal",
        "scope": "backend",
        "event": "click",
        "params": {"channel": "channel"},
    },
    "status_select": {
        "label": "Stel status in",
        "scope": "backend",
        "event": "click",
        "params": {"status": "status"},
    },
    "volume_up": {
        "label": "Volume omhoog",
        "scope": "local",
        "event": "click",
        "params": {"step": "number_optional"},
    },
    "volume_down": {
        "label": "Volume omlaag",
        "scope": "local",
        "event": "click",
        "params": {"step": "number_optional"},
    },
    "input_numeric": {
        "label": "Numerieke input",
        "scope": "local",
        "event": "click",
        "params": {"value": "text"},
    },
    "input_t9": {
        "label": "T9 input",
        "scope": "local",
        "event": "click",
        "params": {"value": "text"},
    },
    "selection_up": {
        "label": "Selectie omhoog",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "selection_down": {
        "label": "Selectie omlaag",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "selection_left": {
        "label": "Selectie links",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "selection_right": {
        "label": "Selectie rechts",
        "scope": "local",
        "event": "click",
        "params": {},
    },
    "selection_select": {
        "label": "Selecteer huidige selectie",
        "scope": "local",
        "event": "click",
        "params": {},
    },
}

ACTION_DEFINITIONS = tuple((code, item["label"]) for code, item in ACTION_REGISTRY.items())
UI_ACTIONS = frozenset(ACTION_REGISTRY)
ACTION_LABELS = {code: item["label"] for code, item in ACTION_REGISTRY.items()}
BACKEND_ACTIONS = frozenset(code for code, item in ACTION_REGISTRY.items() if item["scope"] == "backend")
LOCAL_ACTIONS = frozenset(code for code, item in ACTION_REGISTRY.items() if item["scope"] == "local")
HOLD_ACTIONS = frozenset(code for code, item in ACTION_REGISTRY.items() if item["event"] == "hold")


SHORT_PRESS_MS = 200
LONG_PRESS_MS = 2000
