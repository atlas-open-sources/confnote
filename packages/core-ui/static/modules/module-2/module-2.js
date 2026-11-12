/* Module 2 — second placeholder drawer module. Same shape as Module 1. */
(function () {
  if (!window.confnote || !window.confnote.drawer) return;
  window.confnote.drawer.register({
    id: "module-2",
    label: "Module 2",
    render(host, ctx) {
      const wrap = document.createElement("div");
      wrap.className = "drawer-placeholder";
      const h = document.createElement("h3");
      h.textContent = "Module 2 — placeholder";
      const p = document.createElement("p");
      p.textContent =
        "Another empty slot to validate that MAX_DRAWER_SLOTS = 4 actually " +
        "renders multiple handles. Drag the left edge of the open drawer " +
        "to resize.";
      const meta = document.createElement("div");
      meta.style.marginTop = "12px";
      meta.style.fontSize = "11px";
      meta.style.color = "var(--faint)";
      meta.textContent = "ctx.slug = " + (ctx && ctx.slug ? ctx.slug : "—");
      wrap.append(h, p, meta);
      host.appendChild(wrap);
    },
  });
})();
