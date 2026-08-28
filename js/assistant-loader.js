(function () {
  "use strict";

  const script = document.currentScript;
  const assetVersion = "20260828-7";
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const apiBase = script?.dataset.apiBase || (isLocal ? "http://127.0.0.1:8787" : "https://api.mintorian.com");
  let modulePromise;
  let assistantInstance;

  function loadStyles() {
    if (document.querySelector('link[data-ask-mintorian]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `/css/ask-mintorian.css?v=${assetVersion}`;
    link.dataset.askMintorian = "true";
    document.head.appendChild(link);
  }

  function loadAssistant() {
    if (!modulePromise) {
      modulePromise = import(`/js/ask-mintorian.js?v=${assetVersion}`);
    }
    return modulePromise;
  }

  function ensureActionDock() {
    let dock = document.getElementById("mintorian-floating-actions");
    if (!dock) {
      dock = document.createElement("div");
      dock.id = "mintorian-floating-actions";
      dock.className = "mintorian-floating-actions";
      dock.setAttribute("aria-label", "Page actions");
      document.body.appendChild(dock);
    }
    const backToTop = document.querySelector(".scroll-ribbon");
    if (backToTop && backToTop.parentElement !== dock) dock.prepend(backToTop);
    return dock;
  }

  function attachBackToTop(dock) {
    const backToTop = document.querySelector(".scroll-ribbon");
    if (backToTop && backToTop.parentElement !== dock) dock.prepend(backToTop);
  }

  function createTrigger(dock) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ask-mintorian-trigger";
    button.setAttribute("aria-label", "Open Ask Mintorian research assistant");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "ask-mintorian-panel");
    button.innerHTML = `
      <span class="ask-mintorian-trigger__icon" aria-hidden="true">
        <svg viewBox="0 0 32 32" role="img">
          <path d="M8.25 10.25 16 5.75l7.75 4.5v9.5L16 24.25l-7.75-4.5z"></path>
          <circle cx="16" cy="8.6" r="1.7"></circle>
          <circle cx="10.8" cy="17.4" r="1.7"></circle>
          <circle cx="21.2" cy="17.4" r="1.7"></circle>
          <path d="m15 9.9-3.25 5.65m5.25-5.65 3.25 5.65M12.6 18.2h6.8"></path>
        </svg>
      </span>
      <span class="ask-mintorian-trigger__label">Ask Mintorian</span>`;
    dock.appendChild(button);

    const warm = () => loadAssistant().catch(() => undefined);
    button.addEventListener("pointerenter", warm, { once: true });
    button.addEventListener("focus", warm, { once: true });
    button.addEventListener("click", async () => {
      if (assistantInstance) {
        assistantInstance.open();
        return;
      }
      button.classList.add("is-loading");
      try {
        const module = await loadAssistant();
        assistantInstance = module.mountAskMintorian({ trigger: button, dock, apiBase });
      } catch {
        button.setAttribute("title", "Ask Mintorian is temporarily unavailable. Email connect@mintorian.com.");
        window.location.href = "mailto:connect@mintorian.com";
      } finally {
        button.classList.remove("is-loading");
      }
    });
    return button;
  }

  function initialise() {
    if (document.querySelector(".ask-mintorian-trigger")) return;
    loadStyles();
    const dock = ensureActionDock();
    const trigger = createTrigger(dock);
    // backtotop.js also waits for DOMContentLoaded. Depending on listener
    // ordering its button may be appended just after this loader runs.
    setTimeout(() => attachBackToTop(dock), 0);
    window.addEventListener("mintorian:open-assistant", async event => {
      if (assistantInstance) {
        assistantInstance.open(event.detail?.view);
        return;
      }
      const module = await loadAssistant();
      assistantInstance = module.mountAskMintorian({ trigger, dock, apiBase, view: event.detail?.view });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialise, { once: true });
  } else {
    initialise();
  }
})();
