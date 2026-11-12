import { describe, expect, it } from "vitest";
import fixture from "../../contracts/fixtures/sections.json" with { type: "json" };
import { buildNote, extractLinks, mergeLinksIntoSection, parseActions, parseNote } from "../lib/sections.js";

interface MarkdownCase {
  markdown: string;
  frontmatter: Record<string, string>;
  title: string;
  sections: Record<string, string>;
  actions: Array<{ text: string; done: boolean }>;
}

interface LinkCase {
  human_notes: string;
  links_before: string;
  links_after: string;
}

describe("section contracts", () => {
  it("parses the canonical markdown fixture like the Python backend", () => {
    const example = fixture.cases.find((item) => "markdown" in item) as MarkdownCase | undefined;
    if (!example) throw new Error("missing markdown fixture");

    const parsed = parseNote(example.markdown);

    expect(parsed.frontmatter).toEqual(example.frontmatter);
    expect(parsed.title).toBe(example.title);
    expect(parsed.sections).toEqual(example.sections);
    expect(parseActions(parsed.sections.Actions)).toEqual(example.actions);
  });

  it("mirrors inline human-note links like the Python backend", () => {
    const example = fixture.cases.find((item) => "human_notes" in item) as LinkCase | undefined;
    if (!example) throw new Error("missing link fixture");

    expect(extractLinks(example.human_notes)).toEqual([
      "https://tldraw.com",
      "https://stately.ai",
      "ably.com",
    ]);
    expect(mergeLinksIntoSection(example.human_notes, example.links_before)).toBe(
      example.links_after,
    );
  });
});

describe("section isolation", () => {
  it("a section body cannot forge another canonical section", () => {
    // An agent Research write (or an imported description) carrying a canonical heading must not replace Human notes.
    const note = buildNote({}, "Talk", { "Human notes": "mine", Research: "dossier\n\n## Human notes\n\nforged" });
    const parsed = parseNote(note);
    expect(parsed.sections["Human notes"]).toBe("mine");
    expect(parsed.sections.Research).toContain("### Human notes");
    expect(parsed.sections.Research).toContain("forged");
  });
});
