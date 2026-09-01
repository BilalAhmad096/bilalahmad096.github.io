const SUGGESTIONS = [
  "What does Bilal research?",
  "Tell me about his PhD",
  "Show me his publications",
  "Is his work relevant to BESS reliability?",
  "I’d like to collaborate"
];

const EMAIL_FALLBACK = "connect@mintorian.com";
let activeAssistant;

function track(eventName, parameters = {}) {
  if (typeof window.gtag !== "function") return;
  window.gtag("event", eventName, {
    assistant_page: location.pathname,
    ...parameters
  });
}

function apiUrl(base, path) {
  return `${String(base).replace(/\/$/, "")}${path}`;
}

function safeHref(rawHref) {
  try {
    if (rawHref.startsWith("mailto:")) {
      return rawHref.toLowerCase() === `mailto:${EMAIL_FALLBACK}` ? rawHref : null;
    }
    const url = new URL(rawHref, location.origin);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function appendInlineFormatting(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)]\(([^)]+)\)$/);
      const href = linkMatch && safeHref(linkMatch[2]);
      if (linkMatch && href) {
        const link = document.createElement("a");
        link.textContent = linkMatch[1];
        link.href = href;
        if (new URL(href, location.origin).origin !== location.origin && !href.startsWith("mailto:")) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        parent.append(link);
      } else {
        parent.append(document.createTextNode(token));
      }
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

function renderResponse(container, text) {
  container.replaceChildren();
  const lines = String(text).split("\n");
  let list = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      list = null;
      continue;
    }
    const bullet = line.match(/^[-•]\s+(.+)/);
    if (bullet) {
      if (!list) {
        list = document.createElement("ul");
        container.append(list);
      }
      const item = document.createElement("li");
      appendInlineFormatting(item, bullet[1]);
      list.append(item);
      continue;
    }
    list = null;
    const paragraph = document.createElement("p");
    appendInlineFormatting(paragraph, line);
    container.append(paragraph);
  }
}

