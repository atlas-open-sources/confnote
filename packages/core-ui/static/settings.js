/* settings.js — ⚙ Settings modal.
 *
 * Surfaces app settings as a centered overlay (same .modal-ov / .modal-box
 * chrome as the Brief / Debrief modals). First section: transcription
 * provider (Local AI Cat vs remote OpenAI) + base URL + model + API key.
 *
 * Security: the API key is WRITE-ONLY from the browser's perspective.
 *   GET  /api/settings        → { transcription: { …, has_api_key: bool } }   (never the key)
 *   POST /api/settings        → save (key sent only when the user types a new one)
 *   POST /api/settings/test   → probe the configured provider (saves first)
 *
 * Always available — browser and desktop. The "Open in browser" action
 * (formerly the ↗ topbar button) lives in here now, shown only under
 * pywebview.
 */
(() => {
  const ID = "settingsModal";
  let escHandler = null;

  function isDesktop() {
    return !!(window.pywebview && window.pywebview.api);
  }

  function close() {
    const ov = document.getElementById(ID);
    if (ov) ov.remove();
    if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
  }

  function row(labelText, control, hint) {
    const wrap = document.createElement("label");
    wrap.className = "set-row";
    const lab = document.createElement("span");
    lab.className = "set-label";
    lab.textContent = labelText;
    wrap.append(lab, control);
    if (hint) {
      const h = document.createElement("span");
      h.className = "set-hint";
      h.textContent = hint;
      wrap.append(h);
    }
    return wrap;
  }

  // Keyboard-shortcuts reference. Rendered from the single source of truth
  // (window.confnote.shortcuts, defined in app.js) so it never drifts from the
  // dispatcher. Read-only — a documentation surface, opened by `?`.
  function buildShortcutsSection() {
    const sec = document.createElement("section");
    sec.className = "set-section";
    sec.id = "setShortcuts";
    const h = document.createElement("h3");
    h.className = "set-h";
    h.textContent = "Keyboard shortcuts";
    sec.append(h);
    const groups = (window.confnote && window.confnote.shortcuts) || [];
    for (const g of groups) {
      const gh = document.createElement("div");
      gh.className = "set-sc-group";
      gh.textContent = g.group;
      sec.append(gh);
      const list = document.createElement("div");
      list.className = "set-sc-list";
      for (const it of g.items) {
        const r = document.createElement("div");
        r.className = "set-sc-row";
        const keys = document.createElement("span");
        keys.className = "set-sc-keys";
        for (const token of it.keys.split(" ")) {
          if (token === "/" || token === "–" || token === "-") {
            const sep = document.createElement("span");
            sep.className = "set-sc-sep";
            sep.textContent = token;
            keys.append(sep);
          } else {
            const kbd = document.createElement("kbd");
            kbd.textContent = token;
            keys.append(kbd);
          }
        }
        const desc = document.createElement("span");
        desc.className = "set-sc-desc";
        desc.textContent = it.desc;
        r.append(keys, desc);
        list.append(r);
      }
      sec.append(list);
    }
    return sec;
  }

  // One line: confnote also runs inside the Local AI Cat. Standalone stays
  // for people who want it separate or want to hack on it.
  function buildAboutSection() {
    const sec = document.createElement("section");
    sec.className = "set-section";
    sec.id = "setAbout";
    const h = document.createElement("h3");
    h.className = "set-h";
    h.textContent = "About";
    const p = document.createElement("p");
    p.className = "set-about";
    const link = document.createElement("a");
    link.href = "https://localaicat.com";
    link.textContent = "Local AI Cat";
    link.onclick = (e) => {
      e.preventDefault();
      if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
        window.pywebview.api.open_external(link.href);
      } else {
        window.open(link.href, "_blank", "noopener");
      }
    };
    p.append(
      "confnote also runs inside the ",
      link,
      " (your local AI on your Mac). This standalone app stays for people who want it separate or want to hack on it.",
    );
    sec.append(h, p);
    return sec;
  }

  // Notes-folder (vault) switcher. The chosen vault + recents persist
  // app-globally server-side; switching relaunches the app onto the new vault.
  function buildVaultSection() {
    const sec = document.createElement("section");
    sec.className = "set-section";
    const h = document.createElement("h3");
    h.className = "set-h";
    h.textContent = "Notes folder";
    const blurb = document.createElement("p");
    blurb.className = "set-blurb";
    blurb.textContent =
      "Where confnote reads and writes conferences. Switch folders to keep " +
      "separate vaults (work / personal / testing). Switching reloads the app.";
    sec.append(h, blurb);

    const cur = document.createElement("div");
    cur.className = "set-vault-current";
    cur.textContent = "…";
    sec.append(cur);

    const note = document.createElement("p");
    note.className = "set-hint";
    note.hidden = true;
    sec.append(note);

    const recentsWrap = document.createElement("div");
    recentsWrap.className = "set-vault-recents";
    sec.append(recentsWrap);

    const actions = document.createElement("div");
    actions.className = "set-vault-actions";
    const chooseBtn = document.createElement("button");
    chooseBtn.type = "button";
    chooseBtn.className = "set-btn";
    chooseBtn.textContent = "Choose folder…";
    // Browser mode can't open a native dialog, so offer a path field instead.
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "set-input set-vault-path";
    pathInput.placeholder = "/full/path/to/a/folder";
    pathInput.spellcheck = false;
    pathInput.autocomplete = "off";
    actions.append(chooseBtn);
    if (!isDesktop()) actions.append(pathInput);
    sec.append(actions);

    const msg = document.createElement("span");
    msg.className = "set-test-msg";
    sec.append(msg);

    async function switchVault(path) {
      if (!path) return;
      msg.className = "set-test-msg";
      msg.textContent = "switching…";
      try {
        const r = await fetch("/api/vault/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const d = await r.json();
        if (!d.ok) {
          msg.className = "set-test-msg err";
          msg.textContent = d.error || "Switch failed.";
          return;
        }
        if (d.relaunching) {
          msg.className = "set-test-msg ok";
          msg.textContent = "Switching vault — reloading…";
          // Server re-execs / relaunches; reload covers the browser tab.
          setTimeout(() => location.reload(), 1800);
        } else if (d.env_pinned) {
          msg.className = "set-test-msg";
          msg.textContent =
            "Saved — but CONF_NOTES_DIR is pinning the vault, so it won't " +
            "switch until that override is removed.";
        } else {
          msg.className = "set-test-msg ok";
          msg.textContent = "Already on that folder.";
        }
      } catch (e) {
        msg.className = "set-test-msg err";
        msg.textContent = "Switch failed: " + (e && e.message ? e.message : e);
      }
    }

    chooseBtn.onclick = async () => {
      if (isDesktop() && window.pywebview.api.pick_folder) {
        const picked = await window.pywebview.api.pick_folder();
        if (picked) switchVault(picked);
      } else {
        switchVault(pathInput.value.trim());
      }
    };

    async function load() {
      let d;
      try {
        d = await (await fetch("/api/vault")).json();
      } catch (_e) {
        cur.textContent = "(could not load)";
        return;
      }
      cur.textContent = d.current || "(unknown)";
      cur.title = d.current || "";
      if (d.env_pinned) {
        note.hidden = false;
        note.textContent =
          "Pinned by CONF_NOTES_DIR — your selection is saved but won't take " +
          "effect until that override is removed.";
      }
      recentsWrap.replaceChildren();
      for (const p of d.recents || []) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "set-vault-recent";
        b.textContent = p;
        b.title = "Switch to " + p;
        b.onclick = () => switchVault(p);
        recentsWrap.append(b);
      }
    }
    load();

    return sec;
  }

  async function openSettings(opts) {
    if (document.getElementById(ID)) return; // already open

    const overlay = document.createElement("div");
    overlay.id = ID;
    overlay.className = "modal-ov";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    escHandler = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", escHandler);

    const box = document.createElement("div");
    box.className = "modal-box";
    overlay.append(box);

    // head
    const head = document.createElement("div");
    head.className = "modal-head";
    const title = document.createElement("span");
    title.className = "modal-title";
    title.textContent = "Settings";
    const xBtn = document.createElement("button");
    xBtn.className = "modal-x";
    xBtn.type = "button";
    xBtn.title = "Close";
    xBtn.textContent = "✕";
    xBtn.onclick = close;
    head.append(title, xBtn);

    const body = document.createElement("div");
    body.className = "modal-body";

    // ---- transcription section ------------------------------------
    const sec = document.createElement("section");
    sec.className = "set-section";
    const h = document.createElement("h3");
    h.className = "set-h";
    h.textContent = "Transcription";
    const blurb = document.createElement("p");
    blurb.className = "set-blurb";
    blurb.textContent =
      "Local keeps audio on this machine via Local AI Cat. Remote sends audio to OpenAI with your API key.";
    sec.append(h, blurb);

    // provider radios
    const provWrap = document.createElement("div");
    provWrap.className = "set-radios";
    const mkRadio = (val, label) => {
      const l = document.createElement("label");
      l.className = "set-radio";
      const r = document.createElement("input");
      r.type = "radio";
      r.name = "transc-provider";
      r.value = val;
      const s = document.createElement("span");
      s.textContent = label;
      l.append(r, s);
      return { l, r };
    };
    const local = mkRadio("local", "Local (AI Cat)");
    const remote = mkRadio("openai", "Remote (OpenAI)");
    // "?" help link next to the local option → Local AI Cat info.
    const help = document.createElement("a");
    help.className = "set-help-link";
    help.textContent = "?";
    help.href = "https://localaicat.com";
    help.title = "About Local AI Cat";
    help.onclick = (e) => {
      e.preventDefault();
      const url = "https://localaicat.com";
      if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external) {
        window.pywebview.api.open_external(url);
      } else {
        window.open(url, "_blank", "noopener");
      }
    };
    local.l.append(help);
    provWrap.append(local.l, remote.l);

    // base url + model + key inputs
    const baseInput = document.createElement("input");
    baseInput.type = "text";
    baseInput.className = "set-input";
    baseInput.autocomplete = "off";
    baseInput.spellcheck = false;

    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.className = "set-input";
    modelInput.autocomplete = "off";
    modelInput.spellcheck = false;

    const keyInput = document.createElement("input");
    keyInput.type = "password";
    keyInput.className = "set-input";
    keyInput.autocomplete = "off";
    keyInput.placeholder = "No API key needed";

    const baseRow = row("Base URL", baseInput);
    const modelRow = row("Model", modelInput);
    const keyRow = row("API key", keyInput, "Stored on this machine, never shown again.");

    // "Save in Local AI Cat history" — only meaningful for the local
    // provider. Default off: confnote keeps the audio + transcript in the
    // conference folder, so Cat history would just duplicate them.
    const catSaveInput = document.createElement("input");
    catSaveInput.type = "checkbox";
    const catSaveRow = document.createElement("label");
    catSaveRow.className = "set-check-row";
    const catSaveLabel = document.createElement("span");
    catSaveLabel.textContent = "Save in Local AI Cat history";
    catSaveRow.append(catSaveInput, catSaveLabel);

    // Auto-record: one Cat recording over today's starred sessions (first
    // start − 2 min to last end + 3 min), split per session after it stops.
    const autoRecInput = document.createElement("input");
    autoRecInput.type = "checkbox";
    autoRecInput.id = "setAutoRecord";
    const autoRecRow = document.createElement("label");
    autoRecRow.className = "set-check-row";
    const autoRecLabel = document.createElement("span");
    autoRecLabel.textContent = "Auto-record starred sessions as one block, then split";
    autoRecRow.append(autoRecInput, autoRecLabel);

    // Hosted only: transcription is locked there; this says why (on-device in the Mac app).
    const onDevice = document.createElement("div");
    onDevice.className = "set-hint";
    onDevice.id = "setOnDevice";
    onDevice.hidden = true;

    sec.append(provWrap, onDevice, baseRow, modelRow, keyRow, catSaveRow, autoRecRow);

    // test connection
    const testWrap = document.createElement("div");
    testWrap.className = "set-test";
    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "set-btn";
    testBtn.textContent = "Test connection";
    const testMsg = document.createElement("span");
    testMsg.className = "set-test-msg";
    testWrap.append(testBtn, testMsg);
    sec.append(testWrap);

    body.append(sec);

    // ---- notes folder (vault) section -----------------------------
    body.append(buildVaultSection());

    // ---- keyboard shortcuts ---------------------------------------
    body.append(buildShortcutsSection());

    // ---- about ----------------------------------------------------
    body.append(buildAboutSection());

    // ---- footer ---------------------------------------------------
    const foot = document.createElement("div");
    foot.className = "set-foot";

    const openBrowserBtn = document.createElement("button");
    openBrowserBtn.type = "button";
    openBrowserBtn.className = "set-btn set-btn-ghost";
    openBrowserBtn.textContent = "↗ Open in browser";
    openBrowserBtn.hidden = !isDesktop();
    openBrowserBtn.onclick = () => {
      try {
        window.pywebview.api.open_browser();
      } catch (_e) {}
    };

    const spacer = document.createElement("span");
    spacer.className = "set-foot-spacer";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "set-btn set-btn-primary";
    saveBtn.textContent = "Save";

    foot.append(openBrowserBtn, spacer, saveBtn);
    body.append(foot);

    box.append(head, body);
    document.body.append(overlay);

    // `?` opens Settings straight to the shortcuts reference.
    if (opts && opts.focus === "shortcuts") {
      document.getElementById("setShortcuts")?.scrollIntoView({ block: "start" });
    }

    // ---- state + behaviour ----------------------------------------
    // Hold both base URLs in memory; the single visible field edits the
    // active provider's URL.
    const state = {
      provider: "local",
      local_base_url: "",
      openai_base_url: "",
      model: "",
      has_api_key: false,
      save_in_cat_history: false,
      auto_record_block: false,
    };
    let savedSnapshot = null;
    let saveResetTimer = null;
    // Hosted (`transcription.browser`): transcription is locked there
    // (browser-transcribe.js), so the section only says why. Nothing to save.
    const browserTx = window.confnote && window.confnote.browserTranscription;
    let browserMode = false;

    function formSnapshot() {
      return {
        provider: state.provider,
        local_base_url: state.local_base_url,
        openai_base_url: state.openai_base_url,
        model: modelInput.value.trim(),
        save_in_cat_history: catSaveInput.checked,
        auto_record_block: autoRecInput.checked,
      };
    }

    function hasUnsavedChanges() {
      if (!savedSnapshot) return false;
      if (state.provider === "openai" && keyInput.value.trim()) return true;
      return JSON.stringify(formSnapshot()) !== JSON.stringify(savedSnapshot);
    }

    function updateSaveButton() {
      if (saveBtn.disabled) return;
      if (saveResetTimer) return;
      saveBtn.textContent = hasUnsavedChanges() ? "Save" : "Done";
      saveBtn.classList.toggle("is-done", !hasUnsavedChanges());
    }

    function syncBaseField() {
      baseInput.value = state.provider === "openai" ? state.openai_base_url : state.local_base_url;
      keyInput.disabled = state.provider !== "openai";
      keyRow.classList.toggle("is-disabled", state.provider !== "openai");
      if (state.provider === "openai") {
        keyInput.placeholder = state.has_api_key
          ? "API key saved — leave blank to keep it"
          : "Paste OpenAI API key";
      } else {
        keyInput.value = "";
        keyInput.placeholder = "No API key needed for Local AI Cat";
      }
      const hint = keyRow.querySelector(".set-hint");
      if (hint) {
        if (state.provider === "openai") {
          hint.textContent = state.has_api_key
            ? "OpenAI key is stored in macOS Keychain and never shown again."
            : "Required only when Remote (OpenAI) is selected.";
        } else {
          hint.textContent = "Local AI Cat runs on this Mac; no OpenAI key is used.";
        }
      }
      catSaveRow.style.display = state.provider === "local" ? "" : "none";
      autoRecRow.style.display = state.provider === "local" ? "" : "none";
      if (browserMode) syncBrowserFields();
      updateSaveButton();
    }

    // Hosted: transcription is locked (no provider, model, key or test), and the
    // note says it runs on device in the Mac app with Local AI Cat.
    function syncBrowserFields() {
      blurb.textContent = browserTx.LOCKED;
      onDevice.hidden = false;
      if (!onDevice.childNodes.length) onDevice.append(...browserTx.infoNodes());
      // .set-radios is display:flex, which beats `hidden`, so hide each row by style
      for (const el of [provWrap, baseRow, modelRow, keyRow, catSaveRow, autoRecRow, testWrap]) {
        el.style.display = "none";
      }
      keyInput.disabled = true;
      keyInput.value = "";
    }

    baseInput.addEventListener("input", () => {
      if (state.provider === "openai") state.openai_base_url = baseInput.value;
      else state.local_base_url = baseInput.value;
      updateSaveButton();
    });
    modelInput.addEventListener("input", updateSaveButton);
    keyInput.addEventListener("input", updateSaveButton);
    catSaveInput.addEventListener("change", updateSaveButton);
    autoRecInput.addEventListener("change", updateSaveButton);
    local.r.addEventListener("change", () => {
      if (local.r.checked) {
        state.provider = "local";
        syncBaseField();
      }
    });
    remote.r.addEventListener("change", () => {
      if (remote.r.checked) {
        state.provider = "openai";
        syncBaseField();
      }
    });

    function applyData(d) {
      const t = (d && d.transcription) || {};
      state.provider = t.provider === "openai" ? "openai" : "local";
      state.local_base_url = t.local_base_url || "";
      state.openai_base_url = t.openai_base_url || "";
      state.model = t.model || "";
      state.has_api_key = !!t.has_api_key;
      state.save_in_cat_history = !!t.save_in_cat_history;
      catSaveInput.checked = state.save_in_cat_history;
      state.auto_record_block = !!t.auto_record_block;
      autoRecInput.checked = state.auto_record_block;
      (state.provider === "openai" ? remote.r : local.r).checked = true;
      modelInput.value = state.model;
      savedSnapshot = formSnapshot();
      syncBaseField();
    }

    function collectPatch() {
      const tr = {
        provider: state.provider,
        local_base_url: state.local_base_url,
        openai_base_url: state.openai_base_url,
        model: modelInput.value.trim(),
        save_in_cat_history: catSaveInput.checked,
        auto_record_block: autoRecInput.checked,
      };
      // only send the key when the user actually typed one
      if (state.provider === "openai" && keyInput.value.trim()) tr.api_key = keyInput.value.trim();
      return { transcription: tr };
    }

    async function save() {
      if (browserMode || !hasUnsavedChanges()) {
        close();
        return true;
      }
      if (saveResetTimer) {
        clearTimeout(saveResetTimer);
        saveResetTimer = null;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(collectPatch()),
        });
        const d = await r.json();
        applyData(d);
        keyInput.value = ""; // clear the typed key from the DOM
        savedSnapshot = formSnapshot();
        if (window.confnote && window.confnote.showToast) {
          window.confnote.showToast({ title: "Settings saved", kind: "ok" });
        }
        // Confirm on the button itself, then settle to "Done".
        saveBtn.textContent = "✓ Saved";
        saveResetTimer = setTimeout(() => {
          saveResetTimer = null;
          updateSaveButton();
        }, 1800);
        return true;
      } catch (e) {
        testMsg.textContent = "Save failed: " + (e && e.message ? e.message : e);
        testMsg.className = "set-test-msg err";
        saveBtn.textContent = "Save";
        return false;
      } finally {
        saveBtn.disabled = false;
      }
    }

    saveBtn.onclick = save;

    // Reflect the default (local) provider synchronously on open so the key
    // field is disabled with the right copy before the async settings fetch
    // resolves — otherwise it briefly shows as an enabled, editable field.
    syncBaseField();

    testBtn.onclick = async () => {
      // Test probes the SAVED config, so save dirty form state first.
      testMsg.textContent = hasUnsavedChanges() ? "saving…" : "";
      testMsg.className = "set-test-msg";
      if (hasUnsavedChanges() && !(await save())) return;
      testBtn.disabled = true;
      testMsg.textContent = "testing…";
      try {
        const r = await fetch("/api/settings/test", { method: "POST" });
        const d = await r.json();
        testMsg.textContent = (d.ok ? "✓ connected" : "✗ ") + (d.ok ? "" : d.detail || "failed");
        testMsg.className = "set-test-msg " + (d.ok ? "ok" : "err");
      } catch (e) {
        testMsg.textContent = "✗ " + (e && e.message ? e.message : e);
        testMsg.className = "set-test-msg err";
      } finally {
        testBtn.disabled = false;
      }
    };

    // load current settings
    try {
      const r = await fetch("/api/settings");
      const d = await r.json();
      browserMode = Boolean(d && d.transcription && d.transcription.browser && browserTx);
      applyData(browserMode ? {} : d);
    } catch (_e) {
      applyData({});
    }
  }

  window.confnote = window.confnote || {};
  window.confnote.openSettings = openSettings;

  // wire the ⚙ topbar button (works in browser + desktop)
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("settingsBtn");
    if (btn) btn.onclick = openSettings;
  });
})();
