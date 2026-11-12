/* toast.js — tiny top-right notification primitive.
 *
 * Usage:
 *   window.confnote.showToast({ title, body, kind })
 *
 * kind ∈ {"ok" | "err"}. Defaults to "ok". Stacks multiple toasts; each
 * lives ~4 s then slides out. No external deps. Loaded once via a
 * script tag in index.html.
 *
 * This is intentionally NOT a drawer module — toasts are global UI
 * chrome, not slot content. Modules can call showToast() to surface
 * completion of a long-running flow (e.g. `/brief` writing BRIEF.md).
 */
(function () {
  const STACK_GAP = 8;
  const DEFAULT_TTL = 4200;
  let stripEl = null;

  function ensureStrip() {
    if (stripEl) return stripEl;
    stripEl = document.createElement("div");
    stripEl.id = "toastStrip";
    stripEl.className = "toast-strip";
    stripEl.setAttribute("role", "status");
    stripEl.setAttribute("aria-live", "polite");
    document.body.appendChild(stripEl);
    return stripEl;
  }

  function showToast(opts) {
    opts = opts || {};
    const strip = ensureStrip();

    const t = document.createElement("div");
    t.className = "toast toast-" + (opts.kind === "err" ? "err" : "ok");

    if (opts.title) {
      const h = document.createElement("div");
      h.className = "toast-title";
      h.textContent = opts.title;
      t.appendChild(h);
    }
    if (opts.body) {
      const b = document.createElement("div");
      b.className = "toast-body";
      b.textContent = opts.body;
      t.appendChild(b);
    }

    // Click dismisses immediately.
    t.addEventListener("click", () => dismiss(t));

    strip.appendChild(t);

    // Force layout, then add `in` class so the CSS transition runs.
    // Without rAF the element renders in its final state with no slide.
    requestAnimationFrame(() => t.classList.add("in"));

    const ttl = Number.isFinite(opts.ttl) ? opts.ttl : DEFAULT_TTL;
    setTimeout(() => dismiss(t), ttl);
    return t;
  }

  function dismiss(t) {
    if (!t || !t.isConnected) return;
    t.classList.remove("in");
    t.classList.add("out");
    setTimeout(() => {
      try {
        t.remove();
      } catch {}
    }, 280);
  }

  window.confnote = window.confnote || {};
  window.confnote.showToast = showToast;
  // For tests + manual reset.
  window.confnote._toastStripEl = () => stripEl;
  // exported for completeness, though stack gap is currently CSS-driven
  window.confnote._toastStackGap = STACK_GAP;
})();
