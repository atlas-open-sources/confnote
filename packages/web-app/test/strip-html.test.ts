import { describe, expect, it } from "vitest";
import { MAX_FETCH_BYTES, stripHtml } from "../lib/webResearch.js";

const FETCH_CAP_BYTES = MAX_FETCH_BYTES;

describe("stripHtml", () => {
  it("drops script and style blocks and tags, and reads the title", () => {
    const html = "<TITLE>Day &amp; night</TITLE><Style>a{}</Style><p>One</p><script src=x></script>Two <b>three";
    expect(stripHtml(html)).toEqual({ title: "Day &amp; night", text: "Day & night One Two three" });
  });

  it("keeps the text of an unclosed block; the opening tag still goes", () => {
    expect(stripHtml("<p>a <script>never closed")).toEqual({ title: undefined, text: "a never closed" });
  });

  it("drops an unclosed block to the end when the fetch cap cut the page inside it", () => {
    // gitnation.com: 670 KB of HTML, the cap landed inside an inline <style>, and the model got only CSS.
    const html = "<p>Kent C. Dodds</p><style>a{}</style><p>Cory House</p><STYLE>.x{color:red}.y{";
    expect(stripHtml(html, { cut: true })).toEqual({ title: undefined, text: "Kent C. Dodds Cory House" });
    expect(stripHtml("<p>a <script>var x = 1;", { cut: true }).text).toBe("a");
  });

  it("reads up to 1 MB of a page", () => {
    expect(MAX_FETCH_BYTES).toBe(1_000_000);
  });

  // 160 KB of "<" took about 17 s with the old lazy regexes; the cap is now 1 MB.
  it.each(["<script", "<style", "<title", "<"])("stays linear on a page full of unclosed %s", (unit) => {
    const html = unit.repeat(Math.floor(FETCH_CAP_BYTES / unit.length));
    const start = performance.now();
    stripHtml(html);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
