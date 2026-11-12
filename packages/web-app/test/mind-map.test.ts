import { describe, expect, it } from "vitest";
import fixture from "../../contracts/fixtures/mind-map.json" with { type: "json" };
import { type BranchInput, type MapEvent, type MapNotes, buildMindMapSpec, keyPoints } from "../lib/mind-map.js";

// draw_mind_map's spec builder, hosted side. The Mac half is tests/test_mind_map.py; both read
// packages/contracts/fixtures/mind-map.json, so the two hosts hand the drawer the same map.
interface MapCase {
  name: string;
  now: string;
  options: { day?: string; file?: string; branches?: BranchInput[] };
  expected: Record<string, unknown> & { day: string };
}

describe("mind map spec (hosted)", () => {
  it.each(fixture.cases as MapCase[])("$name matches the shared fixture", (entry) => {
    const spec = buildMindMapSpec(fixture.slug, fixture.conference, fixture.events as MapEvent[], fixture.notes as MapNotes, entry.options, new Date(entry.now));
    if ("error" in spec) throw new Error(spec.error);
    const { id, ...rest } = spec;
    expect(id.startsWith(`map-${entry.expected.day}-`)).toBe(true);
    expect(rest).toEqual(entry.expected);
  });

  it("takes key points the way the Mac does", () => {
    const text = "## Heading\n- [x] **Ship** the [demo](https://x.dev). Then rest.\n> quoted line\nhttps://only-a-url.example\n1. numbered point\n### Sources\n- after sources\n";
    expect(keyPoints(text, 5)).toEqual(["Ship the demo", "quoted line", "numbered point"]);
  });

  it("answers an unknown session with an error", () => {
    const spec = buildMindMapSpec(fixture.slug, fixture.conference, fixture.events as MapEvent[], {}, { file: "nope.md" });
    expect(spec).toEqual({ error: "No session nope.md in this conference. Use a note file from get_conference." });
  });
});
