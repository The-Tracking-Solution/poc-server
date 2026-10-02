import json

from django import forms

from engine_poc.actions import ACTION_DEFINITIONS
from .config_overrides import validate_button_subset
from .models import HardwareConfig, HardwareProfile, RadioUser, Screen

from engine_poc.models import Channel, UserStatus


def _status_choices_for_tenant(tenant_id):
    """Return (slug, label) choices using the project-wide status label format."""
    if not tenant_id:
        return []
    statuses = UserStatus.objects.filter(tenant_id=tenant_id).order_by("slug")
    return [(status.slug, status.selection_label) for status in statuses]


class RadioUserAdminForm(forms.ModelForm):
    clear_location = forms.BooleanField(
        label="Laatste locatie verwijderen",
        required=False,
        help_text="Vink aan en sla op om de opgeslagen laatste locatie, nauwkeurigheid en tijd te wissen.",
    )

    class Meta:
        model = RadioUser
        fields = "__all__"
        widgets = {
            "location_interval_seconds": forms.NumberInput(attrs={"min": 0, "step": 5}),
        }


class ScreenConfigWidget(forms.Textarea):
    template_name = "engine_radio/admin/button_config_widget.html"
    editor_scope = "full"

    class Media:
        css = {"all": ("engine_radio/admin/button_config_editor_v13.css",)}
        js = ("engine_radio/admin/button_config_editor_v17.js",)

    def __init__(self, attrs=None, *, screen_choices=None, channel_choices=None, status_choices=None):
        default_attrs = {
            "class": "vLargeTextField button-config-json",
            "rows": 30,
            "spellcheck": "false",
        }
        if attrs:
            default_attrs.update(attrs)
        super().__init__(default_attrs)
        self.screen_choices = list(screen_choices or [])
        self.channel_choices = list(channel_choices or [])
        self.status_choices = list(status_choices or [])

    def get_context(self, name, value, attrs):
        context = super().get_context(name, value, attrs)
        context["widget"]["screen_choices_json"] = json.dumps(
            self.screen_choices, ensure_ascii=False
        )
        context["widget"]["channel_choices_json"] = json.dumps(
            self.channel_choices, ensure_ascii=False
        )
        context["widget"]["status_choices_json"] = json.dumps(
            self.status_choices, ensure_ascii=False
        )
        context["widget"]["action_choices_json"] = json.dumps(
            list(ACTION_DEFINITIONS), ensure_ascii=False
        )
        context["widget"]["editor_scope"] = self.editor_scope
        return context


class OverrideConfigWidget(ScreenConfigWidget):
    editor_scope = "override"

    def __init__(self, attrs=None, *, parent_configs=None, parent_select_id="", **kwargs):
        attrs = {"rows": 24, **(attrs or {})}
        super().__init__(attrs=attrs, **kwargs)
        self.parent_configs = parent_configs or {}
        self.parent_select_id = parent_select_id

    def get_context(self, name, value, attrs):
        context = super().get_context(name, value, attrs)
        context["widget"]["parent_configs_json"] = json.dumps(
            self.parent_configs, ensure_ascii=False
        )
        context["widget"]["parent_select_id"] = self.parent_select_id
        return context


