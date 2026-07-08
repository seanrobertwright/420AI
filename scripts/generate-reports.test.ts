import { describe, it, expect } from "vitest";
import { parseArgs, resolveReportTypes, PROJECT_REPORT_TYPES } from "./generate-reports.mjs";

describe("parseArgs", () => {
  it("defaults to all types, all projects", () => {
    expect(parseArgs([])).toEqual({ types: "all", project: "all" });
  });

  it("reads --types and --project values", () => {
    expect(parseArgs(["--types", "project.efficiency", "--project", "abc"])).toEqual({
      types: "project.efficiency",
      project: "abc",
    });
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
