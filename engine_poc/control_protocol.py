def control_group_name(tenant_id: int, channel_id: int) -> str:
    return f"poc-control-{tenant_id}-{channel_id}"


def map_location_group_name(tenant_id: int) -> str:
    return f"poc-map-locations-{tenant_id}"


def tenant_config_group_name(tenant_id: int) -> str:
    return f"poc-config-{tenant_id}"
