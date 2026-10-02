(() => {
  "use strict";

  const tenant = document.body.dataset.tenantSlug || "";
  const groupHost = document.getElementById("networkLinkGroups");
  const groupCardsHost = document.getElementById("networkLinkGroupsCards") || groupHost;
  const privateCallsHost = document.getElementById("networkPrivateCalls");
  const grid = document.getElementById("networkChannelGrid");
  const feedback = document.getElementById("networkFeedback");
  if (!tenant || !grid) return;

  let state = { channels: [], link_groups: [], unassigned: [] };
  let refreshTimer = null;
  let dragRadioId = null;
  let dragChannelId = null;
  let requestInFlight = false;
  let radioFilter = "online";
  let pendingLinkChannelId = null;
  const pendingRadioMoves = new Map();   // radioId -> {targetId, startedAt}
  const pendingChannelLinks = new Map(); // "source:target" -> {sourceId,targetId,confirmedAt}

  const inlineHost = document.getElementById("addressBookNetworkView");

  function inlineNetworkVisible() {
    return !inlineHost || !inlineHost.hidden;
  }

  function layoutNetworkGrid() {
    const board = document.querySelector(".network-board");
    if (!board || !grid || !groupHost) return;
    const available = Math.max(0, board.clientWidth);
    if (!available) return;
    const gap = 8;

    // De CSS verdeelt de board als 5fr + 1fr: vijf gelijke kanaalkolommen
    // en één linked-kolom met exact dezelfde effectieve kaartbreedte.
    // Gebruik de berekende 1/6-breedte alleen nog voor de UI-schaalfactor;
    // zet geen vaste px-breedte meer op de gridtracks, zodat scrollbar-gutters
    // niet alleen de linked-kolom visueel smaller kunnen maken.
    const columnWidth = Math.max(1, (available - (gap * 5)) / 6);
    board.style.removeProperty("--network-column-width");

    // Tekst schaalt mee met de kolombreedte.
    // 240px kolombreedte = schaal 1.0; smaller scherm = proportioneel kleiner.
    const scale = Math.max(0.62, Math.min(1, columnWidth / 240));
    board.style.setProperty("--network-ui-scale", String(scale));
  }

  function refreshWhenVisible() {
    if (document.visibilityState === "visible" && inlineNetworkVisible() && !dragRadioId && !dragChannelId) {
      void loadState();
    }
  }

  function cookieValue(name) {
    const prefix = `${name}=`;
    return document.cookie.split(";").map(v => v.trim()).find(v => v.startsWith(prefix))?.slice(prefix.length) || "";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[ch]));
  }

  function sortByName(items) {
    return [...(items || [])].sort((a, b) => String(a?.name || "").localeCompare(String(b?.name || ""), "nl", { sensitivity: "base" }));
  }

  function statusBadge(radio) {
    // Displaycode kan numeriek zijn (bijv. 1), maar de fallback buiten het
    // dispatch-statusschema is bewust de technische naam (bijv. brw01).
    const rawCode = String(radio.status_code ?? "").trim();
    const code = rawCode || "–";
    const bg = radio.status_bg || "#495057";
    const border = radio.status_border || "#212529";
    return `<span class="network-status-badge" style="--network-status-bg:${escapeHtml(bg)};--network-status-border:${escapeHtml(border)}">${escapeHtml(code)}</span>`;
  }

  function connectionClass(value) {
    if (value === "connected") return "is-connected";
    if (value === "degraded") return "is-degraded";
    return "is-offline";
  }

  function radioVisible(radio) {
    if (radioFilter === "hidden") return false;
    return radioFilter === "all" || radio?.connection !== "offline";
  }

  function updateFilterButtons() {
    document.querySelectorAll("[data-network-radio-filter]").forEach(button => {
      const active = button.dataset.networkRadioFilter === radioFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function isRadioMovePending(radioId) {
    return pendingRadioMoves.has(String(radioId));
  }

  function pendingChannelIdSet() {
    const ids = new Set();
    for (const pending of pendingChannelLinks.values()) {
      ids.add(String(pending.sourceId));
      ids.add(String(pending.targetId));
    }
    if (pendingLinkChannelId) ids.add(String(pendingLinkChannelId));
    return ids;
  }

  function isChannelLinkPending(channelId) {
    return pendingChannelIdSet().has(String(channelId));
  }

  function pendingTimerIcon() {
    return '<span class="material-symbols-rounded" aria-hidden="true">timer</span>';
  }

  function actorRow(actor, kind, draggable=false) {
    const pending = kind === "radio" && isRadioMovePending(actor.id);
    const icon = pending ? "timer" : (kind === "dispatch" ? "support_agent" : "mobile");
    const status = kind === "radio" ? statusBadge(actor) : '<span class="network-status-badge network-status-neutral">–</span>';
    const dragAttrs = draggable && !pending ? ` draggable="true" data-radio-id="${escapeHtml(actor.id)}"` : "";
    return `<div class="network-actor-row ${draggable && !pending ? "is-draggable" : ""}${pending ? " is-pending-move" : ""}" data-kind="${kind}"${dragAttrs}>
      <div class="network-actor-icon ${pending ? "is-pending" : connectionClass(actor.connection)}"><span class="material-symbols-rounded" aria-hidden="true">${icon}</span></div>
      <div class="network-actor-name">${escapeHtml(actor.name)}</div>
      <div class="network-actor-status">${status}</div>
    </div>`;
  }

  function section(title, actors, kind, draggable=false) {
    const filteredActors = kind === "radio" ? (actors || []).filter(radioVisible) : (actors || []);
    const sortedActors = sortByName(filteredActors);
    const rows = sortedActors.length
      ? sortedActors.map(actor => actorRow(actor, kind, draggable)).join("")
      : "";
    if (!rows) return "";
    return `<section class="network-card-section network-card-section-compact" aria-label="${escapeHtml(title)}">
      <div class="network-actor-list">${rows}</div>
    </section>`;
  }

  function linkedSection(channel) {
    const links = sortByName(channel.links || []);
    if (!links.length) return "";
    const names = links.map(link => link.name).join(" · ");
    return `<section class="network-card-section network-linked-section-one" aria-label="Gekoppelde kanalen">
      <div class="network-channel-linkbar">
        <span class="material-symbols-rounded network-channel-linkbar-icon" aria-hidden="true">flowchart</span>
        <span class="network-channel-linkbar-names">${escapeHtml(names)}</span>
        <button type="button"
                class="network-channel-group-remove"
                data-remove-channel="${escapeHtml(channel.id)}"
                title="${escapeHtml(channel.name)} uit linkgroep verwijderen"
                aria-label="${escapeHtml(channel.name)} uit linkgroep verwijderen">
          <span class="material-symbols-rounded" aria-hidden="true">portable_wifi_off</span>
        </button>
      </div>
    </section>`;
  }

  function card(channel) {
    const pending = isChannelLinkPending(channel.id);
    return `<article class="network-channel-card${pending ? " is-pending-link" : ""}" data-channel-id="${escapeHtml(channel.id)}">
      <header class="network-channel-card-head" ${pending ? "" : 'draggable="true"'} data-drag-channel-id="${escapeHtml(channel.id)}" title="${pending ? "Koppeling wordt verwerkt" : "Sleep dit kanaal naar een ander kanaal of een linkgroep"}">
        <span class="material-symbols-rounded" aria-hidden="true">${pending ? "timer" : "cell_tower"}</span>
        <h2>${escapeHtml(channel.name)}</h2>
      </header>
      ${linkedSection(channel)}
      ${section("Dispatchers", channel.dispatchers || [], "dispatch", false)}
      ${section("Radio's", channel.radios || [], "radio", true)}
      <div class="network-card-empty-area" aria-hidden="true"></div>
    </article>`;
  }

  function unassignedCard(radios) {
    radios = (radios || []).filter(radioVisible);
    if (!radios.length) return "";
    return `<article class="network-channel-card network-unassigned-card" data-channel-id="">
      <header class="network-channel-card-head">
        <span class="material-symbols-rounded" aria-hidden="true">link_off</span>
        <h2>Niet toegewezen</h2>
      </header>
      ${section("Radio's", radios, "radio", true)}
      <div class="network-card-empty-area" aria-hidden="true"></div>
    </article>`;
  }

  function linkGroupCard(group) {
    const members = sortByName(group.channels || []);
    if (members.length < 2) return "";
    const targetId = members[0]?.id || "";
    const pending = members.some(member => isChannelLinkPending(member.id));
    return `<article class="network-linkgroup-card${pending ? " is-pending-link" : ""}" data-link-group-target="${escapeHtml(targetId)}" aria-label="Linkgroep">
      <header class="network-linkgroup-card-head">
        <span class="material-symbols-rounded" aria-hidden="true">${pending ? "timer" : "flowchart"}</span>
        <span class="network-linkgroup-card-title">Gekoppeld</span>
        <button type="button"
                class="network-linkgroup-clear"
                data-clear-link-group="${escapeHtml(targetId)}"
                title="Alle koppelingen in deze linkgroep verbreken"
                aria-label="Alle koppelingen in deze linkgroep verbreken">
          <span class="material-symbols-rounded" aria-hidden="true">portable_wifi_off</span>
        </button>
      </header>
      <div class="network-linkgroup-card-members">
        ${members.map(member => `<div class="network-linkgroup-member-card" data-link-group-member="${escapeHtml(member.id)}">
          <span class="material-symbols-rounded network-linkgroup-member-icon" aria-hidden="true">flowchart</span>
          <span class="network-linkgroup-name">${escapeHtml(member.name)}</span>
          <button type="button"
                  class="network-linkgroup-remove"
                  data-remove-channel="${escapeHtml(member.id)}"
                  title="${escapeHtml(member.name)} uit linkgroep verwijderen"
                  aria-label="${escapeHtml(member.name)} uit linkgroep verwijderen">
            <span class="material-symbols-rounded" aria-hidden="true">portable_wifi_off</span>
          </button>
        </div>`).join("")}
      </div>
      <div class="network-card-empty-area network-linkgroup-drop-area" aria-hidden="true"></div>
    </article>`;
  }

  function pendingChannel() {
    if (!pendingLinkChannelId) return null;
    return (state.channels || []).find(channel => String(channel.id) === String(pendingLinkChannelId)) || null;
  }

  function privateCallCards() {
    const calls = state.private_calls || [];
    return calls.map(call => {
      const title = call.title || call.name || call.target_name || "Privé gesprek";
      const stateLabel = call.state_label || call.state || "actief";
      const initiator = call.initiator_name || call.dispatcher_name || "Onbekend";
      const participants = (call.participants || []).map(item => item.name || item).filter(Boolean).join(" · ") || (call.target_name || "-");
      return `<article class="network-privatecall-card" aria-label="Privégesprek">
        <header class="network-privatecall-card-head">
          <span class="material-symbols-rounded" aria-hidden="true">phone_locked</span>
          <span class="network-privatecall-card-title">${escapeHtml(title)}</span>
          <span class="network-privatecall-card-state">${escapeHtml(stateLabel)}</span>
        </header>
        <div class="network-privatecall-card-body">
          <div class="network-privatecall-line">
            <span class="network-privatecall-label">Initiator</span>
            <span class="network-privatecall-value">${escapeHtml(initiator)}</span>
          </div>
          <div class="network-privatecall-line">
            <span class="network-privatecall-label">Deelnemers</span>
            <span class="network-privatecall-value">${escapeHtml(participants)}</span>
          </div>
        </div>
      </article>`;
    }).join("");
  }

  function emptyLinkGroupCard() {
    const pending = pendingChannel();
    return `<article class="network-linkgroup-card network-linkgroup-empty-card${pending ? " has-pending" : ""}" data-empty-link-group="true" aria-label="Nieuwe linkgroep">
      <header class="network-linkgroup-card-head">
        <span class="material-symbols-rounded" aria-hidden="true">${pending ? "timer" : "flowchart"}</span>
        <span class="network-linkgroup-card-title">Nieuwe koppeling</span>
      </header>
      <div class="network-linkgroup-card-members">
        ${pending ? `<div class="network-linkgroup-member-card network-linkgroup-member-pending is-pending-link">
          <span class="material-symbols-rounded network-linkgroup-member-icon" aria-hidden="true">timer</span>
          <span class="network-linkgroup-name">${escapeHtml(pending.name)}</span>
        </div>` : ""}
      </div>
      <div class="network-card-empty-area network-linkgroup-drop-area" aria-hidden="true"></div>
    </article>`;
  }

  function render() {
    updateFilterButtons();
    if (groupHost) {
      // Nieuwe linkgroep altijd bovenaan, bestaande groepen daaronder.
      groupCardsHost.innerHTML = emptyLinkGroupCard() + (state.link_groups || []).map(linkGroupCard).join("");
      const calls = state.private_calls || [];
      if (privateCallsHost) {
        privateCallsHost.innerHTML = privateCallCards();
        privateCallsHost.hidden = calls.length === 0;
      }
      groupHost.hidden = false;
    }
    grid.innerHTML = sortByName(state.channels).map(card).join("") + unassignedCard(sortByName(state.unassigned || []));
    layoutNetworkGrid();
    bindInteractions();
  }

  function setFeedback(message, isError=false) {
    if (!feedback) return;
    feedback.textContent = message || "";
    feedback.classList.toggle("error", !!isError);
  }

  function findRadioInState(radioId) {
    const id = String(radioId);
    for (const channel of state.channels || []) {
      const radio = (channel.radios || []).find(item => String(item.id) === id);
      if (radio) return {radio, channelId:String(channel.id)};
    }
    const radio = (state.unassigned || []).find(item => String(item.id) === id);
    return radio ? {radio, channelId:""} : null;
  }

  function reconcilePendingOperations() {
    let needsDelayedRender = false;

    for (const [radioId, pending] of [...pendingRadioMoves.entries()]) {
      const found = findRadioInState(radioId);
      if (
        found &&
        String(found.channelId) === String(pending.targetId) &&
        found.radio?.connection !== "offline"
      ) {
        pendingRadioMoves.delete(radioId);
      }
    }

    for (const [key, pending] of [...pendingChannelLinks.entries()]) {
      const source = (state.channels || []).find(channel => String(channel.id) === String(pending.sourceId));
      const linked = !!source && (source.links || []).some(link => String(link.id) === String(pending.targetId));
      if (!linked) continue;

      if (!pending.confirmedAt) {
        pending.confirmedAt = Date.now();
        needsDelayedRender = true;
        window.setTimeout(() => {
          const current = pendingChannelLinks.get(key);
          if (current && current.confirmedAt && Date.now() - current.confirmedAt >= 900) {
            pendingChannelLinks.delete(key);
            render();
          }
        }, 950);
      } else if (Date.now() - pending.confirmedAt >= 900) {
        pendingChannelLinks.delete(key);
      }
    }

    return needsDelayedRender;
  }

  async function loadState() {
    if (requestInFlight) return;
    requestInFlight = true;
    try {
      const response = await fetch(`/dispatch/${encodeURIComponent(tenant)}/api/network/`, {credentials:"same-origin", cache:"no-store"});
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Netwerkstatus kon niet worden geladen");
      state = payload.data || {channels:[],link_groups:[],unassigned:[]};
      reconcilePendingOperations();
      if (pendingLinkChannelId) {
        const pending = (state.channels || []).find(channel => String(channel.id) === String(pendingLinkChannelId));
        if (!pending || (pending.links || []).length) pendingLinkChannelId = null;
      }
      render();
    } catch (error) {
      setFeedback(error.message || String(error), true);
    } finally {
      requestInFlight = false;
    }
  }

  async function postJson(url, body={}) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": decodeURIComponent(cookieValue("csrftoken")),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "Actie mislukt");
    return payload;
  }

  async function moveRadio(radioId, channelId) {
    if (!radioId || !channelId) return;
    const radioKey = String(radioId);
    pendingRadioMoves.set(radioKey, {targetId:String(channelId), startedAt:Date.now()});
    setFeedback("Radio verplaatsen…");
    render();
    try {
      await postJson(`/dispatch/${encodeURIComponent(tenant)}/api/radios/${encodeURIComponent(radioId)}/channel/`, {channel_id: channelId});
      setFeedback("Radio opnieuw verbinden…");
      await loadState();
      window.setTimeout(() => void loadState(), 900);
      window.setTimeout(() => void loadState(), 2200);
      window.setTimeout(() => setFeedback(""), 2500);
    } catch (error) {
      pendingRadioMoves.delete(radioKey);
      setFeedback(error.message || String(error), true);
      await loadState();
    }
  }

  async function linkChannels(sourceId, targetId) {
    if (!sourceId || !targetId || String(sourceId) === String(targetId)) return;
    const sourceKey = String(sourceId);
    const targetKey = String(targetId);
    const pendingKey = `${sourceKey}:${targetKey}`;
    pendingChannelLinks.set(pendingKey, {sourceId:sourceKey, targetId:targetKey, confirmedAt:0});
    setFeedback("Kanalen koppelen…");
    render();
    try {
      await postJson(`/dispatch/${encodeURIComponent(tenant)}/api/channels/${encodeURIComponent(sourceId)}/links/`, {target_channel_id: targetId});
      pendingLinkChannelId = null;
      setFeedback("Kanalen opnieuw verbinden…");
      await loadState();
      window.setTimeout(() => void loadState(), 1000);
      window.setTimeout(() => setFeedback(""), 2500);
    } catch (error) {
      pendingChannelLinks.delete(pendingKey);
      setFeedback(error.message || String(error), true);
      await loadState();
    }
  }

  async function clearWholeLinkGroup(channelId) {
    if (!channelId) return;
    setFeedback("Alle koppelingen verbreken…");
    try {
      await postJson(`/dispatch/${encodeURIComponent(tenant)}/api/channels/${encodeURIComponent(channelId)}/links/clear/`);
      setFeedback("Linkgroep verbroken");
      await loadState();
      window.setTimeout(() => setFeedback(""), 1500);
    } catch (error) {
      setFeedback(error.message || String(error), true);
      await loadState();
    }
  }

  async function removeChannelFromGroup(channelId) {
    if (!channelId) return;
    setFeedback("Kanaal uit linkgroep verwijderen…");
    try {
      await postJson(`/dispatch/${encodeURIComponent(tenant)}/api/channels/${encodeURIComponent(channelId)}/links/remove/`);
      setFeedback("Kanaal uit linkgroep verwijderd");
      await loadState();
      window.setTimeout(() => setFeedback(""), 1500);
    } catch (error) {
      setFeedback(error.message || String(error), true);
      await loadState();
    }
  }

  function clearDropTargets() {
    document.querySelectorAll(".network-channel-card.is-drop-target,.network-channel-card.is-link-drop-target,.network-linkgroup-card.is-link-drop-target")
      .forEach(element => element.classList.remove("is-drop-target", "is-link-drop-target"));
  }

  function bindInteractions() {
    document.querySelectorAll('[data-clear-link-group]').forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        void clearWholeLinkGroup(button.dataset.clearLinkGroup || "");
      });
    });

    document.querySelectorAll('[data-remove-channel]').forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        void removeChannelFromGroup(button.dataset.removeChannel || "");
      });
    });

    grid.querySelectorAll('.network-channel-card-head[data-drag-channel-id]').forEach(header => {
      header.addEventListener("dragstart", event => {
        dragChannelId = header.dataset.dragChannelId || null;
        dragRadioId = null;
        header.classList.add("is-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "link";
          event.dataTransfer.setData("text/x-dispatch-channel", dragChannelId || "");
          event.dataTransfer.setData("text/plain", `channel:${dragChannelId || ""}`);
        }
      });
      header.addEventListener("dragend", () => {
        dragChannelId = null;
        header.classList.remove("is-dragging");
        clearDropTargets();
      });
    });

    grid.querySelectorAll('.network-actor-row[data-radio-id]').forEach(row => {
      row.addEventListener("dragstart", event => {
        dragRadioId = row.dataset.radioId || null;
        dragChannelId = null;
        row.classList.add("is-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/x-dispatch-radio", dragRadioId || "");
          event.dataTransfer.setData("text/plain", `radio:${dragRadioId || ""}`);
        }
      });
      row.addEventListener("dragend", () => {
        dragRadioId = null;
        row.classList.remove("is-dragging");
        clearDropTargets();
      });
    });

    grid.querySelectorAll('.network-channel-card[data-channel-id]').forEach(channelCard => {
      const channelId = channelCard.dataset.channelId || "";
      if (!channelId) return;

      channelCard.addEventListener("dragover", event => {
        if (dragChannelId && String(dragChannelId) !== String(channelId)) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
          channelCard.classList.add("is-link-drop-target");
          channelCard.classList.remove("is-drop-target");
          return;
        }
        if (dragRadioId) {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          channelCard.classList.add("is-drop-target");
          channelCard.classList.remove("is-link-drop-target");
        }
      });

      channelCard.addEventListener("dragleave", event => {
        if (!channelCard.contains(event.relatedTarget)) channelCard.classList.remove("is-drop-target", "is-link-drop-target");
      });

      channelCard.addEventListener("drop", event => {
        event.preventDefault();
        channelCard.classList.remove("is-drop-target", "is-link-drop-target");

        const sourceChannel = dragChannelId || event.dataTransfer?.getData("text/x-dispatch-channel") || "";
        if (sourceChannel && String(sourceChannel) !== String(channelId)) {
          dragChannelId = null;
          void linkChannels(sourceChannel, channelId);
          return;
        }

        const radioId = dragRadioId || event.dataTransfer?.getData("text/x-dispatch-radio") || "";
        if (radioId) {
          dragRadioId = null;
          void moveRadio(radioId, channelId);
        }
      });
    });

    if (groupHost) {
      groupHost.querySelectorAll('.network-linkgroup-card[data-link-group-target]').forEach(groupCard => {
        const targetId = groupCard.dataset.linkGroupTarget || "";
        groupCard.addEventListener("dragover", event => {
          if (!dragChannelId || !targetId || String(dragChannelId) === String(targetId)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
          groupCard.classList.add("is-link-drop-target");
        });
        groupCard.addEventListener("dragleave", event => {
          if (!groupCard.contains(event.relatedTarget)) groupCard.classList.remove("is-link-drop-target");
        });
        groupCard.addEventListener("drop", event => {
          event.preventDefault();
          groupCard.classList.remove("is-link-drop-target");
          const sourceChannel = dragChannelId || event.dataTransfer?.getData("text/x-dispatch-channel") || "";
          if (sourceChannel && targetId && String(sourceChannel) !== String(targetId)) {
            dragChannelId = null;
            void linkChannels(sourceChannel, targetId);
          }
        });
      });

      const emptyCard = groupHost.querySelector('.network-linkgroup-empty-card[data-empty-link-group="true"]');
      if (emptyCard) {
        emptyCard.addEventListener("dragover", event => {
          // Alleen kanalen mogen naar de lege linkgroup-card; radio's nooit.
          if (!dragChannelId) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "link";
          emptyCard.classList.add("is-link-drop-target");
        });
        emptyCard.addEventListener("dragleave", event => {
          if (!emptyCard.contains(event.relatedTarget)) emptyCard.classList.remove("is-link-drop-target");
        });
        emptyCard.addEventListener("drop", event => {
          event.preventDefault();
          emptyCard.classList.remove("is-link-drop-target");
          const sourceChannel = dragChannelId || event.dataTransfer?.getData("text/x-dispatch-channel") || "";
          dragChannelId = null;
          if (!sourceChannel) return;

          const source = (state.channels || []).find(channel => String(channel.id) === String(sourceChannel));
          if (!source) return;
          if ((source.links || []).length) {
            setFeedback("Dit kanaal zit al in een linkgroep", true);
            return;
          }

          if (!pendingLinkChannelId) {
            pendingLinkChannelId = String(sourceChannel);
            setFeedback("Sleep een tweede kanaal naar deze linkgroep");
            render();
            return;
          }

          if (String(pendingLinkChannelId) === String(sourceChannel)) return;
          const firstChannelId = pendingLinkChannelId;
          void linkChannels(sourceChannel, firstChannelId);
        });
      }
    }
  }

  document.addEventListener("visibilitychange", refreshWhenVisible);

  window.addEventListener("dispatch-address-view", event => {
    if (event.detail?.view === "network") void loadState();
  });

  document.querySelectorAll("[data-network-radio-filter]").forEach(button => {
    button.addEventListener("click", () => {
      const requested = String(button.dataset.networkRadioFilter || "online");
      const next = ["online", "all", "hidden"].includes(requested) ? requested : "online";
      if (next === radioFilter) return;
      radioFilter = next;
      render();
    });
  });
  updateFilterButtons();

  window.addEventListener("resize", layoutNetworkGrid);
  if (inlineNetworkVisible()) void loadState();
  refreshTimer = window.setInterval(refreshWhenVisible, 5000);

  window.DispatchNetwork = {
    refresh: loadState,
    isVisible: inlineNetworkVisible,
  };

  window.addEventListener("beforeunload", () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
  });
})();
