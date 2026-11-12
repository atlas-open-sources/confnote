/* Chat module — surfaces the concierge agent inside a drawer slot.
 *
 * Owns:
 *   - the chat body (delegates to app.js's mountConciergeInto).
 *   - two header buttons next to the drawer's × close:
 *       ↺ history  → swap body to a list of archived threads (resumable).
 *       + new      → archive the current thread, fresh empty chat.
 *
 * Persistence + agent wiring lives in server.py + app.js; this module is
 * just the UI shell that calls the existing endpoints:
 *   GET  /api/chat/threads         → list active + archived
 *   POST /api/chat/archive         → archive current, new empty active
 *   POST /api/chat/resume?id=<id>  → archive current, restore archive
 *
 * The legacy bottom-right FAB is suppressed on load so we don't have two
 * concierge surfaces competing for the same agent.
 */
(function () {
  if (!window.confnote || !window.confnote.drawer) return;

  // The Concierge's own chrome (context line, pickers, history). Loaded with the module, before the drawer
  // can open, so the first open never restyles.
  let chromeCss = document.querySelector('link[data-confnote-chat="css"]');
  if (!chromeCss) {
    chromeCss = document.createElement("link");
    chromeCss.rel = "stylesheet";
    chromeCss.href = "modules/chat/chat.css";
    chromeCss.dataset.confnoteChat = "css";
    document.head.appendChild(chromeCss);
  }
  // A first open faster than chat.css would paint the chrome unstyled for a beat: keep the body hidden
  // until the stylesheet lands (or fails, so a broken load never hides the Concierge for good).
  function revealWhenStyled(host) {
    if (chromeCss.sheet) return;
    host.style.visibility = "hidden";
    const reveal = () => {
      host.style.visibility = "";
    };
    chromeCss.addEventListener("load", reveal, { once: true });
    chromeCss.addEventListener("error", reveal, { once: true });
  }

  // ---- 1. Suppress the legacy FAB immediately (no flash) -----------------
  function suppressFab() {
    if (window.confnote.fab && typeof window.confnote.fab.disable === "function") {
      window.confnote.fab.disable();
      return true;
    }
    return false;
  }
  if (!suppressFab()) {
    const t = setInterval(() => {
      if (suppressFab()) clearInterval(t);
    }, 30);
    setTimeout(() => clearInterval(t), 3000);
  }

  // ---- 2. Helpers to swap the chat-inner host between chat ↔ history -----
  // `currentInner` is the sub-element inside the drawer body where deep-chat
  // OR the history list mounts (the context strip is its sibling and stays
  // intact across these swaps). Set in render(); read by the head buttons.
  let currentInner = null;
  let showChat = null;

  function mountChatView(host) {
    if (typeof window.confnote.mountConciergeInto === "function") {
      window.confnote.mountConciergeInto(host);
      return;
    }
    // app.js mount hook not ready yet — poll briefly
    const wait = setInterval(() => {
      if (typeof window.confnote.mountConciergeInto === "function") {
        window.confnote.mountConciergeInto(host);
        clearInterval(wait);
      }
    }, 50);
    setTimeout(() => clearInterval(wait), 3000);
  }

  async function mountHistoryView(host) {
    host.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "chat-history";
    const heading = document.createElement("h3");
    heading.className = "chat-history-h";
    heading.textContent = "Chat threads";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "chat-history-back";
    back.textContent = "← back to chat";
    back.onclick = () => showChat();
    const list = document.createElement("ul");
    list.className = "chat-thread-list";
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "empty";
    emptyMsg.textContent = "No archived threads yet. Hit + new to archive the current one.";
    wrap.append(heading, back, list);
    host.appendChild(wrap);

    let data;
    try {
      const r = await fetch("/api/chat/threads");
      data = await r.json();
    } catch (e) {
      const err = document.createElement("div");
      err.className = "drawer-err";
      err.textContent = "Could not load threads: " + String(e);
      wrap.appendChild(err);
      return;
    }
    const items = [];
    if (data.active && data.active.turns > 0) items.push({ ...data.active, _active: true });
    for (const t of data.archived || []) items.push(t);
    if (!items.length) {
      wrap.appendChild(emptyMsg);
      return;
    }
    for (const t of items) {
      const li = document.createElement("li");
      li.className = "chat-thread-item" + (t._active ? " active" : "");
      const dot = document.createElement("span");
      dot.className = "chat-thread-dot";
      dot.textContent = t._active ? "●" : "○";
      const meta = document.createElement("div");
      meta.className = "chat-thread-meta";
      const title = document.createElement("div");
      title.className = "chat-thread-title";
      title.textContent = t.title || "(empty thread)";
      const sub = document.createElement("div");
      sub.className = "chat-thread-sub";
      sub.textContent = (t._active ? "active · " : "") + t.turns + " turns · " + t.ts;
      meta.append(title, sub);
      li.append(dot, meta);
      if (!t._active) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "chat-thread-resume";
        btn.textContent = "resume →";
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = "resuming…";
          try {
            await fetch("/api/chat/resume?id=" + encodeURIComponent(t.id), {
              method: "POST",
            });
            showChat();
          } catch (e) {
            btn.disabled = false;
            btn.textContent = "resume →";
          }
        };
        li.appendChild(btn);
      }
      list.appendChild(li);
    }
  }

  // ---- 3. Register with the drawer --------------------------------------
  window.confnote.drawer.register({
    id: "chat",
    label: "Concierge",
    renderHead(extras) {
      // Icon-only header buttons (tooltip carries the label).
      const hist = document.createElement("button");
      hist.type = "button";
      hist.className = "chat-head-btn";
      hist.title = "Chat history";
      hist.setAttribute("aria-label", "Chat history");
      hist.textContent = "↺";
      hist.onclick = () => {
        if (currentInner) mountHistoryView(currentInner);
      };
      const newBtn = document.createElement("button");
      newBtn.type = "button";
      newBtn.className = "chat-head-btn";
      newBtn.title = "Archive current chat and start fresh";
      newBtn.setAttribute("aria-label", "New chat");
      newBtn.textContent = "+";
      newBtn.onclick = async () => {
        newBtn.disabled = true;
        try {
          await fetch("/api/chat/archive", { method: "POST" });
        } catch (e) {}
        newBtn.disabled = false;
        if (currentInner) mountChatView(currentInner);
      };
      extras.append(hist, newBtn);
    },
    render(host) {
      suppressFab();
      // The chat module's body has two stacked regions:
      //   1. context strip   — live-updates with what the user is viewing
      //   2. chat-inner host — deep-chat mounts here; its text input survives
      // route changes because the strip updates IN PLACE rather than
      // re-mounting the whole subtree.
      host.replaceChildren();
      revealWhenStyled(host);
      const strip = document.createElement("div");
      strip.className = "chat-ctx-strip";
      strip.title =
        "What the concierge sees right now. Updates live as you move " +
        "across conferences and sessions — the agent grounds each reply " +
        "in this.";
      const stripDot = document.createElement("span");
      stripDot.className = "chat-ctx-dot";
      stripDot.setAttribute("aria-hidden", "true");
      const stripText = document.createElement("span");
      stripText.className = "chat-ctx-text";

      // Thinking-level picker — sits at the right of the strip. Persisted to
      // localStorage; read at each chat-request build, so changing the level
      // takes effect on the next user message without any re-mount.
      const thinkingWrap = document.createElement("label");
      thinkingWrap.className = "chat-think";
      const thinkingLbl = document.createElement("span");
      thinkingLbl.className = "chat-think-lbl";
      thinkingLbl.textContent = "thinking:";
      const thinkingSel = document.createElement("select");
      thinkingSel.className = "chat-think-sel";
      thinkingSel.title =
        "Thinking depth. Off = fastest, no extended reasoning. " +
        "Auto = model decides per question. Deep = generous reasoning " +
        "budget for hard prompts (slower, more tokens).";
      const LEVELS = [
        { value: "off", label: "off" },
        { value: "auto", label: "auto" },
        { value: "deep", label: "deep" },
      ];
      const saved = (() => {
        try {
          return localStorage.getItem("confnote-thinking") || "off";
        } catch (e) {
          return "off";
        }
      })();
      for (const lv of LEVELS) {
        const opt = document.createElement("option");
        opt.value = lv.value;
        opt.textContent = lv.label;
        if (lv.value === saved) opt.selected = true;
        thinkingSel.appendChild(opt);
      }
      thinkingSel.onchange = () => {
        try {
          localStorage.setItem("confnote-thinking", thinkingSel.value);
        } catch (e) {}
      };
      thinkingWrap.append(thinkingLbl, thinkingSel);
      // The web host has no thinking budget to set, so the picker would be a dead control there.
      if (window.confnote.webMode) thinkingWrap.hidden = true;

      // Model picker — same shape as the thinking picker. Persisted to
      // localStorage; read at each chat-request build (app.js buildUrl), so a
      // change takes effect on the next user message without a re-mount.
      const modelWrap = document.createElement("label");
      modelWrap.className = "chat-model";
      const modelLbl = document.createElement("span");
      modelLbl.className = "chat-model-lbl";
      modelLbl.textContent = "model:";
      const modelSel = document.createElement("select");
      modelSel.className = "chat-model-sel";
      modelSel.title =
        "Model. Haiku = snappiest for chat and quick edits. " +
        "Sonnet = a strong all-rounder. Opus = deepest for hard " +
        "research or a /brief (slower, more tokens).";
      const MODELS = [
        { value: "haiku", label: "Haiku" },
        { value: "sonnet", label: "Sonnet" },
        { value: "opus", label: "Opus" },
      ];
      const savedModel = (() => {
        try {
          return localStorage.getItem("confnote-model") || "haiku";
        } catch (e) {
          return "haiku";
        }
      })();
      for (const mv of MODELS) {
        const opt = document.createElement("option");
        opt.value = mv.value;
        opt.textContent = mv.label;
        if (mv.value === savedModel) opt.selected = true;
        modelSel.appendChild(opt);
      }
      modelSel.onchange = () => {
        try {
          localStorage.setItem("confnote-model", modelSel.value);
        } catch (e) {}
      };
      modelWrap.append(modelLbl, modelSel);
      // The web host picks the model on the server (Router wallet or the user's own key), so the
      // picker would only show a choice that is not used.
      if (window.confnote.webMode) modelWrap.hidden = true;

      strip.append(stripDot, stripText, thinkingWrap, modelWrap);
      queueMicrotask(() => window.confnote.mountAgentControls?.(host, modelWrap, thinkingWrap));

      const signup = document.createElement("div");
      signup.className = "chat-waitlist";
      if (window.confnote.publicDemo) {
        const title = document.createElement("div");
        title.className = "chat-waitlist-title";
        title.textContent = "Get an editable workspace";
        const formHost = document.createElement("div");
        signup.append(title, formHost);
        const mountSignup = () => {
          if (typeof window.confnote.mountWaitlistSignup === "function") {
            window.confnote.mountWaitlistSignup(formHost);
            return true;
          }
          return false;
        };
        if (!mountSignup()) {
          const wait = setInterval(() => {
            if (mountSignup()) clearInterval(wait);
          }, 50);
          setTimeout(() => clearInterval(wait), 3000);
        }
      }

      const inner = document.createElement("div");
      inner.className = "chat-inner";

      host.append(strip);
      if (window.confnote.publicDemo) host.append(signup);
      host.append(inner);

      // "Viewing <conference> › <session>", the conference in bold; built from text nodes, never markup.
      const renderStrip = (ctx) => {
        ctx = ctx || {};
        let conference = "";
        if (ctx.conf && ctx.conf.conference && ctx.conf.conference.name) {
          conference = ctx.conf.conference.name;
        } else if (ctx.slug) {
          conference = ctx.slug;
        }
        stripText.replaceChildren();
        if (!conference) {
          stripText.textContent = "No conference selected";
          stripDot.hidden = true;
          return;
        }
        stripDot.hidden = false;
        const name = document.createElement("b");
        name.textContent = conference;
        stripText.append("Viewing ", name);
        if (ctx.noteTitle) stripText.append(" › " + ctx.noteTitle);
      };
      renderStrip(window.confnote.context);
      if (typeof window.confnote.onContextChange === "function") {
        window.confnote.onContextChange(renderStrip);
      }

      currentInner = inner;
      showChat = () => mountChatView(inner);
      showChat();
    },
  });
})();
