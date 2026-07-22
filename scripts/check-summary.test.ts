import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sliceIdsFromReportName, checkSummaryConsistency } from "./check-summary.mjs";

describe("sliceIdsFromReportName", () => {
  it("maps a plain slice report to one id", () => {
    expect(sliceIdsFromReportName("m14-slice2-catalog-admin-uis.md")).toEqual(["14.2"]);
  });
  it("keeps a lettered sub-slice suffix", () => {
    expect(sliceIdsFromReportName("m12-slice7a-codex-failure-classification.md")).toEqual([
      "12.7a",
    ]);
    expect(sliceIdsFromReportName("m12-slice2b-dashboard-mutations.md")).toEqual(["12.2b"]);
  });
  it("expands a combined range report to every id it covers", () => {
    expect(sliceIdsFromReportName("m14-slice0-1-spike-and-truth.md")).toEqual(["14.0", "14.1"]);
  });
  it("ignores aggregate / non-slice reports", () => {
    expect(sliceIdsFromReportName("m7-m9-reporting-to-live-monitor.md")).toEqual([]);
    expect(sliceIdsFromReportName("uat-fixes-collector-home-service.md")).toEqual([]);
  });
});

describe("checkSummaryConsistency", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-summary-"));
    mkdirSync(join(root, ".agents", "execution-reports"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function report(name: string): void {
    writeFileSync(join(root, ".agents", "execution-reports", name), "");
  }
  function summary(body: string): void {
    writeFileSync(join(root, "SUMMARY.md"), body);
  }

  it("flags a shipped in-progress slice missing its ✅", () => {
    summary("**M14 (Chat)** is **IN PROGRESS**.\n**14.2** catalog admin UIs");
    report("m14-slice2-catalog-admin-uis.md");
    const { problems, enforced } = checkSummaryConsistency(root);
    expect(enforced).toContain("14.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("14.2");
  });

  it("passes when the slice is marked done, either ✅ ordering", () => {
    summary("**M14 (Chat)** is **IN PROGRESS**.\n**14.2** ✅ done · ✅ **14.3** also done");
    report("m14-slice2-catalog-admin-uis.md");
    report("m14-slice3-desktop-polish-trio.md");
    expect(checkSummaryConsistency(root).problems).toEqual([]);
  });

  it("relaxes per-slice enforcement under a DONE milestone", () => {
    // No ✅ anywhere, but the milestone is DONE → milestone-level done subsumes it.
    summary("**M13 (Gap Closure)** is **DONE**.\n13.5 alert delivery");
    report("m13-slice5-alert-delivery.md");
    const { problems, relaxed } = checkSummaryConsistency(root);
    expect(problems).toEqual([]);
    expect(relaxed).toContain("13.5");
  });

  it("enforces in-progress slices while relaxing DONE-milestone ones in the same run", () => {
    summary(
      "**M13 (Gap Closure)** is **DONE**.\n**M14 (Chat)** is **IN PROGRESS**.\n**14.3** ✅ done",
    );
    report("m13-slice5-alert-delivery.md"); // relaxed (M13 DONE)
    report("m14-slice2-catalog-admin-uis.md"); // enforced, missing ✅ → problem
    report("m14-slice3-desktop-polish-trio.md"); // enforced, has ✅ → ok
    const { problems, enforced, relaxed } = checkSummaryConsistency(root);
    expect(relaxed).toEqual(["13.5"]);
    expect(enforced.sort()).toEqual(["14.2", "14.3"]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("14.2");
  });

  it("reports a clear problem when SUMMARY.md is absent", () => {
    report("m14-slice2-catalog-admin-uis.md");
    const { problems } = checkSummaryConsistency(root);
    expect(problems[0]).toMatch(/SUMMARY\.md not found/);
  });
});