class ScreenAdminForm(forms.ModelForm):
    class Meta:
        model = Screen
        fields = "__all__"
        widgets = {"config": OverrideConfigWidget()} 

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        tenant_id = None
        if self.is_bound:
            tenant_id = self.data.get("tenant")
        if not tenant_id and self.instance and self.instance.pk:
            tenant_id = self.instance.tenant_id
        if not tenant_id and self.initial.get("tenant"):
            tenant = self.initial["tenant"]
            tenant_id = getattr(tenant, "pk", tenant)

        hardware_profile_id = self.data.get("hardware_profile") if self.is_bound else None
        if not hardware_profile_id and self.instance and self.instance.pk:
            hardware_profile_id = self.instance.hardware_profile_id

        self.fields["hardware_profile"].queryset = (
            HardwareProfile.objects.filter(tenant_id=tenant_id).select_related("hardware_config").order_by("name")
            if tenant_id else HardwareProfile.objects.none()
        )

        choices = []
        channel_choices = []
        status_choices = []
        if tenant_id:
            choices = list(
                Screen.objects.filter(
                    tenant_id=tenant_id,
                    hardware_profile_id=hardware_profile_id,
                )
                .order_by("name")
                .values_list("name", flat=True)
            )
            channel_choices = list(
                Channel.objects.filter(tenant_id=tenant_id, status=Channel.Status.ACTIVE)
                .order_by("name")
                .values_list("slug", "name")
            )
            status_choices = _status_choices_for_tenant(tenant_id)

        parent_configs = {}
        if tenant_id:
            profiles = HardwareProfile.objects.filter(tenant_id=tenant_id).select_related("hardware_config")
            for profile in profiles:
                parent_configs[str(profile.pk)] = {
                    "base": profile.resolved_config,
                    "allowed": profile.hardware_config.config,
                }
        self.fields["config"].widget = OverrideConfigWidget(
            screen_choices=choices,
            channel_choices=channel_choices,
            status_choices=status_choices,
            parent_configs=parent_configs,
            parent_select_id="id_hardware_profile",
        )
        self.fields["config"].help_text = (
            "Kies alleen de knoppen die dit scherm overschrijft. "
            "Niet gekozen knoppen erven van HardwareProfile en HardwareConfig."
        )

    def clean_config(self):
        config = self.cleaned_data.get("config") or {}
        tenant = self.cleaned_data.get("tenant")
        hardware_profile = self.cleaned_data.get("hardware_profile")

        if isinstance(config, str):
            try:
                config = json.loads(config)
            except json.JSONDecodeError as exc:
                raise forms.ValidationError(
                    f"Ongeldige schermconfiguratie: {exc.msg}."
                ) from exc

        if not isinstance(config, dict):
            raise forms.ValidationError("De schermconfiguratie moet een JSON-object zijn.")

        # Canonieke namen voor topkeys: TK7/TK8 zijn de twee rotary-controls.
        topkeys = config.get("topkeys")
        if isinstance(topkeys, dict) and isinstance(topkeys.get("keys"), dict):
            normalized = {}
            for raw_id, raw_key in topkeys["keys"].items():
                key_id = str(raw_id).lower()
                if key_id == "tr1":
                    key_id = "tk7"
                elif key_id == "tr2":
                    key_id = "tk8"
                key = dict(raw_key) if isinstance(raw_key, dict) else raw_key
                if key_id in {"tk7", "tk8"} and isinstance(key, dict):
                    key["type"] = "rotary"
                    label = key.get("label_primary")
                    if not isinstance(label, dict):
                        label = {"type": "text", "value": label or ""}
                    else:
                        label = dict(label)
                    if str(label.get("value", "")).upper() in {"", "TR1", "TR2", "TK7", "TK8"}:
                        label["value"] = key_id.upper()
                    key["label_primary"] = label
                normalized[key_id] = key
            topkeys["keys"] = normalized

        if "screens" in config or "initial_screen" in config:
            raise forms.ValidationError(
                "Ieder Screen-record mag precies één schermconfiguratie bevatten."
            )

        # Canonieke press-configuratie. Via ruwe JSON mogen oude action/action_params
        # nog worden aangeleverd; bij opslaan worden die naar short_action omgezet.
        press_groups = (
            config.get("display", {}).get("softkeys", {}).get("keys", {}),
            config.get("navkeys", {}).get("keys", {}),
            config.get("keyboard", {}).get("keys", {}),
            config.get("softradio", {}).get("keys", {}),
            config.get("topkeys", {}).get("keys", {}),
            config.get("leftkeys", {}).get("keys", {}),
            config.get("rightkeys", {}).get("keys", {}),
        )
        for keys in press_groups:
            if not isinstance(keys, dict):
                continue
            for key in keys.values():
                if not isinstance(key, dict):
                    continue
                if key.get("type") == "rotary":
                    for direction in ("counter_clockwise", "clockwise"):
                        action_field = f"action_{direction}"
                        params_field = f"action_params_{direction}"
                        # Legacy rotary short_action wordt éénmalig naar de canonieke directe actie gemigreerd.
                        legacy_action = key.get(f"short_action_{direction}")
                        legacy_params = key.get(f"short_action_params_{direction}")
                        key.setdefault(action_field, legacy_action or key.get(action_field) or key.get("action") or "none")
                        params = key.get(params_field, legacy_params if isinstance(legacy_params, dict) else key.get("action_params", {}))
                        key[params_field] = params if isinstance(params, dict) else {}
                        for legacy in (
                            f"short_action_{direction}", f"short_action_params_{direction}",
                            f"long_action_{direction}", f"long_action_params_{direction}",
                        ):
                            key.pop(legacy, None)
                    key.pop("action", None)
                    key.pop("action_params", None)
                else:
                    key.setdefault("short_action", key.get("action") or "none")
                    old_params = key.get("action_params", {})
                    key.setdefault("short_action_params", old_params if isinstance(old_params, dict) else {})
                    key.pop("action", None)
                    key.pop("action_params", None)

                # Hardware-keycodes worden canoniek als tekst opgeslagen.
                # Android levert numerieke KeyEvent-codes, maar string-opslag houdt
                # JSON/schema eenvoudig en laat desgewenst ook named browser keys toe.
                for hw_field in ("hw_key", "hw_key_clockwise", "hw_key_counter_clockwise", "hw_scan_code", "hw_scan_code_clockwise", "hw_scan_code_counter_clockwise"):
                    if hw_field not in key:
                        continue
                    raw = key.get(hw_field)
                    if raw in ("", None):
                        key[hw_field] = None
                    else:
                        key[hw_field] = str(raw).strip()

        if tenant:
            groups = (
                config.get("display", {}).get("softkeys", {}).get("keys", {}),
                config.get("navkeys", {}).get("keys", {}),
                config.get("keyboard", {}).get("keys", {}),
                config.get("softradio", {}).get("keys", {}),
                config.get("topkeys", {}).get("keys", {}),
                config.get("leftkeys", {}).get("keys", {}),
                config.get("rightkeys", {}).get("keys", {}),
            )

            actions = []
            for keys in groups:
                for key in keys.values():
                    if not isinstance(key, dict):
                        continue
                    actions.append((key.get("short_action", key.get("action")), key.get("short_action_params", key.get("action_params", {}))))
                    actions.append((key.get("long_action"), key.get("long_action_params", {})))
                    for direction in ("counter_clockwise", "clockwise"):
                        actions.append((
                            key.get(f"short_action_{direction}", key.get(f"action_{direction}")),
                            key.get(f"short_action_params_{direction}", key.get(f"action_params_{direction}", {})),
                        ))
                        actions.append((key.get(f"long_action_{direction}"), key.get(f"long_action_params_{direction}", {})))

            screen_targets = {
                params.get("screen")
                for action, params in actions
                if action == "screen_open" and isinstance(params, dict)
            }
            screen_targets.discard(None)
            screen_targets.discard("")
            existing = set(
                Screen.objects.filter(
                    tenant=tenant,
                    hardware_profile=hardware_profile,
                    name__in=screen_targets,
                ).values_list("name", flat=True)
            )
            missing = sorted(screen_targets - existing)
            own_name = self.cleaned_data.get("name")
            if own_name in missing:
                missing.remove(own_name)
            if missing:
                raise forms.ValidationError(
                    "Onbekende doelschermen binnen deze tenant: " + ", ".join(missing)
                )

            channel_targets = {
                params.get("channel")
                for action, params in actions
                if action == "channel_select" and isinstance(params, dict)
            }
            channel_targets.discard(None)
            channel_targets.discard("")
            existing_channels = set(
                Channel.objects.filter(tenant=tenant, slug__in=channel_targets).values_list("slug", flat=True)
            )
            missing_channels = sorted(channel_targets - existing_channels)
            if missing_channels:
                raise forms.ValidationError(
                    "Onbekende doelkanalen binnen deze tenant: " + ", ".join(missing_channels)
                )

            status_targets = {
                params.get("status")
                for action, params in actions
                if action == "status_select" and isinstance(params, dict)
            }
            status_targets.discard(None)
            status_targets.discard("")
            existing_statuses = set(
                UserStatus.objects.filter(tenant=tenant, slug__in=status_targets).values_list("slug", flat=True)
            )
            missing_statuses = sorted(status_targets - existing_statuses)
            if missing_statuses:
                raise forms.ValidationError(
                    "Onbekende statussen binnen deze tenant: " + ", ".join(missing_statuses)
                )

        if hardware_profile:
            validate_button_subset(config, hardware_profile.hardware_config.config)

        return config



