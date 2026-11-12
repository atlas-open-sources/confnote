// Browser notes for the public demo: a visitor's own "Human notes", kept in
// this browser's IndexedDB on top of the read-only public copy. Nothing is sent
// to the server. "Download notes" fetches the conference as a confnote.vault.v1
// bundle (GET /api/export) and merges these edits in, so the Mac app's Import
// writes them to plain .md files. The local app never uses this layer.
(() => {
  const DB_NAME = "confnote-browser-notes";
  const STORE = "notes";
  const SECTIONS = ["Human notes"];
  // Same order as server.py / sections.ts CANON_SECTIONS.
  const CANON = [
    "Human notes",
    "Summary",
    "Research",
    "AI notes",
    "Transcript",
    "Actions",
    "Links",
    "Scratchpad",
    "Private",
  ];
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: "key" });
          store.createIndex("slug", "slug");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function request(mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const get = (slug, file) => request("readonly", (s) => s.get(`${slug}/${file}`));
  const list = (slug) => request("readonly", (s) => s.index("slug").getAll(slug));
  function put(slug, file, sections) {
    const record = { key: `${slug}/${file}`, slug, file, sections, updated: Date.now() };
    return request("readwrite", (s) => s.put(record));
  }

  function parseNote(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    const frontmatter = {};
    let i = 0;
    if (lines[0]?.trim() === "---") {
      i = 1;
      for (; i < lines.length && lines[i].trim() !== "---"; i++) {
        const idx = lines[i].indexOf(":");
        if (idx > 0) frontmatter[lines[i].slice(0, idx).trim()] = lines[i].slice(idx + 1).trim();
      }
      i += 1;
    }
    let title = "";
    for (; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        title = lines[i].slice(2).trim();
        i += 1;
        break;
      }
      if (lines[i].trim() !== "") break;
    }
    const sections = {};
    let cur = null;
    let buf = [];
    for (const line of lines.slice(i)) {
      if (line.startsWith("## ") && CANON.includes(line.slice(3).trim())) {
        if (cur !== null) sections[cur] = buf.join("\n").replace(/^\n+|\n+$/g, "");
        cur = line.slice(3).trim();
        buf = [];
      } else if (cur !== null) buf.push(line);
    }
    if (cur !== null) sections[cur] = buf.join("\n").replace(/^\n+|\n+$/g, "");
    return { frontmatter, title, sections };
  }

  function buildNote(frontmatter, title, sections) {
    const fm = Object.entries(frontmatter)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    let out = `---\n${fm}\n---\n\n# ${title}\n`;
    for (const name of CANON) {
      const body = (sections[name] || "").replace(/^\n+|\n+$/g, "");
      out += body ? `\n## ${name}\n\n${body}\n` : `\n## ${name}\n\n`;
    }
    return out;
  }

  // The public bundle plus this browser's edits, ready to save as <slug>.confnote.
  async function exportBundle(slug, events) {
    const r = await fetch(`/api/export?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) throw new Error(`export failed (${r.status})`);
    const bundle = await r.json();
    for (const rec of await list(slug)) {
      const path = `${slug}/notes/${rec.file}`;
      const base = bundle.files[path];
      const ev = (events || []).find((e) => e.note === rec.file) || {};
      const note = base
        ? parseNote(base)
        : {
            frontmatter: { session: ev.title || rec.file },
            title: ev.title || rec.file,
            sections: {},
          };
      for (const name of SECTIONS) note.sections[name] = rec.sections[name] || "";
      bundle.files[path] = buildNote(note.frontmatter, note.title, note.sections);
    }
    return bundle;
  }

  function download(bundle, filename) {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.confnote = window.confnote || {};
  window.confnote.browserNotes = {
    SECTIONS,
    get,
    list,
    put,
    parseNote,
    buildNote,
    exportBundle,
    download,
  };
})();
