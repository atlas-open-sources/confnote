/* Local agent controls. Tokens never enter the browser or localStorage. */
(() => {
  window.confnote = window.confnote || {};
  const read = (key, fallback) => {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private browsing */
    }
  };
  window.confnote.agentQuery = function (params) {
    const provider = read("confnote-agent-provider", "claude");
    params.set("provider", provider);
    if (provider === "chatgpt") params.set("model", read("confnote-chatgpt-model", ""));
    return params;
  };
  window.confnote.mountAgentControls = async function (host, modelWrap, thinkingWrap) {
    const request = async (path, options) => {
      const response = await fetch(path, options);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed.");
      return data;
    };
    let initial;
    try {
      initial = await request("/api/chat/providers");
    } catch {
      return;
    }
    if (!host.isConnected || !initial.chatgpt) return;
    const controls = document.createElement("div");
    controls.className = "agent-controls";
    const label = document.createElement("label");
    label.textContent = "Agent ";
    const provider = document.createElement("select");
    provider.setAttribute("aria-label", "Agent provider");
    for (const [value, title] of [
      ["claude", "Claude"],
      ["chatgpt", "ChatGPT"],
    ]) {
      const option = new Option(title, value);
      provider.append(option);
    }
    provider.value = read("confnote-agent-provider", "claude");
    label.append(provider);
    const login = document.createElement("button");
    login.type = "button";
    login.textContent = "Continue with ChatGPT";
    const logout = document.createElement("button");
    logout.type = "button";
    logout.textContent = "Sign out";
    const models = document.createElement("select");
    models.setAttribute("aria-label", "ChatGPT model");
    const status = document.createElement("span");
    status.className = "agent-status";
    status.setAttribute("role", "status");
    controls.append(label, login, logout, models, status);
    const strip = host.querySelector(".chat-ctx-strip");
    if (strip) strip.after(controls);
    else host.prepend(controls);
    let poll = null;
    let connected = false;
    async function refresh() {
      const info = await request("/api/chat/providers");
      if (!controls.isConnected) {
        clearInterval(poll);
        return;
      }
      const state = info.chatgpt;
      connected = Boolean(state.signed_in);
      login.hidden = connected || provider.value !== "chatgpt";
      logout.hidden = !connected || provider.value !== "chatgpt";
      models.hidden = !connected || provider.value !== "chatgpt";
      login.disabled = !state.available || state.pending;
      if (provider.value === "chatgpt") {
        if (state.pending) status.textContent = "Finish signing in in your browser…";
        else
          status.textContent = connected
            ? "Uses your ChatGPT plan · note tools; web research and module tools use Claude"
            : state.error || "Sign in to use your ChatGPT plan";
      } else {
        status.textContent = info.claude.available
          ? "Uses your Claude CLI sign-in"
          : "Install and sign in to the Claude CLI";
      }
      if (connected && models.options.length === 0) {
        const catalog = await request("/api/chat/chatgpt/models");
        for (const model of catalog.models)
          models.append(new Option(model.display_name, model.slug));
        const saved = read("confnote-chatgpt-model", "");
        if ([...models.options].some((o) => o.value === saved)) models.value = saved;
        write("confnote-chatgpt-model", models.value);
      }
      if (connected && poll) {
        clearInterval(poll);
        poll = null;
      }
    }
    function update() {
      write("confnote-agent-provider", provider.value);
      modelWrap.hidden = provider.value === "chatgpt";
      thinkingWrap.hidden = provider.value === "chatgpt";
      refresh().catch((error) => {
        status.textContent = error.message;
      });
    }
    provider.onchange = update;
    models.onchange = () => write("confnote-chatgpt-model", models.value);
    const post = { method: "POST", headers: { "X-Confnote-Request": "1" } };
    login.onclick = async () => {
      const nativeBrowser = window.pywebview?.api?.open_external;
      const popup = nativeBrowser ? null : window.open("about:blank", "_blank");
      login.disabled = true;
      try {
        const result = await request("/api/chat/chatgpt/login", post);
        const url = new URL(result.auth_url);
        if (url.protocol !== "https:" || url.hostname !== "auth.openai.com")
          throw new Error("Unexpected sign-in URL.");
        if (nativeBrowser) await window.pywebview.api.open_external(url.href);
        else if (popup) popup.location.href = url.href;
        else window.open(url.href, "_blank", "noopener");
        status.textContent = "Finish signing in in your browser…";
        clearInterval(poll);
        let attempts = 0;
        poll = setInterval(() => {
          attempts += 1;
          if (!controls.isConnected || attempts > 245) {
            clearInterval(poll);
            poll = null;
            return;
          }
          refresh().catch((error) => {
            status.textContent = error.message;
          });
        }, 2500);
      } catch (error) {
        if (popup) popup.close();
        status.textContent = error.message;
      } finally {
        await refresh().catch(() => {});
      }
    };
    logout.onclick = async () => {
      try {
        const result = await request("/api/chat/chatgpt/logout", post);
        models.replaceChildren();
        await refresh();
        if (result.warning) status.textContent = result.warning;
      } catch (error) {
        status.textContent = error.message;
      }
    };
    update();
  };
})();
