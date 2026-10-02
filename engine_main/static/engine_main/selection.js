(() => {
  const body = document.body;
  const statusUrl = body.dataset.statusUrl;
  const cards = new Map();
  let serverOffsetMs = Number(body.dataset.serverNowMs || Date.now()) - Date.now();

  document.querySelectorAll("[data-identity-form]").forEach((form) => {
    const key = `${form.dataset.kind}:${form.dataset.id}`;
    cards.set(key, form.querySelector("[data-identity-card]"));
  });

  function nowMs() {
    return Date.now() + serverOffsetMs;
  }

  function formatCountdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }

  function render(card, item) {
    if (!card) return;
    const state = item.state || "free";
    const free = card.querySelector("[data-free]");
    const occupied = card.querySelector("[data-occupied]");
    const occupant = card.querySelector("[data-occupant]");
    const lock = card.querySelector("[data-lock]");
    const countdown = card.querySelector("[data-countdown]");

    card.dataset.state = state;
    card.dataset.selectable = item.selectable ? "true" : "false";
    card.dataset.remainingMs = String(Math.max(0, Number(item.remaining_ms || 0)));
    card.dataset.syncedAtMs = String(nowMs());
    card.classList.remove("identity-state-free", "identity-state-busy", "identity-state-stale");
    card.classList.add(`identity-state-${state}`);

    const isFree = state === "free";
    free.hidden = !isFree;
    occupied.hidden = isFree;
    lock.hidden = state !== "stale";
    occupant.textContent = isFree ? "" : (item.occupant || "Onbekende gebruiker");
    card.disabled = !isFree && !item.selectable;

    if (state === "stale") countdown.textContent = formatCountdown(item.remaining_ms || 0);
  }

  function updateCountdowns() {
    cards.forEach((card) => {
      if (card.dataset.state !== "stale") return;
      const syncedAt = Number(card.dataset.syncedAtMs || nowMs());
      const initialRemaining = Number(card.dataset.remainingMs || 0);
      const remaining = Math.max(0, initialRemaining - (nowMs() - syncedAt));
      const countdown = card.querySelector("[data-countdown]");
      if (countdown) countdown.textContent = formatCountdown(remaining);
      if (remaining <= 0) {
        render(card, {state: "free", occupant: "", remaining_ms: 0, selectable: true});
      }
    });
  }

  async function refreshStatus() {
    if (!statusUrl) return;
    try {
      const response = await fetch(statusUrl, {headers: {"Accept": "application/json"}, cache: "no-store"});
      if (!response.ok) return;
      const data = await response.json();
      if (Number.isFinite(Number(data.server_now_ms))) {
        serverOffsetMs = Number(data.server_now_ms) - Date.now();
      }
      (data.items || []).forEach((item) => render(cards.get(`${item.kind}:${item.id}`), item));
    } catch (_) {
      // De bestaande kaartstatus blijft zichtbaar wanneer de statuscheck tijdelijk faalt.
    }
  }

  // Initialiseer de server-rendered timers met een synchronisatiemoment.
  cards.forEach((card) => {
    card.dataset.syncedAtMs = String(nowMs());
    if (card.dataset.state === "stale") {
      const countdown = card.querySelector("[data-countdown]");
      if (countdown) countdown.textContent = formatCountdown(Number(card.dataset.remainingMs || 0));
    }
  });

  setInterval(updateCountdowns, 1000);
  setInterval(refreshStatus, 5000);
})();
