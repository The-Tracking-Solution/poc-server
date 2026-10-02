(() => {
  "use strict";

  const tenant = document.body.dataset.tenantSlug || "";
  const grid = document.getElementById("statesGrid");
  if (!tenant || !grid) return;

  const inlineHost = document.getElementById("addressBookStatesView");
  let timer = null;
  let requestInFlight = false;

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
  }

  function connectionClass(connection) {
    const value = String(connection || "offline").toLowerCase();
    if (value === "connected" || value === "online") return "is-connected";
    if (value === "degraded") return "is-degraded";
    return "is-offline";
  }

  function darkenHex(value, amount) {
    const raw = String(value || "").trim();
    const match = raw.match(/^#([0-9a-f]{6})$/i);
    if (!match) return raw || "#495057";
    const factor = Math.max(0, Math.min(1, 1 - Number(amount || 0)));
    const hex = match[1];
    const parts = [0, 2, 4].map(offset => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * factor));
    return `#${parts.map(part => part.toString(16).padStart(2, "0")).join("")}`;
  }

  function radioRow(radio) {
    const channelId = String(radio.channel_id || "");
    const canSelectTx = Boolean(channelId && radio.channel);
    return `<div class="states-radio-row${canSelectTx ? " is-tx-selectable" : ""}" data-radio-id="${escapeHtml(radio.id || "")}" data-channel-id="${escapeHtml(channelId)}"${canSelectTx ? ' title="Dubbelklik om dit kanaal als TX-kanaal van Dispatch te selecteren"' : ""}>
      <span class="material-symbols-rounded states-radio-icon ${connectionClass(radio.connection)}" aria-hidden="true">mobile</span>
      <span class="states-radio-name">${escapeHtml(radio.name)}</span>
      <small class="states-radio-channel">${escapeHtml(radio.channel || "–")}</small>
    </div>`;
  }

  function statusCard(state) {
    const radios = Array.isArray(state.radios) ? state.radios : [];
    const bright = state.bg || "#495057";
    const banner = darkenHex(bright, 0.34);
    const outline = darkenHex(bright, 0.48);
    return `<article class="states-card" data-fallback="${state.fallback === true ? "true" : "false"}" style="--state-bright:${escapeHtml(bright)};--state-banner:${escapeHtml(banner)};--state-outline:${escapeHtml(outline)}">
      <header class="states-card-head">
        ${state.badge_label ? `<span class="states-card-code">${escapeHtml(state.badge_label)}</span>` : ""}
        <span class="states-card-title">${escapeHtml(state.display_status || state.name)}</span>
        <span class="states-card-count">${radios.length}</span>
      </header>
      <div class="states-card-radios">
        ${radios.map(radioRow).join("")}
      </div>
    </article>`;
  }

  function inlineVisible() {
    return !inlineHost || !inlineHost.hidden;
  }

  async function refresh() {
    if (requestInFlight || !inlineVisible()) return;
    requestInFlight = true;
    try {
      const response = await fetch(`/dispatch/${encodeURIComponent(tenant)}/api/states/`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const states = Array.isArray(payload.data?.states) ? payload.data.states : [];
      grid.innerHTML = states.map(statusCard).join("");
    } catch (error) {
      console.error("states refresh failed", error);
    } finally {
      requestInFlight = false;
    }
  }

  grid.addEventListener("dblclick", event => {
    const row = event.target.closest(".states-radio-row[data-channel-id]");
    if (!row || !grid.contains(row)) return;
    const channelId = String(row.dataset.channelId || "");
    if (!channelId || !window.DispatchRadio?.selectTxChannel) return;
    if (window.DispatchRadio.selectTxChannel(channelId)) {
      event.preventDefault();
      row.classList.add("tx-selected-feedback");
      window.setTimeout(() => row.classList.remove("tx-selected-feedback"), 450);
    }
  });

  window.addEventListener("dispatch-address-view", event => {
    if (event.detail?.view === "states") void refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && inlineVisible()) void refresh();
  });

  if (inlineVisible()) void refresh();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible" && inlineVisible()) void refresh();
  }, 5000);

  window.DispatchStates = {refresh, isVisible:inlineVisible};
})();
