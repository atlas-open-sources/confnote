import { describe, expect, it } from "vitest";
import { stripHtml } from "../lib/webResearch.js";

const FETCH_CAP_BYTES = 160_000;

describe("stripHtml", () => {
  it("drops script and style blocks and tags, and reads the title", () => {
    const html = "<TITLE>Day &amp; night</TITLE><Style>a{}</Style><p>One</p><script src=x></script>Two <b>three";
    expect(stripHtml(html)).toEqual({ title: "Day &amp; night", text: "Day & night One Two three" });
  });

  it("keeps the text of an unclosed block; the opening tag still goes", () => {
    expect(stripHtml("<p>a <script>never closed")).toEqual({ title: undefined, text: "a never closed" });
  });

  // 160 KB of "<" took about 17 s with the old lazy regexes.
  it.each(["<script", "<style", "<title", "<"])("stays linear on a page full of unclosed %s", (unit) => {
    const html = unit.repeat(Math.floor(FETCH_CAP_BYTES / unit.length));
    const start = performance.now();
    stripHtml(html);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
