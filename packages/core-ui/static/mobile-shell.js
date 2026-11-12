(() => {
  const topbar = document.getElementById("topbar");
  const sidebar = document.getElementById("sidebar");
  if (!topbar || !sidebar) return;
  const button = document.createElement("button");
  button.id = "mobile-agenda-toggle";
  button.className = "themebtn";
  button.textContent = "☰";
  button.setAttribute("aria-label", "Show agenda");
  button.setAttribute("aria-controls", "sidebar");
  button.setAttribute("aria-expanded", "false");
  topbar.prepend(button);
  function close() {
    document.body.classList.remove("mobile-agenda-open");
    button.setAttribute("aria-expanded", "false");
  }
  button.addEventListener("click", () => {
    const open = document.body.classList.toggle("mobile-agenda-open");
    button.setAttribute("aria-expanded", String(open));
  });
  sidebar.addEventListener("click", (event) => {
    if (event.target.closest("a[href]")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  window.addEventListener("hashchange", close);
})();
