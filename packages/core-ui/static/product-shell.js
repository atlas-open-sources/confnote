/* Web account controls; local and embedded runtimes do not expose /api/me. */
(() => {
  const originalFetch = window.fetch.bind(window);
  let workspace = new URL(location.href).searchParams.get("workspace") || "";
  let byok = null;
  // The tab's own key serves the Concierge only. Hosted transcription is locked (2026-11-11,
  // browser-transcribe.js), so nothing here hands the key to a transcription call.
  window.confnote = window.confnote || {};

  // Demo event: a signed-out visitor who picks "Try a demo event" gets Beyond The Prompt (IET London,
  // 19 May 2026) in the browser-only public-demo mode. app.js reads `publicDemo` once at load, so it is set
  // here, before app.js; the build flag stays false (scripts/deploy-web.sh refuses a public-demo build).
  // The notebook API is answered from /demo-event/ (scripts/build-demo-event.py), notes save in this browser.
  const DEMO_KEY = "confnote-demo-event";
  const DEMO_SLUG = "2026-05-19-beyond-the-prompt";
  const DEMO_ROUTES = {
    "/api/conference": "conference.json",
    "/api/conf-doc": "conf-doc.json",
    "/api/actions": "actions.json",
  };
  const DEMO_PASS_THROUGH = /^\/api\/(me|auth\/|catalogue)/;
  const DEMO_NOTE = /^[\w.-]+\.md$/;
  const DEMO_CONCIERGE = ["/api/chat/global", "/api/chat/session"];
  const DEMO_SIGN_IN = "/api/auth/signin?returnTo=%2F";
  // "1": a signed-out visitor's demo. "starter": a signed-in user opened the starter event from their
  // sidebar; it is the same browser-only demo and never touches their workspace.
  const SIGNED_OUT_DEMO = "1";
  const STARTER = "starter";
  const demoMode = sessionStorage.getItem(DEMO_KEY);
  const demoEvent = Boolean(
    window.confnote.webMode &&
      !window.confnote.publicDemo &&
      !window.confnote.catMode &&
      (demoMode === SIGNED_OUT_DEMO || demoMode === STARTER),
  );
  const starter = demoEvent && demoMode === STARTER;
  if (demoEvent) {
    window.confnote.publicDemo = true;
    window.confnote.demoEvent = demoMode;
  }
  if (window.confnote.webMode && !window.confnote.catMode) {
    window.confnote.startDemoEvent = (mode = SIGNED_OUT_DEMO) => {
      sessionStorage.setItem(DEMO_KEY, mode === STARTER ? STARTER : SIGNED_OUT_DEMO);
      // replaceState fires no hashchange, so this page never asks the notebook for the demo event.
      history.replaceState(null, "", `/#/${DEMO_SLUG}`);
      location.reload();
    };
  }
  function leaveDemo() {
    sessionStorage.removeItem(DEMO_KEY);
  }
  function jsonAnswer(payload, status) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Every notebook read the conference view makes, from the static demo files; writes and anything else
  // answer as a signed-out visitor would. The Concierge answers with one line and the sign-in prompt.
  function demoAnswer(url, method) {
    if (DEMO_PASS_THROUGH.test(url.pathname)) return null;
    if (method === "GET") {
      const slug = url.searchParams.get("slug");
      const note = url.searchParams.get("file") || "";
      if (url.pathname === "/api/conferences") return originalFetch("/demo-event/conferences.json");
      if (url.pathname === "/api/settings") return Promise.resolve(jsonAnswer({ web: true }, 200));
      if (slug === DEMO_SLUG && DEMO_ROUTES[url.pathname])
        return originalFetch(`/demo-event/${DEMO_ROUTES[url.pathname]}`);
      if (slug === DEMO_SLUG && url.pathname === "/api/note" && DEMO_NOTE.test(note))
        return originalFetch(`/demo-event/notes/${note}.json`);
    }
    if (DEMO_CONCIERGE.includes(url.pathname)) {
      if (!starter) openDemoSignIn();
      const line = JSON.stringify({
        text: starter
          ? "The starter event lives in this browser only. Go back to your events and the Concierge works on your own notebook; it can import Beyond The Prompt there too."
          : "The Concierge works on your own notebook: sign in to use it, with a free trial of AI credits.",
      });
      return Promise.resolve(
        new Response(`${line}\n`, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      );
    }
    return Promise.resolve(
      jsonAnswer({ error: "Sign in required.", signInUrl: DEMO_SIGN_IN }, 401),
    );
  }
  function demoSignInLink(className) {
    const link = document.createElement("a");
    link.className = className;
    link.href = DEMO_SIGN_IN;
    link.textContent = "Sign in";
    link.addEventListener("click", leaveDemo);
    return link;
  }
  function openDemoSignIn() {
    if (document.getElementById("demoSignIn")) return;
    const overlay = document.createElement("div");
    overlay.className = "modal-ov";
    overlay.id = "demoSignIn";
    const box = document.createElement("div");
    box.className = "modal-box demo-sign-in";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Sign in to use the Concierge");
    const head = document.createElement("div");
    head.className = "modal-head";
    const title = document.createElement("span");
    title.className = "modal-title";
    title.textContent = "Sign in to use the Concierge";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "modal-x";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    head.append(title, close);
    const body = document.createElement("div");
    body.className = "modal-body";
    const text = document.createElement("p");
    text.textContent =
      "The demo event is read-only and saves your notes in this browser. AI steps run on an account: new accounts get a free trial of credits.";
    const actions = document.createElement("div");
    actions.className = "demo-sign-in-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Keep exploring";
    actions.append(demoSignInLink("primary"), cancel);
    body.append(text, actions);
    box.append(head, body);
    overlay.append(box);
    const dismiss = () => overlay.remove();
    close.addEventListener("click", dismiss);
    cancel.addEventListener("click", dismiss);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) dismiss();
    });
    document.body.append(overlay);
  }
  // The banner over the demo: what it is, where notes go, and the two ways out.
  function showDemoBanner() {
    const bar = document.createElement("div");
    bar.className = "demo-event-bar";
    bar.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = starter
      ? "Starter event: your notes here stay in this browser."
      : "Demo: saved in this browser. Sign in to keep your notes.";
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "demo-event-leave";
    leave.textContent = starter ? "Back to my events" : "Leave demo";
    leave.addEventListener("click", () => {
      leaveDemo();
      history.replaceState(null, "", "/#/");
      location.reload();
    });
    if (starter) bar.append(text, leave);
    else bar.append(text, demoSignInLink("primary demo-event-signin"), leave);
    // In the top bar, before the right-hand controls: the page's own grid layout stays as it is.
    const right = document.getElementById("rightctl");
    if (right) right.before(bar);
    else document.body.prepend(bar);
    document.body.classList.add("demo-event");
  }
  if (demoEvent && !starter) {
    // A signed-out demo ends once there is an account (the starter event is the signed-in way in).
    originalFetch("/api/me")
      .then((response) => {
        if (response.ok) {
          leaveDemo();
          location.reload();
        }
      })
      .catch(() => {});
  }
  if (demoEvent) {
    if (document.body) showDemoBanner();
    else document.addEventListener("DOMContentLoaded", showDemoBanner);
  }

  window.addEventListener("confnote-workspace", (event) => {
    if (typeof event.detail !== "string") return;
    workspace = event.detail;
    const url = new URL(location.href);
    url.searchParams.set("workspace", workspace);
    history.replaceState(null, "", url);
  });
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (demoEvent && url.origin === location.origin && url.pathname.startsWith("/api/")) {
      const answer = demoAnswer(url, (options.method || "GET").toUpperCase());
      if (answer) return answer;
    }
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
      const headers = new Headers(
        options.headers || (input instanceof Request ? input.headers : undefined),
      );
      if (workspace) headers.set("x-workspace-id", workspace);
      options = { ...options, headers };
      if (
        byok &&
        ["/api/chat/global", "/api/chat/session"].includes(url.pathname) &&
        typeof options.body === "string"
      )
        options.body = JSON.stringify({ ...JSON.parse(options.body), byok });
    }
    const response = await originalFetch(input, options);
    if (url.pathname === "/api/conferences" && options.method === "POST" && response.ok) {
      const result = await response.clone().json();
      if (result.workspaceId) {
        workspace = result.workspaceId;
        const next = new URL(location.href);
        next.searchParams.set("workspace", workspace);
        history.replaceState(null, "", next);
      }
    }
    return response;
  };
  // The hosted site asks who is signed in once, before app.js loads. Signed out, the notebook and settings
  // routes only answer 401, so app.js checks `signedIn` before asking for the conference list.
  // The public demo has no account at all (its /api/me answers 401) but its notebook is open, so it never probes.
  const meProbe =
    window.confnote?.webMode && !window.confnote.publicDemo
      ? fetch("/api/me").catch(() => null)
      : null;
  if (meProbe) window.confnote.signedIn = meProbe.then((response) => response?.status !== 401);
  async function start() {
    const signedOut = meProbe && (await meProbe)?.status === 401;
    // Signed out, /api/settings would answer 401 too; the hosted settings always say `web`.
    const settings =
      signedOut || demoEvent
        ? { web: true }
        : await originalFetch("/api/settings")
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null);
    // The local server answers /api/settings without `web`; probing /api/me there only logs a 404.
    if (settings && !settings.web && !window.confnote?.webMode) return;
    const meResponse = await (meProbe || fetch("/api/me").catch(() => null));
    if (!meResponse || (!meResponse.ok && !settings?.web && meResponse.status !== 401)) return;
    // Profile sits in the top bar before Settings: who you are, AI credits, notebooks, your own AI key,
    // the Mac app. Settings (⚙) keeps how this app behaves (transcription, notes folder, shortcuts).
    const panel = document.createElement("details");
    panel.className = "product-account";
    panel.id = "profileMenu";
    panel.innerHTML = '<summary></summary><div class="product-controls"></div>';
    const summary = panel.querySelector("summary");
    const controls = panel.querySelector("div");
    // The control joins the top bar only once its label is final, so it never resizes in place.
    if (!meResponse.ok) {
      summary.textContent = "Sign in";
      placeInTopBar(panel);
      controls.innerHTML = `<p class="pa-lede">Sign in to keep your notebooks, AI credits and shortlist with you.</p><a class="primary pa-signin" href="/api/auth/signin">Sign in or create an account</a>`;
      return;
    }
    const me = await meResponse.json();
    summary.innerHTML = '<span class="pa-avatar" aria-hidden="true"></span><span>Profile</span>';
    summary.querySelector(".pa-avatar").textContent = (me.email || "?").slice(0, 1).toUpperCase();
    placeInTopBar(panel);
    const identity = document.createElement("p");
    identity.className = "pa-identity";
    identity.textContent = `${me.email} · ${me.entitlements.plan}`;
    controls.append(identity);
    const credits = document.createElement("section");
    credits.className = "pa-section pa-credits";
    credits.innerHTML = '<h3 class="pa-h">AI credits</h3>';
    controls.append(credits);
    controls.insertAdjacentHTML(
      "beforeend",
      `<section class="pa-section"><h3 class="pa-h">Notebook</h3><label class="pa-field"><span>Open notebook</span><select id="account-workspace"></select></label><div class="pa-row"><button type="button" id="vault-export" class="pa-btn">Export this notebook</button><label class="pa-btn pa-file">Import notebook<input id="vault-import" type="file" accept="application/json"></label></div></section><section class="pa-section"><h3 class="pa-h">Your AI key</h3><p class="pa-hint">Use your own provider key in this tab instead of credits. It is never stored.</p><form id="byok-form"><label class="pa-field"><span>AI provider</span><select name="provider"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select></label><label class="pa-field"><span>Model</span><input name="model" required placeholder="Provider model ID"></label><label class="pa-field"><span>Provider key</span><input name="key" type="password" autocomplete="off" required></label><div class="pa-row"><button class="pa-btn">Use my key for this tab</button><button type="button" id="byok-clear" class="pa-btn pa-quiet">Clear key</button></div></form></section><p id="account-status" role="status"></p><div class="pa-foot"><button type="button" id="account-signout" class="pa-btn pa-quiet">Sign out</button></div>`,
    );
    const status = controls.querySelector("#account-status");
    const select = controls.querySelector("select");
    const spaces = await fetch("/api/workspaces").then((response) => response.json());
    for (const item of spaces) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      option.selected = item.id === me.workspaceId;
      select.append(option);
    }
    select.addEventListener("change", () => {
      const url = new URL(location.href);
      url.searchParams.set("workspace", select.value);
      url.hash = "";
      location.href = url.href;
    });
    controls.querySelector("#byok-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const values = new FormData(event.target);
      byok = {
        provider: values.get("provider"),
        model: values.get("model"),
        apiKey: values.get("key"),
      };
      event.target.elements.key.value = "";
      status.textContent =
        "Your key is held in this tab only. Requests go directly to the selected provider.";
    });
    controls.querySelector("#byok-clear").addEventListener("click", () => {
      byok = null;
      status.textContent = "Key cleared. Platform credits will be used when configured.";
    });
    controls.querySelector("#vault-export").addEventListener("click", async () => {
      const response = await fetch("/api/vault/export");
      if (!response.ok) {
        status.textContent = "Export failed.";
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "confnote-vault.json";
      a.click();
      URL.revokeObjectURL(url);
    });
    controls.querySelector("#vault-import").addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 2000000) {
        status.textContent = "Notebook exceeds the 2 MB import limit.";
        return;
      }
      const response = await fetch("/api/vault/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await file.text(),
      });
      const result = await response.json();
      if (response.ok) location.href = result.url;
      else status.textContent = result.error;
    });
    controls.querySelector("#account-signout").addEventListener("click", async () => {
      byok = null;
      const response = await fetch("/api/auth/signout", { method: "POST" });
      const result = await response.json();
      location.href = result.logoutUrl || "/";
    });
    await mountWallet(credits);
  }

  // Profile goes right before Settings, so the top bar reads … Profile · ⚙ · theme. It closes on an outside
  // click or Escape, like a menu.
  function placeInTopBar(panel) {
    const settings = document.getElementById("settingsBtn");
    if (settings) settings.before(panel);
    else document.body.append(panel);
    document.addEventListener("click", (event) => {
      if (panel.open && !panel.contains(event.target)) panel.open = false;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel.open) {
        panel.open = false;
        panel.querySelector("summary").focus();
      }
    });
  }

  // Wallet: balance in the account menu, a buy-more card in the Concierge at 402,
  // and a pack picker priced by the Router catalog and paid with PayPal (JS SDK v6).
  const PAYPAL_SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";
  // Card Fields (save a card for auto top-up with no PayPal login) are a JS SDK v5 component. It loads
  // under its own namespace so it never replaces v6's window.paypal.
  const CARD_FIELDS_SDK_URL = "https://www.sandbox.paypal.com/sdk/js";
  const CARD_FIELDS_NAMESPACE = "paypalCardFields";
  const MICROS_PER_USD = 1000000;
  const MINOR_PER_MAJOR = 100;
  const CAPTURE_RECHECK_MS = [2000, 5000, 10000];
  // The capture route answers 409 when PayPal has no approved payment for the order.
  const ORDER_NOT_CAPTURED = 409;
  const PAYMENT_UNCONFIRMED =
    "PayPal closed before the payment was confirmed. If it went through, your credits appear in a moment.";
  const AUTO_TOP_UP_SKU = "pack_usd_5";
  const AUTO_TOP_UP_CAP_MICROS = 25 * MICROS_PER_USD;
  // Why the Router's auto top-up did not cover this step (its 402 `autoTopUp` field).
  const AUTO_TOP_UP_REASONS = {
    capped: "Auto top-up is on, but this month's limit is reached.",
    declined: "Auto top-up could not charge your saved payment method.",
    off: "Auto top-up is off.",
    in_flight: "An auto top-up is in progress. Try again in a moment.",
    granted: "Auto top-up added credits, but not enough for this step.",
  };
  let paypalSdk = null;
  let cardFieldsSdk = null;
  // The latest pay mount per host; an older async mount that finishes late appends nothing.
  const payMounts = new WeakMap();

  // Same rule as the checkout route: only the PayPal sandbox approve page (live adds www.paypal.com).
  const PAYPAL_APPROVE_HOSTS = ["www.sandbox.paypal.com"];
  function isPaypalApproveUrl(value) {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        PAYPAL_APPROVE_HOSTS.includes(url.hostname) &&
        !url.port &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }

  function usd(micros) {
    return `$${(Number(micros || 0) / MICROS_PER_USD).toFixed(2)}`;
  }

  function packPrice(price) {
    const amount = (Number(price.amountMinor) / MINOR_PER_MAJOR).toFixed(2);
    return price.currency === "USD" ? `$${amount}` : `${amount} ${price.currency}`;
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || "The payment could not be completed.");
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function loadPaypalSdk() {
    if (window.paypal?.createInstance) return Promise.resolve(window.paypal);
    paypalSdk ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PAYPAL_SDK_URL;
      script.async = true;
      script.onload = () =>
        window.paypal?.createInstance ? resolve(window.paypal) : reject(new Error("PayPal SDK"));
      script.onerror = () => reject(new Error("PayPal SDK"));
      document.head.append(script);
    }).catch((error) => {
      paypalSdk = null;
      throw error;
    });
    return paypalSdk;
  }

  function loadCardFieldsSdk(clientId) {
    if (window[CARD_FIELDS_NAMESPACE]?.CardFields)
      return Promise.resolve(window[CARD_FIELDS_NAMESPACE]);
    cardFieldsSdk ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const query = new URLSearchParams({
        "client-id": clientId,
        components: "card-fields",
        currency: "USD",
        intent: "capture",
      });
      script.src = `${CARD_FIELDS_SDK_URL}?${query}`;
      script.dataset.namespace = CARD_FIELDS_NAMESPACE;
      script.async = true;
      script.onload = () =>
        window[CARD_FIELDS_NAMESPACE]?.CardFields
          ? resolve(window[CARD_FIELDS_NAMESPACE])
          : reject(new Error("PayPal Card Fields"));
      script.onerror = () => reject(new Error("PayPal Card Fields"));
      document.head.append(script);
    }).catch((error) => {
      cardFieldsSdk = null;
      throw error;
    });
    return cardFieldsSdk;
  }

  async function capture(orderId) {
    const result = await postJson("/api/wallet/capture", { orderId });
    if (result.status !== "captured") throw new Error("PayPal did not capture the payment.");
    window.dispatchEvent(new Event("confnote-wallet-changed"));
    // The Router may post the grant a few seconds after the capture answers; look again.
    for (const ms of CAPTURE_RECHECK_MS) {
      setTimeout(() => window.dispatchEvent(new Event("confnote-wallet-changed")), ms);
    }
    return result;
  }

  function autoTopUpLine(policy) {
    const cap = usd(policy.monthlyCapUsdMicros || AUTO_TOP_UP_CAP_MICROS);
    return policy.enabled
      ? `Card saved · auto top-up on, monthly cap ${cap}`
      : "Card saved · auto top-up off";
  }

  // The card is saved at PayPal on capture; auto top-up starts on, with the default pack and cap.
  async function enableAutoTopUp() {
    try {
      const policy = await postJson("/api/wallet/autotopup", {
        enabled: true,
        sku: AUTO_TOP_UP_SKU,
        monthlyCapUsdMicros: AUTO_TOP_UP_CAP_MICROS,
      });
      return autoTopUpLine(policy);
    } catch (error) {
      return `Card saved. Auto top-up could not be turned on: ${error.message}`;
    } finally {
      window.dispatchEvent(new Event("confnote-wallet-changed"));
    }
  }

  // Save a card for auto top-up: PayPal Card Fields confirm the card against a Router card order
  // (store_in_vault), so no PayPal login is needed. One-off purchases keep the PayPal buttons.
  async function mountCardFields(host, paypal, sku, status, onPaid, consent, current) {
    if (!paypal?.clientId) {
      status.textContent =
        "Card entry is not available. Untick “Save this card” to pay with PayPal.";
      return;
    }
    let fields;
    try {
      const sdk = await loadCardFieldsSdk(paypal.clientId);
      fields = sdk.CardFields({
        createOrder: async () => {
          if (!consent.box.checked || !consent.save.checked) throw new Error("consent");
          return (
            await postJson("/api/wallet/checkout", {
              sku,
              consent: { accepted: true, at: consent.at },
              saveForAutoTopUp: true,
              paymentSource: "card",
            })
          ).orderId;
        },
        onApprove: async (data) => {
          status.textContent = "Adding credits…";
          try {
            const result = await capture(data.orderID);
            onPaid(
              result.savedForAutoTopUp
                ? await enableAutoTopUp()
                : "The card was not saved; auto top-up stays off.",
            );
          } catch (error) {
            status.textContent = error.message;
          }
        },
        onError: () => {
          status.textContent =
            "The card could not be charged. Nothing was taken; check the details.";
        },
      });
    } catch {
      status.textContent = "Card entry could not load. Untick “Save this card” to pay with PayPal.";
      return;
    }
    // A newer mount (the save box toggled while the SDK loaded) owns the host now.
    if (!current()) return;
    if (!fields.isEligible()) {
      status.textContent =
        "Card entry is not available. Untick “Save this card” to pay with PayPal.";
      return;
    }
    const form = document.createElement("div");
    form.className = "wallet-card-fields";
    const parts = [
      ["NameField", "wallet-card-name"],
      ["NumberField", "wallet-card-number"],
      ["ExpiryField", "wallet-card-expiry"],
      ["CVVField", "wallet-card-cvv"],
    ];
    const slots = parts.map(([, id]) => {
      const slot = document.createElement("div");
      slot.id = id;
      return slot;
    });
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "wallet-pay";
    submit.textContent = "Pay and save card";
    submit.addEventListener("click", () => {
      if (!consent.box.checked) return;
      status.textContent = "";
      fields.submit().catch(() => {
        status.textContent = "Check the card details and try again.";
      });
    });
    form.append(...slots, submit);
    host.append(form);
    await Promise.all(parts.map(([field], index) => fields[field]().render(slots[index])));
    consent.sync();
  }

  // Pay with the PayPal JS SDK v6 one-time payment session; without a client id or
  // when the SDK cannot load, follow the Router order's approve link instead.
  async function mountPayButton(host, paypal, sku, status, onPaid, consent) {
    const mountId = (payMounts.get(host) || 0) + 1;
    payMounts.set(host, mountId);
    const current = () => payMounts.get(host) === mountId;
    host.replaceChildren();
    status.textContent = "";
    if (consent.save.checked) {
      await mountCardFields(host, paypal, sku, status, onPaid, consent, current);
      return;
    }
    const order = () =>
      postJson("/api/wallet/checkout", {
        sku,
        consent: { accepted: true, at: consent.at },
      });
    const fallback = document.createElement("button");
    fallback.type = "button";
    fallback.className = "wallet-pay";
    fallback.textContent = "Pay with PayPal";
    fallback.addEventListener("click", async () => {
      if (!consent.box.checked) return;
      try {
        const approveUrl = (await order()).approveUrl;
        if (!isPaypalApproveUrl(approveUrl)) {
          status.textContent =
            "PayPal returned an unexpected link. Nothing was charged; try again.";
          return;
        }
        location.href = approveUrl;
      } catch (error) {
        status.textContent = error.message;
      }
    });
    if (!paypal?.clientId) {
      host.append(fallback);
      consent.sync();
      return;
    }
    try {
      const sdk = await loadPaypalSdk();
      const instance = await sdk.createInstance({
        clientId: paypal.clientId,
        components: ["paypal-payments"],
        pageType: "checkout",
      });
      // One attempt per click. PayPal can report a cancel after the buyer approved (its popup closed late):
      // once approved, a cancel says nothing; a cancel before onApprove asks the Router whether the order was
      // paid (it captures only an approved order), so a paid order never reads "Payment cancelled.".
      let attempt = { orderId: null, approved: false, paid: false };
      const paidFor = (current) => {
        if (current.paid) return;
        current.paid = true;
        onPaid();
      };
      const session = instance.createPayPalOneTimePaymentSession({
        onApprove: async (data) => {
          const current = attempt;
          current.approved = true;
          status.textContent = "Adding credits…";
          try {
            await capture(data.orderId);
            paidFor(current);
          } catch (error) {
            if (!current.paid) status.textContent = error.message;
          }
        },
        onCancel: async () => {
          const current = attempt;
          if (current.approved || current.paid) return;
          const orderId = await current.orderId?.catch(() => null);
          let message = "Payment cancelled.";
          if (orderId) {
            try {
              await capture(orderId);
              paidFor(current);
              return;
            } catch (error) {
              // 409: the order was never approved, a real cancel. Anything else leaves it unknown.
              if (error.status !== ORDER_NOT_CAPTURED) message = PAYMENT_UNCONFIRMED;
            }
          }
          if (current.approved || current.paid) return;
          status.textContent = message;
          if (message === PAYMENT_UNCONFIRMED)
            window.dispatchEvent(new Event("confnote-wallet-changed"));
        },
        onError: () => {
          status.textContent = "PayPal could not complete the payment. Try again.";
        },
      });
      if (!current()) return;
      const button = document.createElement("paypal-button");
      button.setAttribute("type", "pay");
      button.className = "wallet-pay";
      button.addEventListener("click", () => {
        if (!consent.box.checked) return;
        status.textContent = "";
        const orderId = order().then((result) => result.orderId);
        attempt = { orderId, approved: false, paid: false };
        session
          .start(
            { presentationMode: "auto" },
            orderId.then((id) => ({ orderId: id })),
          )
          .catch(() => {
            status.textContent = "PayPal could not open. Try again.";
          });
      });
      host.append(button);
    } catch {
      if (current()) host.append(fallback);
    }
    consent.sync();
  }

  // Immediate delivery waives the 14-day cancellation right; payment stays off until the buyer agrees.
  function consentBlock(pay) {
    const block = document.createElement("div");
    block.className = "wallet-consent";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.required = true;
    box.id = "wallet-consent";
    const text = document.createElement("span");
    text.textContent =
      "I want my credits now. I understand that credits are delivered immediately, and I lose my 14-day right to cancel. Credits are non-refundable.";
    label.append(box, text);
    const note = document.createElement("p");
    note.textContent =
      "All credit purchases are final. Unused credits don't expire while your account is open. ";
    const terms = document.createElement("a");
    terms.href = "/terms";
    terms.target = "_blank";
    terms.rel = "noopener";
    terms.textContent = "Terms";
    note.append(terms);
    // Optional: keep this card at PayPal so auto top-up can buy a pack without the buyer.
    const saveLabel = document.createElement("label");
    const save = document.createElement("input");
    save.type = "checkbox";
    save.id = "wallet-save-autotopup";
    const saveText = document.createElement("span");
    saveText.textContent = "Save this card for auto top-up";
    saveLabel.append(save, saveText);
    block.append(label, note, saveLabel);
    const consent = {
      box,
      save,
      at: null,
      sync() {
        pay.classList.toggle("off", !box.checked);
        for (const button of pay.querySelectorAll(".wallet-pay")) {
          button.toggleAttribute("disabled", !box.checked);
          button.setAttribute("aria-disabled", String(!box.checked));
        }
      },
    };
    box.addEventListener("change", () => {
      consent.at = box.checked ? new Date().toISOString() : null;
      consent.sync();
    });
    return { block, consent };
  }

  async function renderPicker(host, onPaid) {
    host.hidden = false;
    host.replaceChildren();
    const status = document.createElement("p");
    status.className = "wallet-status";
    status.setAttribute("role", "status");
    const response = await fetch("/api/wallet/packs").catch(() => null);
    const catalog = response?.ok ? await response.json() : null;
    if (!catalog?.packs?.length) {
      status.textContent = "Credit packs are not available right now.";
      host.append(status);
      return;
    }
    const list = document.createElement("div");
    list.className = "wallet-packs";
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "Credit pack");
    const pay = document.createElement("div");
    pay.className = "wallet-pay-host";
    const { block, consent } = consentBlock(pay);
    let selected = null;
    const mount = () => {
      if (selected) mountPayButton(pay, catalog.paypal, selected, status, onPaid, consent);
    };
    // Saving a card swaps the PayPal buttons for Card Fields, and back.
    consent.save.addEventListener("change", mount);
    for (const pack of catalog.packs) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "wallet-pack";
      option.dataset.sku = pack.sku;
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", "false");
      const price = document.createElement("strong");
      price.textContent = packPrice(pack.price);
      const credits = document.createElement("span");
      credits.textContent = `${usd(pack.credits)} of AI credits`;
      option.append(price, credits);
      option.addEventListener("click", () => {
        for (const other of list.children) other.setAttribute("aria-checked", "false");
        option.setAttribute("aria-checked", "true");
        selected = pack.sku;
        mount();
      });
      list.append(option);
    }
    // Every hosted site takes PayPal sandbox payments through judging (musa, 2026-11-12): say so where people pay.
    if (catalog.paypal?.environment === "sandbox") {
      const testMode = document.createElement("p");
      testMode.className = "wallet-test-mode";
      testMode.textContent = "Test payments: PayPal sandbox, no real money";
      host.append(testMode);
    }
    host.append(list, block, pay, status);
  }

  function creditsCard(detail) {
    document.querySelector(".wallet-card")?.remove();
    const card = document.createElement("section");
    card.className = "wallet-card";
    card.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = "You are out of AI credits";
    const need = document.createElement("p");
    need.textContent =
      typeof detail.required === "number"
        ? `Available ${usd(detail.available)} · this step needs ${usd(detail.required)}`
        : `Available ${usd(detail.available)}`;
    const topUp = document.createElement("p");
    topUp.className = "wallet-autotopup";
    topUp.textContent = Object.hasOwn(AUTO_TOP_UP_REASONS, detail.autoTopUp || "")
      ? AUTO_TOP_UP_REASONS[detail.autoTopUp]
      : "";
    topUp.hidden = !topUp.textContent;
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = "wallet-buy";
    buy.textContent = "Add credits";
    const picker = document.createElement("div");
    picker.className = "wallet-picker";
    picker.hidden = true;
    buy.addEventListener("click", () =>
      renderPicker(picker, (note) => {
        title.textContent = "Credits added. Send your message again.";
        // A saved card's auto top-up line replaces the shortfall line.
        if (note) need.textContent = note;
        else need.remove();
        topUp.remove();
        buy.remove();
        picker.remove();
      }),
    );
    card.append(title, need, topUp, buy, picker);
    const host = document.querySelector(".chat-inner") || document.querySelector(".drawer-body");
    (host || document.body).append(card);
    card.scrollIntoView({ block: "nearest" });
  }

  // Auto top-up: the Router buys AUTO_TOP_UP_SKU with the saved method when a step runs out, up to a monthly cap.
  function autoTopUpControl() {
    const block = document.createElement("div");
    block.className = "wallet-autotopup-setting";
    block.hidden = true;
    const toggle = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "autotopup-enabled";
    const text = document.createElement("span");
    toggle.append(box, text);
    // The monthly cap in whole dollars; the Router enforces it per UTC month.
    const capLabel = document.createElement("label");
    capLabel.className = "wallet-autotopup-cap";
    const capText = document.createElement("span");
    capText.textContent = "Monthly cap $";
    const capInput = document.createElement("input");
    capInput.type = "number";
    capInput.id = "autotopup-cap";
    capInput.min = "0";
    capInput.step = "1";
    capInput.inputMode = "numeric";
    capLabel.append(capText, capInput);
    block.append(toggle, capLabel);
    let sku = AUTO_TOP_UP_SKU;
    function show(policy) {
      const saved = Boolean(policy.savedMethod);
      sku = policy.sku || AUTO_TOP_UP_SKU;
      box.checked = Boolean(policy.enabled);
      box.disabled = !saved && !policy.enabled;
      const capMicros = policy.monthlyCapUsdMicros || AUTO_TOP_UP_CAP_MICROS;
      capInput.value = String(Math.round(capMicros / MICROS_PER_USD));
      capLabel.hidden = !saved;
      text.textContent = saved
        ? autoTopUpLine(policy)
        : "Auto top-up: buy a pack with “Save this card” ticked to turn it on";
      block.hidden = false;
    }
    async function save(enabled) {
      const dollars = Number(capInput.value);
      if (!Number.isInteger(dollars) || dollars < 0) {
        text.textContent = "Enter the monthly cap in whole dollars.";
        return;
      }
      try {
        show(
          await postJson("/api/wallet/autotopup", {
            enabled,
            sku,
            monthlyCapUsdMicros: dollars * MICROS_PER_USD,
          }),
        );
      } catch (error) {
        box.checked = !enabled;
        text.textContent = error.message;
      }
    }
    box.addEventListener("change", () => save(box.checked));
    capInput.addEventListener("change", () => save(box.checked));
    async function refresh() {
      const response = await fetch("/api/wallet/autotopup").catch(() => null);
      if (response?.ok) show(await response.json());
    }
    return { block, refresh };
  }

  async function mountWallet(section) {
    const line = document.createElement("p");
    line.id = "account-balance";
    line.hidden = true;
    const buy = document.createElement("button");
    buy.type = "button";
    buy.id = "account-buy-credits";
    buy.className = "primary";
    buy.textContent = "Buy AI credits";
    buy.hidden = true;
    const picker = document.createElement("div");
    picker.className = "wallet-picker";
    picker.hidden = true;
    const autoTopUp = autoTopUpControl();
    section.append(line, buy, picker, autoTopUp.block);
    // The credits section shows once the wallet answers; a build without one never shows it.
    section.hidden = true;
    buy.addEventListener("click", () =>
      renderPicker(picker, () => {
        picker.hidden = true;
      }),
    );
    async function refresh() {
      const response = await fetch("/api/wallet").catch(() => null);
      if (!response?.ok) return;
      const wallet = await response.json();
      line.textContent = `AI credits: ${usd(wallet.available)}`;
      line.hidden = false;
      section.hidden = false;
      buy.hidden = false;
      await autoTopUp.refresh();
    }
    window.addEventListener("confnote-concierge-turn", refresh);
    window.addEventListener("confnote-wallet-changed", refresh);
    window.addEventListener("confnote-credits-required", (event) => {
      event.preventDefault();
      creditsCard(event.detail || {});
      refresh();
    });
    // PayPal redirect fallback: the approve link returns with ?wallet=return&token=<order id>.
    const url = new URL(location.href);
    if (url.searchParams.get("wallet") === "return" && url.searchParams.get("token")) {
      const orderId = url.searchParams.get("token");
      for (const name of ["wallet", "token", "PayerID"]) url.searchParams.delete(name);
      history.replaceState(null, "", url);
      await capture(orderId).catch(() => {
        section.hidden = false;
        line.hidden = false;
        line.textContent = "The payment could not be completed. Try again.";
      });
    }
    await refresh();
  }
  // This script runs in <head> before app.js so app.js's first /api calls carry the workspace header;
  // the account panel needs <body>, so it waits for the parser.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => start().catch(() => {}), { once: true });
  } else {
    start().catch(() => {});
  }
})();
