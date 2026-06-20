import { describe, it, expect } from "vitest";
import { toCsv, toJsonl } from "./serialize.js";

describe("toCsv — RFC 4180 quoting", () => {
  it("emits the header in `columns` order, then one row per record", () => {
    const csv = toCsv([{ a: "1", b: "2" }], ["a", "b"]);
    expect(csv).toBe("a,b\r\n1,2\r\n");
  });

  it("quotes a field containing a comma", () => {
    const csv = toCsv([{ v: "a,b" }], ["v"]);
    expect(csv).toBe('v\r\n"a,b"\r\n');
  });

  it("quotes a field containing a double-quote and doubles the inner quote", () => {
    const csv = toCsv([{ v: 'he said "hi"' }], ["v"]);
    expect(csv).toBe('v\r\n"he said ""hi"""\r\n');
  });

  it("quotes a field containing a newline", () => {
    const csv = toCsv([{ v: "line1\nline2" }], ["v"]);
    expect(csv).toBe('v\r\n"line1\nline2"\r\n');
  });

  it("renders null/undefined as an empty field and numbers/bools unquoted", () => {
    const csv = toCsv([{ a: null, b: undefined, n: 42, t: true }], ["a", "b", "n", "t"]);
    expect(csv).toBe("a,b,n,t\r\n,,42,true\r\n");
  });

  it("renders an object value as quoted compact JSON", () => {
    const csv = toCsv([{ o: { x: 1, y: "a,b" } }], ["o"]);
    // JSON has a comma → quoted; inner quotes doubled.
    expect(csv).toBe('o\r\n"{""x"":1,""y"":""a,b""}"\r\n');
  });

  it("omits a record key not in `columns`; a column absent from a row → empty", () => {
    const csv = toCsv([{ a: "1", extra: "drop-me" }], ["a", "missing"]);
    expect(csv).toBe("a,missing\r\n1,\r\n");
    expect(csv).not.toContain("drop-me");
  });

  it("emits a header-only document for an empty record list", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b\r\n");
  });
});

describe("toJsonl", () => {
  it("emits one JSON.parse-able object per line with a trailing newline", () => {
    const out = toJsonl([{ a: 1 }, { b: 2 }]);
    expect(out).toBe('{"a":1}\n{"b":2}\n');
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns an empty string for an empty array", () => {
    expect(toJsonl([])).toBe("");
  });

  it("does not pretty-print (one physical line per row)", () => {
    const out = toJsonl([{ a: { nested: true } }]);
    expect(out).toBe('{"a":{"nested":true}}\n');
    expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });
});
