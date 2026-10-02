from django.contrib.auth import get_user_model
from rest_framework import serializers
from drf_spectacular.utils import OpenApiTypes, extend_schema_field
from engine_main.models import Tenant
from engine_poc.models import (Channel, UserStatus,
                        DeviceSession, ChannelState, EventLog, EventAttachment)
from engine_radio.models import HardwareConfig, HardwareProfile, RadioUser, Screen, UserProfile


class TenantSerializer(serializers.ModelSerializer):
    logo_url = serializers.SerializerMethodField()

    class Meta:
        model = Tenant
        fields = "__all__"
        read_only_fields = ("created_at_ms", "last_update_ms", "logo_url")

    def get_logo_url(self, obj) -> str | None:
        if not obj.logo:
            return None
        request = self.context.get("request")
        return request.build_absolute_uri(obj.logo.url) if request else obj.logo.url

    def validate_logo(self, value):
        if value and value.size > 5 * 1024 * 1024:
            raise serializers.ValidationError("Logo mag maximaal 5 MB zijn.")
        return value


class RadioUserSerializer(serializers.ModelSerializer):
    user_profile_slug = serializers.SlugRelatedField(
        source="user_profile", slug_field="slug", queryset=UserProfile.objects.all(),
        allow_null=True, required=False,
    )
    hardware_profile_slug = serializers.SlugRelatedField(
        source="hardware_profile", slug_field="slug", queryset=HardwareProfile.objects.all(),
        allow_null=True, required=False,
    )
    user_status_slug = serializers.SlugRelatedField(
        source="user_status", slug_field="slug", queryset=UserStatus.objects.all(),
        allow_null=True, required=False,
    )
    user_contact_status_slug = serializers.SlugRelatedField(
        source="user_contact_status", slug_field="slug", queryset=UserStatus.objects.all(),
        allow_null=True, required=False,
    )
    frontend_status = serializers.SerializerMethodField()
    last_location = serializers.SerializerMethodField()
    current_channel_slug = serializers.SlugRelatedField(
        source="current_channel", slug_field="slug", queryset=Channel.objects.all(),
        allow_null=True, required=False,
    )
    django_username = serializers.CharField(write_only=True, required=False)
    django_usernames = serializers.ListField(
        child=serializers.CharField(), write_only=True, required=False,
    )

    class Meta:
        model = RadioUser
        exclude = (
            "secret_key_hash", "user_profile", "hardware_profile",
            "user_status", "user_contact_status", "current_channel", "django_users",
        )
        read_only_fields = (
            "created_at_ms", "last_update_ms", "device_status",
            "last_location", "last_location_accuracy_m", "last_location_at_ms",
        )

    def get_frontend_status(self, obj) -> dict | None:
        status = obj.frontend_status
        if not status:
            return None
        return {
            "id": status.pk, "slug": status.slug,
            "label_short": status.display_code, "label_long": status.display_label or status.display_status,
            "call_request_priority": status.call_request_priority,
        }


    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_last_location(self, obj) -> dict | None:
        if not obj.last_location:
            return None
        return {"type": "Point", "coordinates": [obj.last_location.x, obj.last_location.y]}

    def create(self, validated_data):
        username = validated_data.pop("django_username", None)
        usernames = validated_data.pop("django_usernames", None)
        requested_usernames = list(dict.fromkeys(usernames or ([username] if username else [])))
        django_users = list(get_user_model().objects.filter(username__in=requested_usernames))
        if len(django_users) != len(requested_usernames):
            raise serializers.ValidationError({"django_usernames": "Een of meer Django-gebruikers zijn onbekend."})
        obj = RadioUser(**validated_data)
        obj.secret_key_hash = "!"
        obj.full_clean()
        obj.save()
        obj.django_users.set(django_users)
        return obj

    def update(self, instance, validated_data):
        username = validated_data.pop("django_username", None)
        usernames = validated_data.pop("django_usernames", None)
        requested_usernames = None
        if usernames is not None or username is not None:
            requested_usernames = list(dict.fromkeys(usernames or ([username] if username else [])))
            django_users = list(get_user_model().objects.filter(username__in=requested_usernames))
            if len(django_users) != len(requested_usernames):
                raise serializers.ValidationError({"django_usernames": "Een of meer Django-gebruikers zijn onbekend."})
        instance = super().update(instance, validated_data)
        if requested_usernames is not None:
            instance.django_users.set(django_users)
        return instance

    def validate(self, attrs):
        tenant = self.context.get("tenant")
        if tenant:
            mapping = {
                "user_profile": "user_profile_slug",
                "hardware_profile": "hardware_profile_slug",
                "user_status": "user_status_slug",
                "user_contact_status": "user_contact_status_slug",
                "current_channel": "current_channel_slug",
            }
            errors = {}
            for field, api_field in mapping.items():
                obj = attrs.get(field)
                if obj and obj.tenant_id != tenant.id:
                    errors[api_field] = "Object hoort bij een andere tenant."
            if errors:
                raise serializers.ValidationError(errors)
        return attrs


class UserStatusSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserStatus
        fields = "__all__"
        read_only_fields = ("created_at_ms", "last_update_ms", "tenant")


class ChannelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Channel
        fields = "__all__"
        read_only_fields = ("created_at_ms", "last_update_ms", "tenant")


class UserProfileSerializer(serializers.ModelSerializer):
    channel_slugs = serializers.SlugRelatedField(
        source="channels", many=True, slug_field="slug",
        queryset=Channel.objects.all(), required=False,
    )
    user_slugs = serializers.SlugRelatedField(
        source="radio_users", many=True, slug_field="slug", read_only=True,
    )

    class Meta:
        model = UserProfile
        exclude = ("channels",)
        read_only_fields = (
            "created_at_ms", "last_update_ms", "tenant", "user_slugs",
        )

    def validate(self, attrs):
        tenant = self.context["tenant"]
        for channel in attrs.get("channels", []):
            if channel.tenant_id != tenant.id:
                raise serializers.ValidationError({
                    "channel_slugs": "Kanaal hoort bij een andere tenant."
                })
        return attrs


class ScreenSerializer(serializers.ModelSerializer):
    resolved_config = serializers.JSONField(read_only=True)

    class Meta:
        model = Screen
        fields = "__all__"
        read_only_fields = ("created_at_ms", "last_update_ms", "tenant")


class HardwareProfileSerializer(serializers.ModelSerializer):
    user_slugs = serializers.SlugRelatedField(
        source="radio_users", many=True, slug_field="slug", read_only=True
    )
    resolved_config = serializers.JSONField(read_only=True)

    class Meta:
        model = HardwareProfile
        fields = "__all__"
        read_only_fields = ("created_at_ms", "last_update_ms", "tenant", "user_slugs")



class HardwareConfigSerializer(serializers.ModelSerializer):
    class Meta:
        model = HardwareConfig
        fields = "__all__"
        read_only_fields = ("created_at_ms", "last_update_ms")


class DeviceSessionSerializer(serializers.ModelSerializer):
    user_slug = serializers.SerializerMethodField()
    user_name = serializers.SerializerMethodField()
    device_type = serializers.SerializerMethodField()
    current_channel_slug = serializers.CharField(source="current_channel.slug", read_only=True)

    def get_user_slug(self, obj) -> str:
        return obj.actor_slug

    def get_user_name(self, obj) -> str:
        return obj.actor_name

    def get_device_type(self, obj) -> str:
        return obj.role

    class Meta:
        model = DeviceSession
        exclude = ("session_token_hash",)
        read_only_fields = tuple(f.name for f in DeviceSession._meta.fields if f.name != "session_token_hash")


class ChannelStateSerializer(serializers.ModelSerializer):
    channel_slug = serializers.CharField(source="channel.slug", read_only=True)
    class Meta:
        model = ChannelState
        exclude = ("floor_token_hash", "active_session", "pending_session", "tenant", "channel")
        read_only_fields = tuple(f.name for f in ChannelState._meta.fields if f.name not in {"floor_token_hash", "active_session", "pending_session", "tenant", "channel"})


class EventAttachmentSerializer(serializers.ModelSerializer):
    content_url = serializers.SerializerMethodField()

    class Meta:
        model = EventAttachment
        exclude = ("file",)
        read_only_fields = tuple(f.name for f in EventAttachment._meta.fields) + ("content_url",)

    def get_content_url(self, obj) -> str:
        request = self.context.get("request")
        path = f"/poc/api/v1/tenants/{obj.tenant.slug}/events/{obj.event_id}/attachments/{obj.pk}/content/"
        return request.build_absolute_uri(path) if request else path


class EventLogSerializer(serializers.ModelSerializer):
    attachments = EventAttachmentSerializer(many=True, read_only=True)
    location = serializers.SerializerMethodField()

    @extend_schema_field(OpenApiTypes.OBJECT)
    def get_location(self, obj) -> dict | None:
        if not obj.location:
            return None
        return {"type": "Point", "coordinates": [obj.location.x, obj.location.y]}
    class Meta:
        model = EventLog
        fields = "__all__"
        read_only_fields = tuple(f.name for f in EventLog._meta.fields) + ("attachments",)


class SessionLoginSerializer(serializers.Serializer):
    tenant_slug = serializers.CharField()
    user_slug = serializers.CharField()
    secret_key = serializers.CharField(trim_whitespace=False)
    device_identifier = serializers.CharField(max_length=200)


class PTTRequestSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(max_length=200)
    request_type = serializers.ChoiceField(choices=("normal", "emergency"), default="normal")


class PTTReleaseSerializer(serializers.Serializer):
    client_request_id = serializers.CharField(max_length=200)
    floor_token = serializers.CharField()


class WebRTCTokenSerializer(serializers.Serializer):
    channel_slug = serializers.SlugField()


class HeartbeatSerializer(serializers.Serializer):
    heartbeat_id = serializers.CharField(max_length=200)
    sent_at_ms = serializers.IntegerField(required=False)
    telemetry = serializers.JSONField(required=False)

class LocationUpdateSerializer(serializers.Serializer):
    latitude = serializers.FloatField(min_value=-90.0, max_value=90.0)
    longitude = serializers.FloatField(min_value=-180.0, max_value=180.0)
    accuracy_m = serializers.FloatField(min_value=0.0)
    timestamp_ms = serializers.IntegerField(required=False)
