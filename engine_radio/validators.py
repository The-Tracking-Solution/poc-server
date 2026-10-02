from django.core.exceptions import ValidationError
from engine_main.validators import validate_engine_slug

from engine_poc.actions import ACTION_REGISTRY, UI_ACTIONS

USEMODES = {"visible", "hidden"}
SCREEN_TYPES = {"detail", "list", "private_call"}
SOFTRADIO_LAYOUTS = {"1x1", "1x2", "1x3"}
LABEL_TYPES = {"text", "icon"}


def _error(path: str, message: str) -> None:
    raise ValidationError(f"{path}: {message}")


def _validate_usemode(value, path: str, default: str = "visible") -> str:
    mode = value.get("usemode", default)
    if mode not in USEMODES:
        _error(f"{path}.usemode", "moet visible of hidden zijn.")
    return mode


def _validate_label(value, path: str) -> None:
    if not isinstance(value, dict):
        _error(path, "moet een object met type en value zijn.")
    if value.get("type", "text") not in LABEL_TYPES:
        _error(f"{path}.type", "moet 'text' of 'icon' zijn.")
    if "value" not in value:
        _error(f"{path}.value", "ontbreekt.")



def _validate_action_params(action, params, path: str) -> None:
    if not isinstance(params, dict):
        _error(path, "moet een JSON-object zijn.")
    definition = ACTION_REGISTRY.get(action)
    if not definition:
        return
    for name, param_type in definition.get("params", {}).items():
        if param_type.endswith("_optional"):
            continue
        if name not in params:
            _error(f"{path}.{name}", f"is verplicht voor {action}.")
        if param_type in {"screen", "channel", "status", "text"} and not isinstance(params.get(name), str):
            _error(f"{path}.{name}", "moet tekst zijn.")

def _validate_key(key, path: str) -> None:
    if not isinstance(key, dict):
        _error(path, "moet een object zijn.")
    if "usemode" in key:
        _error(f"{path}.usemode", "hoort op sectieniveau en niet op een knop.")
    if "label_primary" not in key:
        _error(f"{path}.label_primary", "ontbreekt.")
    _validate_label(key["label_primary"], f"{path}.label_primary")
    if "label_secondary" in key and not isinstance(key["label_secondary"], (str, int, float)):
        _error(f"{path}.label_secondary", "moet tekst of een getal zijn.")

    # Elke drukknop heeft altijd een short-press actie. 'none' is een geldige
    # expliciete keuze. Long press is optioneel en valt runtime terug op short.
    short_action = key.get("short_action", key.get("action", "none")) or "none"
    if short_action not in UI_ACTIONS:
        _error(f"{path}.short_action", f"onbekende UI-actie '{short_action}'.")
    short_params = key.get("short_action_params", key.get("action_params", {}))
    _validate_action_params(short_action, short_params, f"{path}.short_action_params")

    long_action = key.get("long_action")
    if long_action not in (None, ""):
        if long_action not in UI_ACTIONS:
            _error(f"{path}.long_action", f"onbekende UI-actie '{long_action}'.")
        _validate_action_params(long_action, key.get("long_action_params", {}), f"{path}.long_action_params")
    elif "long_action_params" in key and not isinstance(key.get("long_action_params"), dict):
        _error(f"{path}.long_action_params", "moet een JSON-object zijn.")

    # Hardwarecodes komen uit Android KeyEvent en zijn numeriek. De editor
    # slaat ze doorgaans als tekst op, maar bestaande JSON-configs bevatten
    # ook integers. Beide representaties zijn geldig; de runtime normaliseert
    # ze vóór vergelijking. Booleans zijn expres ongeldig (bool is een int-subtype).
    for field in ("hw_key", "hw_scan_code"):
        value = key.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (str, int))):
            _error(f"{path}.{field}", "moet tekst of een geheel getal zijn.")


