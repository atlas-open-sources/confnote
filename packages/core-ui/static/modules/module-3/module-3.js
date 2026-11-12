/* Module 3 — third placeholder drawer module. Same shape as Module 1 / 2. */
(function () {
  if (!window.confnote || !window.confnote.drawer) return;
  window.confnote.drawer.register({
    id: "module-3",
    label: "Module 3",
    render(host, ctx) {
      const wrap = document.createElement("div");
      wrap.className = "drawer-placeholder";
      const h = document.createElement("h3");
      h.textContent = "Module 3 — placeholder";
      const p = document.createElement("p");
      p.textContent =
        "Three of four available drawer slots. The Concierge sits in the " +
        "fourth (bottom) slot by convention.";
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
