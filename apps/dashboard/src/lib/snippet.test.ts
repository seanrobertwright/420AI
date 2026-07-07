import { describe, it, expect } from "vitest";
import { splitSnippet } from "./snippet.js";

describe("splitSnippet", () => {
  it("returns one plain segment when there are no markers", () => {
    expect(splitSnippet("no highlights here")).toEqual([
      { text: "no highlights here", bold: false },
    ]);
  });

  it("splits a single highlighted term", () => {
    expect(splitSnippet("the <b>spend</b> rose")).toEqual([
      { text: "the ", bold: false },
      { text: "spend", bold: true },
      { text: " rose", bold: false },
    ]);
  });

  it("splits multiple fragments (MaxFragments=2 emits several pairs)", () => {
    expect(splitSnippet("<b>anthropic</b> spend … <b>anthropic</b> usage")).toEqual([
      { text: "anthropic", bold: true },
      { text: " spend … ", bold: false },
      { text: "anthropic", bold: true },
      { text: " usage", bold: false },
    ]);
  });

  it("handles markers at the very start and end", () => {
    expect(splitSnippet("<b>alpha</b> middle <b>omega</b>")).toEqual([
      { text: "alpha", bold: true },
      { text: " middle ", bold: false },
      { text: "omega", bold: true },
    ]);
  });

  // The structurally-significant-char-inside-a-value case: body text that CONTAINS
  // marker-looking characters which are NOT a complete pair must stay literal text.
  it("keeps unpaired markers as literal text (never dropped, never bolded)", () => {
    expect(splitSnippet("a lone </b> closer and <b> opener")).toEqual([
      { text: "a lone </b> closer and <b> opener", bold: false },
    ]);
  });

  it("keeps other HTML-looking text literal (only <b> pairs are markup)", () => {
    expect(splitSnippet('x <script>alert("y")</script> <b>hit</b>')).toEqual([
      { text: 'x <script>alert("y")</script> ', bold: false },
      { text: "hit", bold: true },
    ]);
  });

  it("treats an orphan </b> after a real pair as literal text", () => {
    expect(splitSnippet("<b>hit</b> tail </b> text")).toEqual([
      { text: "hit", bold: true },
      { text: " tail </b> text", bold: false },
    ]);
  });

  it("drops empty pairs and handles adjacent pairs", () => {
    expect(splitSnippet("<b></b><b>a</b><b>b</b>")).toEqual([
      { text: "a", bold: true },
      { text: "b", bold: true },
    ]);
  });

  it("bolds across newlines inside a pair", () => {
    expect(splitSnippet("<b>two\nlines</b>")).toEqual([{ text: "two\nlines", bold: true }]);
  });

  it("returns no segments for an empty snippet", () => {
    expect(splitSnippet("")).toEqual([]);
  });
});
