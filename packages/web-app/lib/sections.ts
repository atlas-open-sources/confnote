import type { Frontmatter, ParsedNote } from "./types.js";

export const CANON_SECTIONS = [
  "Human notes",
  "Summary",
  "Research",
  "AI notes",
  "Transcript",
  "Actions",
  "Links",
  "Scratchpad",
  "Private",
] as const;

export const EDITABLE = new Set([
  "Human notes",
  "Transcript",
  "Actions",
  "Links",
  "Scratchpad",
  "Private",
]);

export const PRIVATE_SECTION = "Private";

const ACTION_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const LINK_TLDS =
  "com|org|net|io|ai|dev|co|app|gg|xyz|me|tech|sh|so|to|edu|gov|cloud|page|site|ly|fm|tv|info|app|run|new";
const URL_SCHEME_RE = /https?:\/\/[^\s<>)\]]+/gi;
const MD_LINK_RE = /\]\(\s*([^\)\s]+)\s*\)/g;
const BARE_DOMAIN_RE = new RegExp(
  `(?<![\\w@/.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${LINK_TLDS}))(?:/[^\\s<>)\\]]*)?`,
  "gi",
);
const LINK_TRAIL = ".,;:!?)]}>\"'";
const SEED_MARKERS = [
  "AI-driven — seeded from the agenda",
  "AI-driven - seeded from the agenda",
  "Speaker & company dossier — run tools/research.py",
  "Speaker & company dossier - run tools/research.py",
  "Agent-owned. Live notes and follow-up research land here.",
  "Tasks and follow-ups — `- [ ] task` lines",
  "Tasks and follow-ups - `- [ ] task` lines",
];

export interface ActionItem {
  text: string;
  done: boolean;
}

export function parseNote(text: string): ParsedNote {
  const lines = text.split("\n");
  const frontmatter: Frontmatter = {};
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i].trim() !== "---") {
      const line = lines[i];
      if (line.includes(":")) {
        const idx = line.indexOf(":");
        frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      i += 1;
    }
    i += 1;
  }

  let title = "";
  while (i < lines.length) {
    if (lines[i].startsWith("# ")) {
      title = lines[i].slice(2).trim();
      i += 1;
      break;
    }
    if (lines[i].trim() === "") {
      i += 1;
      continue;
    }
    break;
  }

  const sections: Record<string, string> = {};
  let cur: string | null = null;
  let buf: string[] = [];
  const canon = new Set<string>(CANON_SECTIONS);
  for (const line of lines.slice(i)) {
    if (line.startsWith("## ") && canon.has(line.slice(3).trim())) {
      if (cur !== null) sections[cur] = buf.join("\n").replace(/^\n+|\n+$/g, "");
      cur = line.slice(3).trim();
      buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  if (cur !== null) sections[cur] = buf.join("\n").replace(/^\n+|\n+$/g, "");
  return { frontmatter, title, sections };
}

// A body line that reads as a canonical heading starts a new section on the next parse, so a write to one section
// (an agent's Research, an imported description) could replace another (Human notes). Demote it one level.
function escapeCanonHeadings(body: string): string {
  const canon = new Set<string>(CANON_SECTIONS);
  return body
    .split("\n")
    .map((line) => (line.startsWith("## ") && canon.has(line.slice(3).trim()) ? `#${line}` : line))
    .join("\n");
}

export function buildNote(frontmatter: Frontmatter, title: string, sections: Record<string, string>): string {
  const fmLines = Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  const out = [`---\n${fmLines}\n---\n`, `\n# ${title}\n`];
  for (const name of CANON_SECTIONS) {
    const body = escapeCanonHeadings(sections[name] || "").replace(/\n+$/g, "");
    out.push(body ? `\n## ${name}\n\n${body}\n` : `\n## ${name}\n\n`);
  }
  return out.join("");
}

const FRONTMATTER_FENCE = "---";

/** `text` with `key: true` set (on) or removed (off) in its frontmatter; the body stays byte for byte. */
export function withFrontmatterFlag(text: string, key: string, on: boolean): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return on ? `${FRONTMATTER_FENCE}\n${key}: true\n${FRONTMATTER_FENCE}\n${text}` : text;
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_FENCE);
  // A frontmatter block that never closes: the body would read as frontmatter, so refuse rather than drop a line.
  if (end < 0) throw new Error("The note's frontmatter has no closing ---; fix the note first.");
  const kept = lines.slice(1, end).filter((line) => line.split(":")[0].trim() !== key);
  if (on) kept.push(`${key}: true`);
  return [lines[0], ...kept, ...lines.slice(end)].join("\n");
}

export function completeSections(sections: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CANON_SECTIONS) out[name] = sections[name] || "";
  return out;
}

export function parseActions(text: string): ActionItem[] {
  const items: ActionItem[] = [];
  for (const line of (text || "").split("\n")) {
    const match = ACTION_RE.exec(line);
    if (!match) continue;
    const body = match[2].trim();
    if (body) items.push({ text: body, done: match[1].toLowerCase() === "x" });
  }
  return items;
}

export function extractLinks(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    let value = raw.trim().replace(/^<|>$/g, "");
    while (value && LINK_TRAIL.includes(value[value.length - 1])) {
      value = value.slice(0, -1);
    }
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(value);
  };

  for (const match of text.matchAll(MD_LINK_RE)) add(match[1]);
  for (const match of text.matchAll(URL_SCHEME_RE)) add(match[0]);
  for (const match of text.matchAll(BARE_DOMAIN_RE)) add(match[0]);
  return found;
}

export function mergeLinksIntoSection(humanNotes: string, linksSection: string): string {
  const existing = (linksSection || "").toLowerCase();
  const next = extractLinks(humanNotes)
    .filter((url) => !existing.includes(url.toLowerCase()))
    .map((url) => `- ${url}`);
  if (!next.length) return linksSection;
  const base = (linksSection || "").trimEnd();
  return base ? `${base}\n${next.join("\n")}` : next.join("\n");
}

export function sectionHasRealContent(name: string, body: string): boolean {
  const trimmed = (body || "").trim();
  if (!trimmed) return false;
  if (name === "Actions") return parseActions(trimmed).length > 0;
  for (const line of trimmed.split("\n")) {
    const value = line.trim();
    if (!value || SEED_MARKERS.some((marker) => value.includes(marker))) continue;
    if (name === "Summary" && value.startsWith(">")) continue;
    return true;
  }
  return false;
}

export function noteHasContent(markdown: string): boolean {
  const parsed = parseNote(markdown);
  return CANON_SECTIONS.some(
    (name) => name !== "Links" && sectionHasRealContent(name, parsed.sections[name] || ""),
  );
}
