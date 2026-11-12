/* The site's standalone pages share the app's theme: a pinned confnote-theme wins, auto follows the OS, and
   the top bar's #theme button cycles auto → light → dark exactly like the app's. Loaded in the head so the
   theme is set before the first paint. */
(function () {
  var GLYPH = { auto: "◐", light: "☀", dark: "☾" };
  var NEXT = { auto: "light", light: "dark", dark: "auto" };
  var root = document.documentElement;
  var pinned = localStorage.getItem("confnote-theme");
  if (pinned === "light" || pinned === "dark") root.dataset.theme = pinned;

  function cycle() {
    var next = NEXT[root.dataset.theme || "auto"];
    if (next === "auto") {
      delete root.dataset.theme;
      localStorage.removeItem("confnote-theme");
    } else {
      root.dataset.theme = next;
      localStorage.setItem("confnote-theme", next);
    }
    this.textContent = GLYPH[next];
  }

  document.addEventListener("DOMContentLoaded", function () {
    var button = document.getElementById("theme");
    if (!button) return;
    button.textContent = GLYPH[root.dataset.theme || "auto"];
    button.onclick = cycle;
  });
})();
