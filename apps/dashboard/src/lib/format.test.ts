import { describe, expect, it } from "vitest";
import { formatAgo, formatDate, formatTokens, formatUsd } from "./format.js";

describe("formatAgo", () => {
  const now = Date.parse("2026-06-20T12:00:00.000Z");

  it("returns an em dash for null", () => {
    expect(formatAgo(null, now)).toBe("—");
  });

  it("returns an em dash for an unparseable timestamp", () => {
    expect(formatAgo("not-a-date", now)).toBe("—");
  });

  it("clamps a future timestamp to 0s (never negative)", () => {
    expect(formatAgo("2026-06-20T12:00:30.000Z", now)).toBe("0s ago");
  });

  it("renders seconds, minutes, hours, and days", () => {
    expect(formatAgo("2026-06-20T11:59:30.000Z", now)).toBe("30s ago");
    expect(formatAgo("2026-06-20T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatAgo("2026-06-20T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatAgo("2026-06-17T12:00:00.000Z", now)).toBe("3d ago");
  });
});

describe("formatUsd", () => {
  it("formats to four decimal places", () => {
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(1.23456)).toBe("$1.2346");
  });

  it("treats a non-finite value as zero", () => {
    expect(formatUsd(Number.NaN)).toBe("$0.0000");
  });
});

describe("formatTokens", () => {
  it("inserts thousands separators", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1234567)).toBe("1,234,567");
  });

  it("treats a non-finite value as zero", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatDate", () => {
  it("returns an em dash for null or unparseable input", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("nope")).toBe("—");
  });

  it("renders a parseable ISO timestamp", () => {
    expect(formatDate("2026-06-20T12:00:00.000Z")).toContain("2026");
  });
});
