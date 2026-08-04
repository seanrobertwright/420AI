import { describe, it, expect } from "vitest";
import { parseArgs, resolveReportTypes, PROJECT_REPORT_TYPES } from "./generate-reports.mjs";

describe("parseArgs", () => {
  it("defaults to all types, all projects, audit off", () => {
    expect(parseArgs([])).toEqual({
      types: "all",
      project: "all",
      audit: false,
      windowDays: undefined,
      sampleSize: undefined,
    });
  });

  it("reads --types and --project values", () => {
    expect(parseArgs(["--types", "project.efficiency", "--project", "abc"])).toMatchObject({
      types: "project.efficiency",
      project: "abc",
      audit: false,
    });
  });

  it("reads --audit as a boolean mode with optional window/sample overrides", () => {
    expect(parseArgs(["--audit"])).toMatchObject({ audit: true });
    expect(parseArgs(["--audit", "--window-days", "30", "--sample-size", "5"])).toMatchObject({
      audit: true,
      windowDays: 30,
      sampleSize: 5,
    });
  });

  it("rejects a non-integer or non-positive window/sample value", () => {
    expect(() => parseArgs(["--audit", "--window-days", "x"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--audit", "--sample-size", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--audit", "--window-days"])).toThrow(/positive integer/);
  });

  it("keeps the audit OUT of PROJECT_REPORT_TYPES — it is org-scoped, not a project type", () => {
    // Putting it in that list would make `--types all` POST one org-wide audit PER PROJECT.
    expect(PROJECT_REPORT_TYPES).not.toContain("org.data_quality_audit");
    expect(() => resolveReportTypes("org.data_quality_audit")).toThrow(/unknown report type/);
  });

  it("throws on an unknown flag", () => {
    expect(() => parseArgs(["--wat"])).toThrow(/unknown argument: --wat/);
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseArgs(["--types"])).toThrow(/--types requires a value/);
  });
});

describe("resolveReportTypes", () => {
  it("expands 'all' to the six project types", () => {
    expect(resolveReportTypes("all")).toEqual(PROJECT_REPORT_TYPES);
  });

  it("parses and validates a csv subset", () => {
    expect(resolveReportTypes("project.efficiency, project.cost_over_time")).toEqual([
      "project.efficiency",
      "project.cost_over_time",
    ]);
  });

  it("rejects an unknown report type", () => {
    expect(() => resolveReportTypes("project.bogus")).toThrow(/unknown report type/);
  });

  it("rejects an empty --types", () => {
    expect(() => resolveReportTypes(" , ")).toThrow(/empty/);
  });
});