class HardwareProfileAdminForm(forms.ModelForm):
    class Meta:
        model = HardwareProfile
        fields = "__all__"
        widgets = {"config": OverrideConfigWidget()}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        tenant_id = self.data.get("tenant") if self.is_bound else None
        if not tenant_id and self.instance and self.instance.pk:
            tenant_id = self.instance.tenant_id
        if not tenant_id and self.initial.get("tenant"):
            tenant = self.initial["tenant"]
            tenant_id = getattr(tenant, "pk", tenant)

        parent_configs = {
            str(item.pk): {"base": item.config, "allowed": item.config}
            for item in HardwareConfig.objects.all().order_by("name")
        }
        screen_choices = []
        channel_choices = []
        status_choices = []
        if tenant_id:
            screen_choices = list(
                Screen.objects.filter(tenant_id=tenant_id).order_by("name").values_list("name", flat=True)
            )
            channel_choices = list(
                Channel.objects.filter(tenant_id=tenant_id, status=Channel.Status.ACTIVE)
                .order_by("name").values_list("slug", "name")
            )
            status_choices = _status_choices_for_tenant(tenant_id)
        self.fields["config"].widget = OverrideConfigWidget(
            screen_choices=screen_choices,
            channel_choices=channel_choices,
            status_choices=status_choices,
            parent_configs=parent_configs,
            parent_select_id="id_hardware_config",
        )
        self.fields["config"].help_text = (
            "Kies alleen de knoppen die dit hardwareprofiel overschrijft. "
            "Niet gekozen knoppen erven van HardwareConfig."
        )

    def clean_config(self):
        config = self.cleaned_data.get("config") or {}
        hardware_config = self.cleaned_data.get("hardware_config")
        if not isinstance(config, dict):
            raise forms.ValidationError("De profielconfiguratie moet een JSON-object zijn.")
        if hardware_config:
            validate_button_subset(config, hardware_config.config)
        return config


class HardwareAdminForm(forms.ModelForm):
    class Meta:
        model = HardwareConfig
        fields = "__all__"
        widgets = {"config": ScreenConfigWidget()}
