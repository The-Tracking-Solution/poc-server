(() => {
    "use strict";

    function csrfToken() {
        return decodeURIComponent(
            document.cookie.split("; ").find((item) => item.startsWith("csrftoken="))?.split("=")[1] || ""
        );
    }

    async function request(path, method = "GET", body, options = {}) {
        const tenant = window.RADIO_TENANT || "";
        const response = await fetch(`/radio/${encodeURIComponent(tenant)}/api/${path}`, {
            method,
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": csrfToken(),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: options.signal,
        });

        let payload = {};
        try {
            payload = await response.json();
        } catch (_) {
            throw new Error(`Radiofout (${response.status})`);
        }
        if (!response.ok || !payload.ok) {
            throw new Error(payload.error || `Radiofout (${response.status})`);
        }
        return payload.data || {};
    }

    window.RadioApi = { request };
})();
