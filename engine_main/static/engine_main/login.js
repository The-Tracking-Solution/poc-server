(() => {
  "use strict";

  const form = document.querySelector("#porto-login-form");
  const username = document.querySelector("#id_username");
  const password = document.querySelector("#id_password");
  const togglePassword = document.querySelector("#toggle-password");
  const loginButton = document.querySelector(".login-button");
  const hasDevice = form?.dataset.deviceLogin === "1";

  function updateLoginMode() {
    const userMode = Boolean((username?.value || "").trim() || (password?.value || ""));
    if (loginButton) loginButton.textContent = hasDevice && !userMode ? "Login DevId" : "Login Gebruiker";
  }

  function requestSoftKeyboard() {
    document.dispatchEvent(new CustomEvent("ui_radio:native-ui-command", {
      detail: JSON.stringify({ command: "show_keyboard" })
    }));
  }

  function focusNativeToolbar(target = "back") {
    document.dispatchEvent(new CustomEvent("ui_radio:native-ui-command", {
      detail: JSON.stringify({ command: "focus_toolbar", target })
    }));
  }

  function interactiveElements() {
    return [username, password, togglePassword, loginButton].filter(element => {
      if (!element || element.disabled || element.hidden) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  function moveFocus(keyCode) {
    const elements = interactiveElements();
    if (!elements.length) {
      if (keyCode === 19) focusNativeToolbar("back");
      return false;
    }

    const active = elements.includes(document.activeElement) ? document.activeElement : null;
    if (!active) {
      (username || elements[0]).focus();
      return true;
    }

    const source = active.getBoundingClientRect();
    const sx = source.left + source.width / 2;
    const sy = source.top + source.height / 2;
    let best = null;
    let bestScore = Infinity;

    for (const candidate of elements) {
      if (candidate === active) continue;
      const rect = candidate.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - sx;
      const dy = rect.top + rect.height / 2 - sy;
      let primary;
      let secondary;
      if (keyCode === 19 && dy < 0) { primary = -dy; secondary = Math.abs(dx); }
      else if (keyCode === 20 && dy > 0) { primary = dy; secondary = Math.abs(dx); }
      else if (keyCode === 21 && dx < 0) { primary = -dx; secondary = Math.abs(dy); }
      else if (keyCode === 22 && dx > 0) { primary = dx; secondary = Math.abs(dy); }
      else continue;
      const score = primary + secondary * 2.5;
      if (score < bestScore) { best = candidate; bestScore = score; }
    }

    if (best) {
      best.focus();
      return true;
    }
    if (keyCode === 19) {
      focusNativeToolbar("back");
      return true;
    }
    return false;
  }

  function activateFocused() {
    const active = document.activeElement;
    if (active === username || active === password) {
      active.focus();
      requestSoftKeyboard();
      return;
    }
    if (active && typeof active.click === "function" && active !== document.body) {
      active.click();
      return;
    }
    (username || loginButton)?.focus();
  }

  function handleAndroidKey(event) {
    let detail = event.detail || {};
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch (_) { detail = {}; }
    }
    if (detail.phase !== "down" || detail.repeat === true) return;
    const keyCode = Number(detail.key_code);
    if ([19, 20, 21, 22].includes(keyCode)) {
      event.preventDefault?.();
      moveFocus(keyCode);
    } else if (keyCode === 23 || keyCode === 66) {
      event.preventDefault?.();
      activateFocused();
    }
  }

  for (const input of [username, password]) {
    input?.addEventListener("input", updateLoginMode);
    input?.addEventListener("click", requestSoftKeyboard);
    input?.addEventListener("pointerup", requestSoftKeyboard);
  }

  togglePassword?.addEventListener("click", event => {
    const visible = password.type === "text";
    password.type = visible ? "password" : "text";
    event.currentTarget.textContent = visible ? "Toon" : "Verberg";
    password.focus();
  });

  document.addEventListener("ui_radio:android-key", handleAndroidKey);
  document.addEventListener("ui_radio:native-ui-event", event => {
    let detail = event.detail || {};
    if (typeof detail === "string") {
      try { detail = JSON.parse(detail); } catch (_) { detail = {}; }
    }
    if (detail.event === "focus-login") {
      (username || loginButton)?.focus();
    }
  });
  document.addEventListener("keydown", event => {
    const keyCode = ({ ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Enter: 23 })[event.key];
    if (!keyCode) return;
    if ([19,20,21,22].includes(keyCode)) {
      event.preventDefault();
      moveFocus(keyCode);
    } else if (keyCode === 23 && document.activeElement && document.activeElement.tagName !== "INPUT") {
      event.preventDefault();
      activateFocused();
    }
  });

  updateLoginMode();
})();
