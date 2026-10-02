"""Canonieke HardwareConfig-JSON voor de standaard radio-apparaten."""

from copy import deepcopy

COLOR = "#3a3d40"
SOFT_COLOR = "#e4e4e4"


def _key(value, *, hw_key=None, label_type="text", action="none", params=None, color=COLOR, secondary=None):
    result = {
        "color": color,
        "hw_key": hw_key,
        "short_action": action,
        "label_primary": {"type": label_type, "value": value},
        "short_action_params": params or {},
    }
    if secondary is not None:
        result["label_secondary"] = secondary
    return result


def _group(keys=None, *, usemode="hidden", color=COLOR, layout=None):
    result = {"keys": keys or {}, "usemode": usemode, "default_color": color}
    if layout is not None:
        result["layout"] = layout
    return result


def _rotary(value, *, clockwise_key=None, clockwise_action="none", clockwise_params=None,
            counter_clockwise_key=None, counter_clockwise_action="none", counter_clockwise_params=None):
    return {
        "type": "rotary",
        "color": COLOR,
        "label_primary": {"type": "text", "value": value},
        "action_clockwise": clockwise_action,
        "hw_key_clockwise": clockwise_key,
        "action_params_clockwise": clockwise_params or {},
        "action_counter_clockwise": counter_clockwise_action,
        "hw_key_counter_clockwise": counter_clockwise_key,
        "action_params_counter_clockwise": counter_clockwise_params or {},
    }


def generic_hardware_config():
    """Standaard HardwareConfig met de naam ``alle``."""
    softkeys = {f"sk{n}": _key(f"sk{n}", color=SOFT_COLOR) for n in range(1, 4)}
    navkeys = {
        "ok": _key("OK", action="selection_select"),
        "p1": _key("F1"),
        "p2": _key("F2"),
        "p3": _key("F3"),
        "p4": _key("F4"),
        "up": _key("keyboard_arrow_up", label_type="icon", action="channel_up"),
        "down": _key("keyboard_arrow_down", label_type="icon", action="channel_down"),
        "left": _key("keyboard_arrow_left", label_type="icon", action="volume_down", params={"step": 5}),
        "right": _key("keyboard_arrow_right", label_type="icon", action="volume_up", params={"step": 5}),
    }
    topkeys = {f"tk{n}": _key(f"TK{n}") for n in range(1, 7)}
    topkeys.update({"tk7": _rotary("TK7"), "tk8": _rotary("TK8")})
    keyboard = {str(n): _key(str(n)) for n in range(10)}
    keyboard.update({"hash": _key("#"), "star": _key("*")})
    leftkeys = {f"tl{n}": _key(f"TL{n}") for n in range(1, 7)}
    leftkeys["tl1"] = {
        "color": "#ff0000", "hw_key": None, "long_action": "sos",
        "short_action": "emergency_cancel", "label_primary": {"type": "text", "value": "TL1"},
        "label_secondary": "nood", "long_action_params": {}, "short_action_params": {},
    }
    leftkeys["tl2"] = _key("TL2", label_type="icon", action="ptt", color="#0080ff", secondary="ptt")
    rightkeys = {f"tr{n}": _key(f"TR{n}") for n in range(1, 7)}
    softradio = {
        "sr1": _key("mic", label_type="icon", action="ptt", secondary="PTT"),
        "sr2": {
            "color": "#eb1414", "hw_key": None, "long_action": "sos",
            "short_action": "emergency_cancel", "label_primary": {"type": "text", "value": "SR2"},
            "label_secondary": "Nood", "long_action_params": {}, "short_action_params": {},
        },
    }
    return {
        "type": "detail",
        "theme": {
            "icon_family": "material-symbols-outlined", "contrast_mode": "auto",
            "dark_text_color": "#000000", "light_text_color": "#ffffff",
            "default_button_color": COLOR,
        },
        "title": "",
        "display": {
            "usemode": "visible",
            "softkeys": _group(softkeys, usemode="hidden", color=SOFT_COLOR),
            "default_screen_type": "detail",
        },
        "navkeys": _group(navkeys, usemode="visible"),
        "primary": "Gereed",
        "topkeys": _group(topkeys, usemode="hidden"),
        "usemode": "softradio",
        "keyboard": _group(keyboard, usemode="visible", layout="3x4"),
        "leftkeys": _group(leftkeys, usemode="hidden"),
        "rightkeys": _group(rightkeys, usemode="hidden"),
        "secondary": "",
        "softradio": _group(softradio, usemode="visible", layout="1x2"),
        "schema_version": 2,
    }


def telox_te320_hardware_config():
    """Telox TE320 mapping; hw_key is Android KeyEvent.getKeyCode()."""
    softkeys = {f"sk{n}": _key(f"sk{n}", color=SOFT_COLOR) for n in range(1, 3)}
    navkeys = {
        "p1": _key("OK", hw_key=23, action="selection_select"),
        "p2": _key("Return", hw_key=4, action="screen_back"),
        "p3": _key("", hw_key=82, color="#165200"),
        "p4": _key("HOME", hw_key=3, color="#a30000"),
        "up": _key("keyboard_arrow_up", hw_key=19, label_type="icon", action="selection_up"),
        "down": _key("keyboard_arrow_down", hw_key=20, label_type="icon", action="selection_down"),
        "left": _key("keyboard_arrow_left", hw_key=21, label_type="icon", action="selection_left"),
        "right": _key("keyboard_arrow_right", hw_key=22, label_type="icon", action="selection_right"),
    }
    emergency = {
        "color": "#ff4000", "hw_key": 140, "long_action": "sos",
        "short_action": "emergency_cancel", "label_primary": {"type": "text", "value": "SOS"},
        "long_action_params": {}, "short_action_params": {},
    }
    rotary = _rotary(
        "TK7", clockwise_key=167, clockwise_action="channel_up",
        counter_clockwise_key=166, counter_clockwise_action="channel_down",
    )
    leftkeys = {
        "tl1": _key("POWER"),
        "tl2": _key("PTT", hw_key=141, action="ptt", color="#ffc800"),
        "tl3": _key("TL3", hw_key=24, action="volume_up", params={"step": 5}),
        "tl4": _key("TL4", hw_key=25, action="volume_down", params={"step": 5}),
    }
    return {
        "type": "detail",
        "theme": {
            "icon_family": "material-symbols-outlined", "contrast_mode": "auto",
            "dark_text_color": "#000000", "light_text_color": "#ffffff",
            "default_button_color": COLOR,
        },
        "title": "Radio",
        "display": {
            "usemode": "visible", "softkeys": _group(softkeys, usemode="visible", color=SOFT_COLOR),
            "default_screen_type": "detail",
        },
        "navkeys": _group(navkeys, usemode="hidden"),
        "primary": "Gereed",
        "topkeys": _group({"tk1": emergency, "tk7": rotary}, usemode="hidden"),
        "usemode": "softradio",
        "keyboard": _group({}, usemode="hidden", layout="3x4"),
        "leftkeys": _group(leftkeys, usemode="hidden"),
        "rightkeys": _group({}, usemode="hidden"),
        "secondary": "",
        "softradio": _group({}, usemode="hidden", layout="1x3"),
        "schema_version": 2,
    }


def softradio_hardware_config():
    """Aangeleverde standaardconfiguratie voor ``Softradio``."""
    return deepcopy(telox_te320_hardware_config())


DEFAULT_HARDWARE = {
    "alle": generic_hardware_config,
    "Telox TE320": telox_te320_hardware_config,
    "Softradio": softradio_hardware_config,
}