function createIcon(name) {
  const icons = {
    close: '<path d="m7 7 10 10M17 7 7 17"></path>',
    send: '<path d="m4 4 17 8-17 8 3-8zm3 8h14"></path>',
    back: '<path d="m15 5-7 7 7 7"></path>',
    mail: '<path d="M3 5h18v14H3z"></path><path d="m3 6 9 7 9-7"></path>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"></rect><path d="M7 3v4m10-4v4M3 10h18"></path>',
    external: '<path d="M14 4h6v6m0-6-9 9"></path><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"></path>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
}

class AskMintorian {
  constructor({ trigger, dock, apiBase }) {
    this.trigger = trigger;
    this.dock = dock;
    this.apiBase = apiBase;
    this.history = [];
    this.isOpen = false;
    this.isBusy = false;
    this.hasTrackedOpen = false;
    this.hasStarted = false;
    this.bodyOverflow = "";
    this.mobileQuery = window.matchMedia("(max-width: 640px)");
    this.build();
    this.bind();
  }

  build() {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "ask-mintorian-backdrop";
    this.backdrop.hidden = true;

    this.panel = document.createElement("section");
    this.panel.id = "ask-mintorian-panel";
    this.panel.className = "ask-mintorian-panel";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-labelledby", "ask-mintorian-title");
    this.panel.setAttribute("aria-describedby", "ask-mintorian-description");
    this.panel.setAttribute("aria-hidden", "true");
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <header class="ask-mintorian-header">
        <div class="ask-mintorian-identity">
          <span class="ask-mintorian-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M8.25 10.25 16 5.75l7.75 4.5v9.5L16 24.25l-7.75-4.5z"></path><circle cx="16" cy="8.6" r="1.7"></circle><circle cx="10.8" cy="17.4" r="1.7"></circle><circle cx="21.2" cy="17.4" r="1.7"></circle><path d="m15 9.9-3.25 5.65m5.25-5.65 3.25 5.65M12.6 18.2h6.8"></path></svg>
          </span>
          <div>
            <h2 id="ask-mintorian-title">Ask Mintorian</h2>
            <p>Research &amp; collaboration assistant</p>
          </div>
        </div>
        <button class="ask-mintorian-icon-button ask-mintorian-close" type="button" aria-label="Close Ask Mintorian">${createIcon("close")}</button>
      </header>

      <div class="ask-mintorian-conversation">
        <div class="ask-mintorian-messages" role="log" aria-live="polite" aria-relevant="additions text">
          <article class="ask-mintorian-message ask-mintorian-message--assistant ask-mintorian-message--welcome">
            <span class="ask-mintorian-message__label">Ask Mintorian</span>
            <div class="ask-mintorian-message__content" id="ask-mintorian-description">
              <p>Explore Bilal’s research, publications, projects and technical work, or ask about a potential collaboration.</p>
            </div>
          </article>
        </div>
        <div class="ask-mintorian-suggestions" aria-label="Suggested questions"></div>
        <div class="ask-mintorian-tool-status" role="status" aria-live="polite" hidden>
          <span class="ask-mintorian-tool-status__pulse" aria-hidden="true"></span>
          <span class="ask-mintorian-tool-status__label"></span>
        </div>
      </div>

      <div class="ask-mintorian-form-view" hidden></div>

      <form class="ask-mintorian-composer">
        <label class="visually-hidden" for="ask-mintorian-input">Ask about Bilal’s research or experience</label>
        <textarea id="ask-mintorian-input" rows="1" maxlength="2000" placeholder="Ask about Bilal’s work…" required></textarea>
        <button type="submit" class="ask-mintorian-send" aria-label="Send question">${createIcon("send")}</button>
      </form>

      <footer class="ask-mintorian-footer">
        <div class="ask-mintorian-footer__actions">
          <button type="button" data-view="contact">${createIcon("mail")} Contact</button>
          <button type="button" data-view="meeting">${createIcon("calendar")} Request a meeting</button>
        </div>
        <p>Answers use Bilal’s verified public profile. Conversations are not saved by Mintorian.</p>
      </footer>`;

    document.body.append(this.backdrop, this.panel);
    this.messages = this.panel.querySelector(".ask-mintorian-messages");
    this.suggestions = this.panel.querySelector(".ask-mintorian-suggestions");
    this.toolStatus = this.panel.querySelector(".ask-mintorian-tool-status");
    this.toolStatusLabel = this.panel.querySelector(".ask-mintorian-tool-status__label");
    this.conversation = this.panel.querySelector(".ask-mintorian-conversation");
    this.formView = this.panel.querySelector(".ask-mintorian-form-view");
    this.composer = this.panel.querySelector(".ask-mintorian-composer");
    this.footer = this.panel.querySelector(".ask-mintorian-footer");
    this.input = this.panel.querySelector("#ask-mintorian-input");
    this.sendButton = this.panel.querySelector(".ask-mintorian-send");
    this.closeButton = this.panel.querySelector(".ask-mintorian-close");

    this.renderSuggestions(SUGGESTIONS, "Suggested questions");
  }

  bind() {
    this.closeButton.addEventListener("click", () => this.close());
    this.backdrop.addEventListener("click", () => this.close());
    this.composer.addEventListener("submit", event => {
      event.preventDefault();
      this.send(this.input.value);
    });
    this.input.addEventListener("input", () => this.resizeInput());
    this.input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.composer.requestSubmit();
      }
    });
    this.footer.addEventListener("click", event => {
      const button = event.target.closest("button[data-view]");
      if (button) this.openForm(button.dataset.view);
    });
    this.panel.addEventListener("click", event => {
      const action = event.target.closest("button[data-assistant-action]");
      if (action) this.openForm(action.dataset.assistantAction);
    });
    document.addEventListener("keydown", event => this.onKeyDown(event));
    this.mobileQuery.addEventListener("change", () => this.syncModalState());
  }

  open(view) {
    this.isOpen = true;
    this.panel.hidden = false;
    this.backdrop.hidden = false;
    this.syncCollapsedOrigin();
    requestAnimationFrame(() => {
      this.panel.classList.add("is-open");
      this.backdrop.classList.add("is-open");
    });
    this.panel.setAttribute("aria-hidden", "false");
    this.trigger.setAttribute("aria-expanded", "true");
    this.dock.classList.add("assistant-is-open");
    this.syncModalState();
    if (!this.hasTrackedOpen) {
      track("chat_opened");
      this.hasTrackedOpen = true;
    }
    if (view === "contact" || view === "meeting") this.openForm(view);
    else this.showConversation();
    setTimeout(() => (view ? this.formView.querySelector("input, textarea, select") : this.input)?.focus(), 120);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.syncCollapsedOrigin();
    this.panel.classList.remove("is-open");
    this.backdrop.classList.remove("is-open");
    this.panel.setAttribute("aria-hidden", "true");
    this.trigger.setAttribute("aria-expanded", "false");
    this.dock.classList.remove("assistant-is-open");
    document.body.style.overflow = this.bodyOverflow;
    setTimeout(() => {
      if (!this.isOpen) {
        this.panel.hidden = true;
        this.backdrop.hidden = true;
      }
    }, 220);
    this.trigger.focus({ preventScroll: true });
  }

  syncModalState() {
    const mobileModal = this.isOpen && this.mobileQuery.matches;
    this.panel.setAttribute("aria-modal", String(mobileModal));
    this.backdrop.classList.toggle("is-mobile", mobileModal);
    if (mobileModal) {
      if (!this.bodyOverflow) this.bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    } else if (this.isOpen) {
      document.body.style.overflow = this.bodyOverflow;
    }
  }

  onKeyDown(event) {
    if (!this.isOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!this.formView.hidden) this.showConversation();
      else this.close();
      return;
    }
    if (event.key !== "Tab" || !this.mobileQuery.matches) return;
    const focusable = [...this.panel.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest("[hidden]") && element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  resizeInput() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 112)}px`;
    this.input.style.overflowY = this.input.scrollHeight > 112 ? "auto" : "hidden";
  }

  addMessage(role, text = "") {
    const article = document.createElement("article");
    article.className = `ask-mintorian-message ask-mintorian-message--${role}`;
    const label = document.createElement("span");
    label.className = "ask-mintorian-message__label";
    label.textContent = role === "assistant" ? "Ask Mintorian" : "You";
    const content = document.createElement("div");
    content.className = "ask-mintorian-message__content";
    if (text) content.textContent = text;
    article.append(label, content);
    this.messages.append(article);
    this.scrollMessages();
    return { article, content };
  }

  scrollMessages() {
    requestAnimationFrame(() => {
      this.conversation.scrollTop = this.conversation.scrollHeight;
    });
  }

  setBusy(busy) {
    this.isBusy = busy;
    this.sendButton.disabled = busy;
    this.input.disabled = busy;
    this.panel.classList.toggle("is-busy", busy);
  }

  showToolStatus(label, state = "running") {
    this.toolStatus.hidden = !label;
    this.toolStatus.dataset.state = state;
    this.toolStatusLabel.textContent = label || "";
    this.scrollMessages();
  }

  classifyAndTrack(text) {
    track("knowledge_question");
    if (/publication|paper|doi|journal|conference/i.test(text)) track("publication_question");
    if (/project|framework|built|worked on/i.test(text)) track("project_question");
    if (/collaborat|hire|opportunit|contact|speak|invite/i.test(text)) track("contact_intent");
    if (/meeting|book|calendar|availability|call/i.test(text)) track("meeting_intent");
  }

  async send(rawText) {
    const text = String(rawText || "").trim().slice(0, 2000);
    if (!text || this.isBusy) return;
    this.showConversation();
    if (!this.hasStarted) {
      track("chat_started");
      this.hasStarted = true;
    }
    this.classifyAndTrack(text);
    this.suggestions.hidden = true;
    this.addMessage("user", text);
    this.history.push({ role: "user", content: text });
    this.input.value = "";
    this.resizeInput();
    const assistant = this.addMessage("assistant");
    assistant.article.classList.add("is-streaming");
    assistant.content.textContent = "Thinking…";
    this.setBusy(true);

    let responseText = "";
    let actions = [];
    let followups = [];
    try {
      const response = await fetch(apiUrl(this.apiBase, "/v1/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: this.history.slice(-12) })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "The research assistant is unavailable right now.");
      }
      if (!response.body) throw new Error("The research assistant is unavailable right now.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError = null;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || "";
        for (const frame of frames) {
          let eventName = "message";
          const dataLines = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (!dataLines.length) continue;
          let data;
          try {
            data = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          if (eventName === "delta") {
            responseText += data.text || "";
            assistant.content.textContent = responseText;
            this.scrollMessages();
          } else if (eventName === "tool") {
            this.showToolStatus(data.label, data.state);
          } else if (eventName === "actions") {
            actions = Array.isArray(data.actions) ? data.actions : [];
          } else if (eventName === "followups") {
            followups = Array.isArray(data.followups) ? data.followups : [];
          } else if (eventName === "error") {
            streamError = new Error(data.message || "The research assistant is unavailable right now.");
          }
        }
        if (done) break;
      }
      if (streamError) throw streamError;
      if (!responseText) throw new Error("The research assistant did not return an answer.");
      renderResponse(assistant.content, responseText);
      this.appendActions(assistant.article, actions);
      this.history.push({ role: "assistant", content: responseText });
      // Starter prompts never come back. Anything shown from here is a grounded follow-up.
      this.renderSuggestions(
        followups.slice(0, 3).map(item => String(item || "").trim().slice(0, 120)).filter(Boolean),
        "Follow-up questions"
      );
    } catch (error) {
      const rawMessage = String(error?.message || "");
      responseText = /networkerror|failed to fetch|load failed|network request failed/i.test(rawMessage)
        ? "I’m having trouble connecting to the research assistant right now."
        : rawMessage || "I’m having trouble connecting to the research assistant right now.";
      assistant.article.classList.add("is-error");
      renderResponse(assistant.content, `${responseText}\n\nYou can still visit [Publications](/publications/) or email [connect@mintorian.com](mailto:connect@mintorian.com).`);
      track("chat_error");
    } finally {
      assistant.article.classList.remove("is-streaming");
      this.showToolStatus("");
      this.setBusy(false);
      this.input.focus({ preventScroll: true });
      this.scrollMessages();
    }
  }

  appendActions(article, actions) {
    if (!actions.length) return;
    const group = document.createElement("div");
    group.className = "ask-mintorian-message-actions";
    for (const action of actions) {
      if (action.type === "external_link") {
        const href = safeHref(String(action.href || ""));
        if (!href) continue;
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = action.label || "Visit website";
        link.insertAdjacentHTML("beforeend", createIcon("external"));
        group.append(link);
        continue;
      }
      if (!['contact', 'meeting'].includes(action.type)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.assistantAction = action.type;
      button.textContent = action.label || (action.type === "meeting" ? "Request a meeting" : "Send a message");
      group.append(button);
    }
    if (group.childElementCount) article.append(group);
  }

  // The panel collapses to the trigger's exact footprint, and the trigger is sized by its
  // own label, so measure it rather than hard-coding a width the text could outgrow.
  syncCollapsedOrigin() {
    const rect = this.trigger.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.panel.style.setProperty("--ask-mintorian-collapsed-width", `${Math.round(rect.width)}px`);
    this.panel.style.setProperty("--ask-mintorian-collapsed-height", `${Math.round(rect.height)}px`);
  }

  renderSuggestions(prompts, label) {
    this.suggestions.replaceChildren();
    for (const prompt of prompts) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = prompt;
      button.addEventListener("click", () => this.send(prompt));
      this.suggestions.append(button);
    }
    this.suggestions.setAttribute("aria-label", label);
    this.suggestions.hidden = !prompts.length;
  }

  showConversation() {
    this.formView.hidden = true;
    this.conversation.hidden = false;
    this.composer.hidden = false;
    this.footer.hidden = false;
  }

  openForm(type) {
    this.conversation.hidden = true;
    this.composer.hidden = true;
    this.footer.hidden = true;
    this.formView.hidden = false;
    this.formView.replaceChildren(this.createForm(type));
    track(type === "meeting" ? "meeting_intent" : "contact_intent");
    setTimeout(() => this.formView.querySelector("input")?.focus(), 0);
  }

  createForm(type) {
    const meeting = type === "meeting";
    const wrapper = document.createElement("div");
    wrapper.className = "ask-mintorian-form-shell";
    wrapper.innerHTML = `
      <button type="button" class="ask-mintorian-form-back">${createIcon("back")} Back to conversation</button>
      <div class="ask-mintorian-form-heading">
        <span class="ask-mintorian-form-icon">${createIcon(meeting ? "calendar" : "mail")}</span>
        <div><h3>${meeting ? "Request a meeting" : "Send Bilal a message"}</h3>
        <p>${meeting ? "Suggest a time and topic. This sends a request — it does not book a meeting." : "Share the essentials and Bilal can reply directly by email."}</p></div>
      </div>
      <form class="ask-mintorian-contact-form" novalidate>
        <div class="ask-mintorian-field-row">
          <label><span>Name</span><input name="name" autocomplete="name" maxlength="100" required></label>
          <label><span>Email</span><input name="email" type="email" autocomplete="email" maxlength="254" required></label>
        </div>
        ${meeting ? `
          <label><span>What would you like to discuss?</span><textarea name="topic" rows="4" maxlength="500" required></textarea></label>
          <label><span>Preferred date or time window</span><input name="preferredWindow" maxlength="300" placeholder="For example: weekday afternoons next week" required></label>
          <label><span>Timezone</span><input name="timezone" maxlength="100" value="${Intl.DateTimeFormat().resolvedOptions().timeZone || ""}"></label>` : `
          <label><span>Reason</span><select name="reason">
            <option>Research collaboration</option><option>Professional opportunity</option><option>Speaking invitation</option><option>Publication discussion</option><option>Other</option>
          </select></label>
          <label><span>Message</span><textarea name="message" rows="5" maxlength="3000" required></textarea></label>`}
        <label class="ask-mintorian-honeypot" aria-hidden="true">Company<input name="company" tabindex="-1" autocomplete="off"></label>
        <p class="ask-mintorian-privacy">Your details are sent to Bilal by email and are not stored by this website.</p>
        <div class="ask-mintorian-form-status" role="status" aria-live="polite"></div>
        <button class="ask-mintorian-submit" type="submit">${meeting ? "Send meeting request" : "Send message"}</button>
      </form>`;

    wrapper.querySelector(".ask-mintorian-form-back").addEventListener("click", () => {
      this.showConversation();
      this.input.focus();
    });
    wrapper.querySelector("form").addEventListener("submit", event => this.submitForm(event, type));
    return wrapper;
  }

  async submitForm(event, type) {
    event.preventDefault();
    const form = event.currentTarget;
    const status = form.querySelector(".ask-mintorian-form-status");
    const submit = form.querySelector("button[type=submit]");
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    submit.disabled = true;
    status.className = "ask-mintorian-form-status is-loading";
    status.textContent = type === "meeting" ? "Sending your meeting request…" : "Sending your message…";
    try {
      const response = await fetch(apiUrl(this.apiBase, type === "meeting" ? "/v1/meeting-request" : "/v1/contact"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify(data)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "The request could not be sent.");
      form.reset();
      status.className = "ask-mintorian-form-status is-success";
      status.textContent = payload.message || (type === "meeting" ? "Your meeting request has been sent. It is not a confirmed booking." : "Your message has been sent.");
      track(type === "meeting" ? "meeting_request_sent" : "message_sent");
      submit.hidden = true;
    } catch (error) {
      status.className = "ask-mintorian-form-status is-error";
      status.replaceChildren(document.createTextNode(`${error.message || "The request could not be sent."} `));
      const link = document.createElement("a");
      link.href = `mailto:${EMAIL_FALLBACK}`;
      link.textContent = `Email ${EMAIL_FALLBACK}`;
      status.append(link);
      submit.disabled = false;
    }
  }
}

export function mountAskMintorian(options) {
  if (!activeAssistant) activeAssistant = new AskMintorian(options);
  activeAssistant.open(options.view);
  return activeAssistant;
}
