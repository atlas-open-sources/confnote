/* drawer.js — right-edge drawer primitive for side-panel modules.
 *
 * Up to MAX_SLOTS modules per page, listed in `/modules.config.json`:
 *
 *     { "slots": ["chat", "module-1"], "primitive_override": {} }
 *
 * Each module's entry script (e.g. /modules/chat/chat.js) self-registers via
 *   window.confnote.drawer.register({ id, label, render })
 * Render receives the host element to mount its UI into + a context object
 * (current slug/file/conf, updated by app.js via window.confnote.setContext).
 *
 * Visual contract:
 *  - Tab handles stack vertically on the right edge (mid-height).
 *  - Click a handle → drawer slides in from the right, default width 480px.
 *  - Click again / × in head → drawer slides out.
 *  - Left edge of the open drawer is a draggable resize grip (300–900px).
 *  - Selected handle moves with the drawer's left edge while open.
 *  - Width persisted to localStorage as `confnote-drawer-w`.
 *
 * Independent of app.js. Loaded by a single <script> tag in index.html.
 * If `/modules.config.json` is missing or empty, the drawer stays dormant
 * (no handles, no DOM cost) — local default ships with chat in slot 1.
 */
(function () {
  const MAX_SLOTS = 4;
  const MAX_OPEN = 2; // panels open side-by-side at once (shift+click a handle)
  const STORAGE_KEY = "confnote-drawer-w";
  const DEFAULT_W = 480;
  const MIN_W = 300;
  const MAX_W = 900;

  // ---- module registry --------------------------------------------------
  const REGISTRY = {}; // id -> { label, render, mounted: bool }
  let SLOT_ORDER = []; // ordered list of module ids
  // Open module ids, in on-screen order (index 0 = rightmost). Up to MAX_OPEN.
  let OPEN_IDS = [];
  const HOSTS = []; // up to MAX_OPEN host panels: { host, title, extras, body, grip, showing }
  const HOST_FOR = {}; // module id -> the host refs currently rendering it
  const CLOSE_CBS = {}; // module id -> callback fired when its panel closes

  function register({ id, label, render, renderHead }) {
    if (!id || typeof render !== "function") return;
    REGISTRY[id] = {
      label: label || id,
      render,
      renderHead: typeof renderHead === "function" ? renderHead : null,
      mounted: false,
    };
    // if we already painted the strip before this module's script loaded,
    // repaint so its handle appears.
    if (document.getElementById("drawerStrip")) paintStrip();
  }

  // ---- width persistence ------------------------------------------------
  function applyWidth(px) {
    const w = Math.max(MIN_W, Math.min(MAX_W, Math.round(px)));
    document.documentElement.style.setProperty("--drawer-w", w + "px");
    try {
      localStorage.setItem(STORAGE_KEY, String(w));
    } catch (e) {}
    return w;
  }

  function restoreWidth() {
    const saved = parseInt(localStorage.getItem(STORAGE_KEY) || "", 10);
    const w = Number.isFinite(saved) ? saved : DEFAULT_W;
    document.documentElement.style.setProperty("--drawer-w", w + "px");
  }

  // ---- DOM scaffolding --------------------------------------------------
  // Build one host panel. `suffix` is "" for the primary panel (keeps the
  // original element ids — chat module + e2e rely on them) and "2" for the
  // secondary panel used when a second module is opened alongside.
  function makeHost(suffix) {
    const host = document.createElement("aside");
    host.id = "drawerHost" + suffix;
    host.className = "drawer-host";
    host.setAttribute("aria-hidden", "true");

    const grip = document.createElement("div");
    grip.id = "drawerGrip" + suffix;
    grip.className = "drawer-grip";
    grip.title = "Drag to resize";
    grip.setAttribute("aria-label", "Resize drawer");
    host.appendChild(grip);

    const head = document.createElement("div");
    head.className = "drawer-head";
    const title = document.createElement("span");
    title.id = "drawerTitle" + suffix;
    title.className = "drawer-title";
    head.appendChild(title);
    const extras = document.createElement("div");
    extras.id = "drawerHeadExtras" + suffix;
    extras.className = "drawer-head-extras";
    head.appendChild(extras);
    const close = document.createElement("button");
    close.id = "drawerClose" + suffix;
    close.type = "button";
    close.className = "drawer-x";
    close.setAttribute("aria-label", "Close drawer");
    close.textContent = "×";
    head.appendChild(close);
    host.appendChild(head);

    const body = document.createElement("div");
    body.id = "drawerBody" + suffix;
    body.className = "drawer-body";
    host.appendChild(body);

    document.body.appendChild(host);

    const refs = { host, title, extras, body, grip, showing: null };
    close.addEventListener("click", () => closeDrawer(refs.showing));
    wireGrip(grip);
    return refs;
  }

  function ensureDOM() {
    if (HOSTS.length) return;
    const strip = document.createElement("div");
    strip.id = "drawerStrip";
    strip.className = "drawer-strip";
    strip.setAttribute("role", "tablist");
    document.body.appendChild(strip);
    for (let i = 0; i < MAX_OPEN; i++) HOSTS.push(makeHost(i === 0 ? "" : String(i + 1)));
  }

  function wireGrip(grip) {
    let pid = null;
    grip.addEventListener("pointerdown", (e) => {
      pid = e.pointerId;
      grip.setPointerCapture(pid);
      grip.classList.add("dragging");
      document.body.classList.add("drawer-resizing");
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (pid === null) return;
      // drawer sits flush to viewport right edge; width = viewport.x_right - clientX
      const w = window.innerWidth - e.clientX;
      applyWidth(w);
    });
    const end = () => {
      if (pid === null) return;
      try {
        grip.releasePointerCapture(pid);
      } catch (e) {}
      pid = null;
      grip.classList.remove("dragging");
      document.body.classList.remove("drawer-resizing");
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  // ---- strip + panel rendering -----------------------------------------
  function paintStrip() {
    const strip = document.getElementById("drawerStrip");
    if (!strip) return;
    strip.replaceChildren();
    SLOT_ORDER.forEach((id) => {
      const mod = REGISTRY[id];
      if (!mod) return; // module hasn't registered yet — handle reserved
      const btn = document.createElement("button");
      btn.className = "drawer-tab" + (OPEN_IDS.includes(id) ? " on" : "");
      btn.type = "button";
      btn.dataset.id = id;
      btn.title = mod.label + " — shift-click to open alongside another";
      btn.setAttribute("aria-label", mod.label);
      const t = document.createElement("span");
      t.className = "drawer-tab-text";
      t.textContent = mod.label;
      btn.appendChild(t);
      // Plain click: open just this one. Shift-click: open it alongside the
      // current panel (e.g. Concierge + tldraw, to watch it draw live).
      btn.addEventListener("click", (e) => toggle(id, e.shiftKey));
      strip.appendChild(btn);
    });
  }

  // Render module `id` into a host panel's title / extras / body.
  function renderInto(refs, id) {
    refs.title.textContent = REGISTRY[id].label;
    refs.extras.replaceChildren(); // wipe previous module's header buttons
    refs.body.replaceChildren();
    try {
      if (REGISTRY[id].renderHead) {
        REGISTRY[id].renderHead(refs.extras, window.confnote.context || {});
      }
      REGISTRY[id].render(refs.body, window.confnote.context || {});
      REGISTRY[id].mounted = true;
    } catch (e) {
      const err = document.createElement("div");
      err.className = "drawer-err";
      err.textContent = "module error: " + (e && e.message ? e.message : String(e));
      refs.body.appendChild(err);
    }
  }

  // Reconcile the host panels with OPEN_IDS. Stable: a module already showing
  // in a host is NOT re-rendered, so opening a second panel never remounts (and
  // wipes) the first — an in-progress sketch / chat scroll survives.
  function layout() {
    ensureDOM();
    // 1. Free any host whose module is no longer open.
    HOSTS.forEach((refs) => {
      if (refs.showing && !OPEN_IDS.includes(refs.showing)) {
        const closedId = refs.showing;
        delete HOST_FOR[closedId];
        refs.showing = null;
        // let the module clean up / persist before we wipe its DOM
        if (typeof CLOSE_CBS[closedId] === "function") {
          try {
            CLOSE_CBS[closedId]();
          } catch (e) {}
        }
        refs.host.classList.remove("open");
        refs.host.setAttribute("aria-hidden", "true");
        refs.extras.replaceChildren();
        refs.body.replaceChildren();
      }
    });
    // 2. Mount any newly-open module into a free host (leave mounted ones be).
    OPEN_IDS.forEach((id) => {
      if (HOST_FOR[id]) return;
      const free = HOSTS.find((r) => !r.showing);
      if (!free) return;
      free.showing = id;
      HOST_FOR[id] = free;
      renderInto(free, id);
      free.host.classList.add("open");
      free.host.setAttribute("aria-hidden", "false");
    });
    // 3. Pack open panels against the right edge in OPEN_IDS order (index 0 =
    //    rightmost). Only the rightmost panel exposes its resize grip.
    OPEN_IDS.forEach((id, rank) => {
      const refs = HOST_FOR[id];
      if (!refs) return;
      refs.host.style.right = "calc(" + rank + " * var(--drawer-w))";
      refs.grip.style.display = rank === 0 ? "" : "none";
    });
    // 4. Reserve the combined width for the handle strip + main content.
    document.documentElement.style.setProperty(
      "--open-w",
      "calc(" + OPEN_IDS.length + " * var(--drawer-w))",
    );
    document.body.classList.toggle("drawer-open", OPEN_IDS.length > 0);
    paintStrip();
  }

  function openDrawer(id) {
    if (!REGISTRY[id]) return;
    OPEN_IDS = [id];
    layout();
  }

  // Shift-click: toggle `id` into the open set alongside the current panel(s),
  // capped at MAX_OPEN (oldest drops out).
  function openAlongside(id) {
    if (!REGISTRY[id]) return;
    const i = OPEN_IDS.indexOf(id);
    if (i >= 0) {
      OPEN_IDS.splice(i, 1);
    } else {
      OPEN_IDS.push(id);
      if (OPEN_IDS.length > MAX_OPEN) OPEN_IDS.shift();
    }
    layout();
  }

  // Close one panel (by module id) or all (no arg).
  function closeDrawer(id) {
    if (id == null) {
      OPEN_IDS = [];
    } else {
      const i = OPEN_IDS.indexOf(id);
      if (i >= 0) OPEN_IDS.splice(i, 1);
    }
    layout();
  }

  function toggle(id, additive) {
    if (additive) return openAlongside(id);
    if (OPEN_IDS.length === 1 && OPEN_IDS[0] === id) closeDrawer();
    else openDrawer(id);
  }

  // ---- module bootstrap from config ------------------------------------
  function loadScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = src;
      s.defer = true;
      // tolerate failures — the strip simply won't show that slot's handle
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  // `drawerReady` resolves once bootstrap finishes — modules' loads + any
  // suppress-the-FAB side-effects have all run. app.js awaits this before
  // building the legacy FAB so it never flashes when chat is in the drawer.
  let resolveReady;
  const READY = new Promise((r) => {
    resolveReady = r;
  });

  async function bootstrap() {
    restoreWidth();
    let cfg;
    try {
      const r = await fetch("/modules.config.json", { cache: "no-cache" });
      if (r.ok) cfg = await r.json();
    } catch (e) {}
    cfg = cfg || { slots: [] };
    SLOT_ORDER = (Array.isArray(cfg.slots) ? cfg.slots : []).slice(0, MAX_SLOTS);
    if (!SLOT_ORDER.length) {
      resolveReady(); // dormant but still ready
      return;
    }
    ensureDOM();
    paintStrip(); // reserves visual order even before modules finish loading
    // Load each module's entry script in parallel — registration is
    // independent + order-free, and serialising the loads here used to
    // introduce a race where a user could click a handle whose module
    // script hadn't loaded yet.
    await Promise.all(SLOT_ORDER.map((id) => loadScript(`/modules/${id}/${id}.js`)));
    paintStrip();
    resolveReady();
  }

  // ---- public API -------------------------------------------------------
  window.confnote = window.confnote || {};
  window.confnote.drawer = {
    MAX_SLOTS,
    register,
    open: openDrawer,
    close: closeDrawer,
    toggle,
    isOpen: (id) => OPEN_IDS.includes(id),
    currentId: () => OPEN_IDS[0] || null,
    openIds: () => OPEN_IDS.slice(),
    // Register a callback fired when this module's panel closes (cleanup /
    // persist). Survives across opens.
    onClose: (id, fn) => {
      if (id && typeof fn === "function") CLOSE_CBS[id] = fn;
    },
    ready: READY, // promise resolves after modules.config.json + scripts loaded
  };

  // Modules listen to context changes (current conf, current note, theme).
  // We BROADCAST only — we do NOT re-render the open module on every nav
  // change. That used to clobber in-flight UI state (most painfully: any
  // text a user had typed into a chat input). Modules that want to react
  // subscribe via window.confnote.onContextChange and update their own DOM
  // in-place without re-mounting.
  const CTX_LISTENERS = new Set();
  window.confnote.setContext = (ctx) => {
    window.confnote.context = ctx || {};
    CTX_LISTENERS.forEach((fn) => {
      try {
        fn(window.confnote.context);
      } catch (e) {}
    });
  };
  window.confnote.onContextChange = (fn) => {
    CTX_LISTENERS.add(fn);
    return () => CTX_LISTENERS.delete(fn);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
