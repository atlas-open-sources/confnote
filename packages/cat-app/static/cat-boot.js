/* ConfNote inside Local AI Cat: runs first, before any of ConfNote's own scripts.
   The Cat sandboxes the page with an opaque origin, where reading `localStorage` throws.
   ConfNote keeps UI state there (theme pin, sidebar width, collapsed panels), so it gets an
   in-memory stand-in for the session. */
(() => {
  "use strict";

  function memoryStorage() {
    const values = new Map();
    return {
      get length() {
        return values.size;
      },
      key(index) {
        return Array.from(values.keys())[index] ?? null;
      },
      getItem(key) {
        return values.has(String(key)) ? values.get(String(key)) : null;
      },
      setItem(key, value) {
        values.set(String(key), String(value));
      },
      removeItem(key) {
        values.delete(String(key));
      },
      clear() {
        values.clear();
      },
    };
  }

  let usable = false;
  try {
    usable = Boolean(window.localStorage);
  } catch {
    usable = false;
  }
  if (!usable) {
    Object.defineProperty(window, "localStorage", {
      value: memoryStorage(),
      configurable: true,
    });
  }

  window.confnote = window.confnote || {};
  window.confnote.webMode = true;
  window.confnote.catMode = true;
  // No Concierge in the Cat yet (no agent, no network): app.js's own hook skips building
  // the bottom-right button when the FAB is suppressed before it runs.
  window.confnote.fab = Object.assign(window.confnote.fab || {}, { suppressed: true });
  document.documentElement.dataset.host = "cat";
})();
