from copy import deepcopy

from django.core.exceptions import ValidationError


def validate_config_override(value):
    if not isinstance(value, dict):
        raise ValidationError("Een configuratie-override moet een JSON-object zijn.")


def merge_config(*layers):
    """Voeg JSON-configuratielagen recursief samen zonder een bronlaag te wijzigen."""
    result = {}
    for layer in layers:
        if layer is None:
            continue
        if not isinstance(layer, dict):
            raise TypeError("Een configuratielaag moet een JSON-object zijn.")
        result = _merge_dicts(result, layer)
    return result


def _merge_dicts(base, override):
    merged = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_dicts(merged[key], value)
        else:
            merged[key] = deepcopy(value)
    return merged

BUTTON_GROUP_PATHS = (
    "display.softkeys",
    "navkeys",
    "keyboard",
    "softradio",
    "topkeys",
    "leftkeys",
    "rightkeys",
)


def button_keys(config, path):
    config = config or {}
    if path == "display.softkeys":
        group = config.get("display", {}).get("softkeys", {})
    else:
        group = config.get(path, {})
    keys = group.get("keys", {}) if isinstance(group, dict) else {}
    return keys if isinstance(keys, dict) else {}


def validate_button_subset(override, hardware_config):
    """Sta in override-lagen uitsluitend knoppen toe die in HardwareConfig bestaan."""
    labels = {
        "display.softkeys": "Softkeys",
        "navkeys": "Navigatietoetsen",
        "keyboard": "Keyboard",
        "softradio": "Softradio",
        "topkeys": "Top keys",
        "leftkeys": "Left keys",
        "rightkeys": "Right keys",
    }
    errors = []
    for path in BUTTON_GROUP_PATHS:
        illegal = sorted(set(button_keys(override, path)) - set(button_keys(hardware_config, path)))
        if illegal:
            errors.append(f"{labels[path]}: niet gedefinieerd in HardwareConfig: {', '.join(illegal)}")
    if errors:
        raise ValidationError(errors)
