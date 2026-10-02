(() => {
  "use strict";

  const KEY = { UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, CENTER: 23, ENTER: 66 };
  const NAV = new Set([KEY.UP, KEY.DOWN, KEY.LEFT, KEY.RIGHT]);

  // Keep hardware focus visible even on pages that did not originally have a
  // keyboard-focus design. This is deliberately injected here so every
  // selection page gets the same focus treatment without duplicating CSS.
  const style = document.createElement("style");
  style.textContent = `
    [data-radio-dpad-focus="1"] {
      outline: 3px solid #ff8a00 !important;
      outline-offset: 3px !important;
      box-shadow: 0 0 0 2px rgba(0,0,0,.6), 0 0 0 6px rgba(255,138,0,.28) !important;
    }
  `;
  document.head.appendChild(style);
  document.addEventListener("focusin", e => {
    document.querySelectorAll("[data-radio-dpad-focus=\"1\"]").forEach(el => el.removeAttribute("data-radio-dpad-focus"));
    if (e.target instanceof HTMLElement) e.target.setAttribute("data-radio-dpad-focus", "1");
  });

  function parseDetail(detail) {
    if (detail && typeof detail === "object") return detail;
    try { return JSON.parse(String(detail || "{}")); } catch (_) { return {}; }
  }

  function isVisible(el) {
    if (!el || el.hidden || el.disabled) return false;
    if (el.getAttribute?.("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function focusables() {
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([type=hidden]):not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
      "[role='button']"
    ].join(",");
    return Array.from(document.querySelectorAll(selector)).filter(isVisible);
  }

  function nativeToolbar(target = "back") {
    document.dispatchEvent(new CustomEvent("ui_radio:native-ui-command", {
      detail: JSON.stringify({ command: "focus_toolbar", target })
    }));
  }

  function center(rect) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function directionScore(keyCode, sourceRect, candidateRect) {
    const s = center(sourceRect), c = center(candidateRect);
    const dx = c.x - s.x, dy = c.y - s.y;
    let primary, secondary;
    if (keyCode === KEY.UP && dy < -1) { primary = -dy; secondary = Math.abs(dx); }
    else if (keyCode === KEY.DOWN && dy > 1) { primary = dy; secondary = Math.abs(dx); }
    else if (keyCode === KEY.LEFT && dx < -1) { primary = -dx; secondary = Math.abs(dy); }
    else if (keyCode === KEY.RIGHT && dx > 1) { primary = dx; secondary = Math.abs(dy); }
    else return Infinity;
    // Prefer the nearest element in the requested direction, strongly penalize
    // diagonal jumps so grid/card layouts feel natural on a radio DPAD.
    return primary + secondary * 2.2;
  }

  function focusInitial(items, keyCode) {
    if (!items.length) return false;
    let sorted = [...items];
    if (keyCode === KEY.UP) sorted.sort((a,b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
    else if (keyCode === KEY.LEFT) sorted.sort((a,b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    else sorted.sort((a,b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    sorted[0].focus({ preventScroll: true });
    sorted[0].scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return true;
  }

  function move(keyCode) {
    const items = focusables();
    if (!items.length) {
      if (keyCode === KEY.UP) nativeToolbar("back");
      return false;
    }
    const active = items.includes(document.activeElement) ? document.activeElement : null;
    if (!active) return focusInitial(items, keyCode);

    const source = active.getBoundingClientRect();
    let best = null, bestScore = Infinity;
    for (const candidate of items) {
      if (candidate === active) continue;
      const score = directionScore(keyCode, source, candidate.getBoundingClientRect());
      if (score < bestScore) { best = candidate; bestScore = score; }
    }
    if (best) {
      best.focus({ preventScroll: true });
      best.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      return true;
    }
    if (keyCode === KEY.UP) {
      nativeToolbar("back");
      return true;
    }
    return false;
  }

  function activate() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) {
      const items = focusables();
      if (items[0]) items[0].focus();
      return true;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      el.focus();
      if (el.tagName !== "SELECT") {
        document.dispatchEvent(new CustomEvent("ui_radio:native-ui-command", {
          detail: JSON.stringify({ command: "show_keyboard" })
        }));
      } else {
        el.click?.();
      }
      return true;
    }
    el.click?.();
    return true;
  }

  function handleKeyCode(keyCode) {
    if (NAV.has(keyCode)) return move(keyCode);
    if (keyCode === KEY.CENTER || keyCode === KEY.ENTER) return activate();
    return false;
  }

  document.addEventListener("ui_radio:android-key", event => {
    const d = parseDetail(event.detail);
    if (String(d.phase || "").toLowerCase() !== "down" || d.repeat === true) return;
    const keyCode = Number(d.key_code);
    if (handleKeyCode(keyCode)) event.preventDefault?.();
  });

  document.addEventListener("ui_radio:native-ui-event", event => {
    const d = parseDetail(event.detail);
    if (d.event === "focus-login" || d.event === "focus-page") {
      const items = focusables();
      items[0]?.focus({ preventScroll: true });
    }
  });

  document.addEventListener("keydown", event => {
    const keyCode = ({ArrowUp:19, ArrowDown:20, ArrowLeft:21, ArrowRight:22, Enter:23})[event.key];
    if (!keyCode) return;
    if (handleKeyCode(keyCode)) event.preventDefault();
  });
})();
