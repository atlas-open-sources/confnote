import { describe, expect, it } from "vitest";
import { withFrontmatterFlag } from "../lib/sections.js";
import { addConference, notePayload, picksPayload, putNote, putPicks } from "../lib/service.js";

// The same cases as tests/test_picks.py: both hosts write a pick into the note's frontmatter and nowhere else.
const NOTE = "---\nsession: Opening\n---\n\n# Opening\n\n## Human notes\n\nattending: no\n";

describe("picks in the notebook", () => {
  it("sets and clears the frontmatter flag without touching the body", () => {
    const on = withFrontmatterFlag(NOTE, "attending", true);
    expect(on).toBe("---\nsession: Opening\nattending: true\n---\n\n# Opening\n\n## Human notes\n\nattending: no\n");
    expect(withFrontmatterFlag(on, "attending", false)).toBe(NOTE);
    expect(withFrontmatterFlag("# Loose note\n", "attending", true).startsWith("---\nattending: true\n---\n")).toBe(true);
    expect(withFrontmatterFlag("# Loose note\n", "attending", false)).toBe("# Loose note\n");
    // A frontmatter block that never closes is refused, never cut into.
    expect(() => withFrontmatterFlag("---\nsession: x\n\nattending: keep this\n", "attending", true)).toThrow(/closing ---/);
  });

  it("round-trips picks and keeps them across a note save", async () => {
    const ctx = { workspace: `picks-${Date.now()}-${Math.random().toString(16).slice(2)}` };
    const imported = await addConference(ctx, {
      schema_version: "confnote.agenda.v1",
      conference: { name: "Picks Conf", date: "2099-05-03", timezone: "Europe/London" },
      events: [
        { id: "opening", type: "talk", title: "Opening", start: "2099-05-03T09:00:00+00:00", end: "2099-05-03T10:00:00+00:00" },
        { id: "deep-dive", type: "talk", title: "Deep Dive", start: "2099-05-03T09:30:00+00:00", end: "2099-05-03T10:30:00+00:00" },
      ],
      speakers: {},
    });
    if (!("slug" in imported)) throw new Error("agenda did not import");
    const slug = imported.slug;
    expect(await picksPayload(ctx, slug)).toEqual({ slug, notes: [] });
    const picked = await putPicks(ctx, slug, { picks: { "0900-opening.md": true } });
    expect(picked && "notes" in picked && picked.notes).toEqual(["0900-opening.md"]);
    await putNote(ctx, slug, "0900-opening.md", { sections: { "Human notes": "Great opening." } });
    expect((await notePayload(ctx, slug, "0900-opening.md"))?.frontmatter.attending).toBe("true");
    expect((await picksPayload(ctx, slug))?.notes).toEqual(["0900-opening.md"]);
    expect(await putPicks(ctx, slug, { picks: { "0900-opening.md": "yes" } })).toHaveProperty("error");
    expect(await putPicks(ctx, slug, { picks: { "1200-nope.md": true } })).toHaveProperty("error");
    expect(await putPicks(ctx, "2099-01-01-missing", { picks: {} })).toBeNull();
  });
});