def _validate_rotary_key(key, path: str) -> None:
    if not isinstance(key, dict):
        _error(path, "moet een object zijn.")
    if key.get("type") != "rotary":
        _error(f"{path}.type", "moet 'rotary' zijn.")
    if "label_primary" not in key:
        _error(f"{path}.label_primary", "ontbreekt.")
    _validate_label(key["label_primary"], f"{path}.label_primary")
    for field in (
        "hw_key_counter_clockwise", "hw_key_clockwise", "hw_key_ccw", "hw_key_cw",
        "hw_scan_code_counter_clockwise", "hw_scan_code_clockwise", "hw_scan_code_ccw", "hw_scan_code_cw",
    ):
        value = key.get(field)
        if value is not None and (isinstance(value, bool) or not isinstance(value, (str, int))):
            _error(f"{path}.{field}", "moet tekst of een geheel getal zijn.")

    for direction in ("counter_clockwise", "clockwise"):
        short_action = key.get(f"short_action_{direction}", key.get(f"action_{direction}", key.get("action", "none"))) or "none"
        if short_action not in UI_ACTIONS:
            _error(f"{path}.short_action_{direction}", f"onbekende UI-actie '{short_action}'.")
        short_params = key.get(f"short_action_params_{direction}", key.get(f"action_params_{direction}", key.get("action_params", {})))
        _validate_action_params(short_action, short_params, f"{path}.short_action_params_{direction}")

        long_action = key.get(f"long_action_{direction}")
        if long_action not in (None, ""):
            if long_action not in UI_ACTIONS:
                _error(f"{path}.long_action_{direction}", f"onbekende UI-actie '{long_action}'.")
            _validate_action_params(long_action, key.get(f"long_action_params_{direction}", {}), f"{path}.long_action_params_{direction}")


def _validate_key_group(group, path: str, *, require_layout: bool = False) -> None:
    if not isinstance(group, dict):
        _error(path, "moet een object zijn.")
    mode = _validate_usemode(group, path)
    if require_layout and mode == "visible":
        if not isinstance(group.get("layout"), str) or not group.get("layout"):
            _error(f"{path}.layout", "ontbreekt of is ongeldig.")
    keys = group.get("keys", {})
    if not isinstance(keys, dict):
        _error(f"{path}.keys", "moet een object zijn.")
    for key_id, key in keys.items():
        if not isinstance(key_id, str) or not key_id:
            _error(f"{path}.keys", "bevat een ongeldige codekey.")
        key_path = f"{path}.keys.{key_id}"
        if isinstance(key, dict) and key.get("type") == "rotary":
            _validate_rotary_key(key, key_path)
        else:
            _validate_key(key, key_path)


def validate_screen_config(value) -> None:
    """Valideer de configuratie van precies één Screen-record."""
    if value in (None, {}):
        return
    if not isinstance(value, dict):
        raise ValidationError("config moet een JSON-object zijn.")
    if "screens" in value or "initial_screen" in value:
        raise ValidationError("Eén Screen-record mag geen 'screens' of 'initial_screen' bevatten.")
    if value.get("schema_version") != 2:
        raise ValidationError("config.schema_version moet 2 zijn.")
    if not isinstance(value.get("theme", {}), dict):
        raise ValidationError("config.theme moet een object zijn.")
    if value.get("type") not in SCREEN_TYPES:
        _error("config.type", "moet 'detail', 'list' of 'private_call' zijn.")
    for required in ("display", "navkeys", "keyboard"):
        if required not in value:
            _error(f"config.{required}", "ontbreekt.")
    display = value["display"]
    if not isinstance(display, dict):
        _error("config.display", "moet een object zijn.")
    _validate_usemode(display, "config.display")
    _validate_key_group(display.get("softkeys", {"usemode": "hidden", "keys": {}}), "config.display.softkeys")
    _validate_key_group(value["navkeys"], "config.navkeys")
    _validate_key_group(value["keyboard"], "config.keyboard", require_layout=True)
    if "softradio" in value:
        _validate_key_group(value["softradio"], "config.softradio", require_layout=True)
        if value["softradio"].get("layout") not in SOFTRADIO_LAYOUTS:
            _error("config.softradio.layout", "moet 1x1, 1x2 of 1x3 zijn.")
    for optional_group in ("topkeys", "leftkeys", "rightkeys"):
        if optional_group in value:
            _validate_key_group(value[optional_group], f"config.{optional_group}")
    if value["type"] == "list":
        list_config = value.get("list")
        if not isinstance(list_config, dict):
            _error("config.list", "ontbreekt of is geen object.")
        if list_config.get("source") != "screens" and not isinstance(list_config.get("items"), list):
            _error("config.list", "vereist source='screens' of een items-lijst.")


validate_button_config = validate_screen_config
