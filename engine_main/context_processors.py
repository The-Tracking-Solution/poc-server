import ipaddress


def _site_brand_from_host(host: str) -> str:
    """Return the registrable-looking domain label used as the product title.

    Examples:
    - poc.lifeguardmeldkamer.nl -> lifeguardmeldkamer
    - lifeguardmeldkamer.nl -> lifeguardmeldkamer
    - localhost:8000 -> localhost
    """
    host = (host or "").strip().lower()
    if not host:
        return "lifeguardmeldkamer"

    # Remove a port from normal hostnames. IPv6 literals are left intact below.
    if host.startswith("[") and "]" in host:
        hostname = host[1:host.index("]")]
    else:
        hostname = host.split(":", 1)[0]

    hostname = hostname.rstrip(".")

    if hostname == "localhost":
        return hostname

    try:
        ipaddress.ip_address(hostname)
        return hostname
    except ValueError:
        pass

    labels = [part for part in hostname.split(".") if part]
    if len(labels) >= 2:
        return labels[-2]
    if labels:
        return labels[0]
    return "lifeguardmeldkamer"


def site_brand(request):
    return {"site_brand": _site_brand_from_host(request.get_host())}
