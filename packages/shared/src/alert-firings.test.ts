import { describe, it, expect } from "vitest";
import { alertKey } from "./alert-firings.js";
import type { AlertCode } from "./alerts.js";

/**
 * M16 16.7 — PIN THE ASSUMPTION MIGRATION 0027 PARSES ON.
 *
 * The 0027 dedupe recovers an alert CODE from a stored `alert_key` with
 * `split_part(alert_key, ':', 1)`, in order to decide which open firings are the two
 * deployment-global conditions and must be re-homed to `org_id IS NULL`. That is only valid
 * because `alertKey` is `${code}:${machineId ?? connector ?? "*"}` and NO member of `AlertCode`
 * contains a colon.
 *
 * That assumption lives in SQL, in a file nobody re-reads, and nothing in TypeScript enforces it.
 * Add a tenth alert code spelled `sync:backlog_stalled` and the migration would silently parse it
 * as `sync` — a wrong answer with no error — the next time anyone writes a dedupe against these
 * keys. So it is asserted here, over the WHOLE union rather than over a sample, in the package
 * that owns the union: adding a colon-bearing code fails this test at `npm test`, which is where a
 * SQL-parsing assumption can actually be defended.
 *
 * `@420ai/shared` is pure and clock-free, so this file needs no fixtures and no infra — it always
 * runs (CLAUDE.md's `skipped ≠ passed`).
 */

/**
 * EVERY member of the `AlertCode` union, listed exhaustively.
 *
 * The `satisfies` is what makes the list exhaustive-BY-CONSTRUCTION rather than by the diligence of
 * whoever adds the next code: `Record<AlertCode, true>` fails to typecheck if a code is missing,
 * so `tsc` — not this file's author — is what keeps the list complete. Iterating the keys then
 * gives a test that genuinely covers the union.
 */
const ALL_ALERT_CODES = {
  "collector.offline": true,
  "collector.stale": true,
  "connector.failing": true,
  "sync.backlog_high": true,
  "sync.backlog_growing": true,
  "catalog.update_requires_approval": true,
  "ingest.auth_failure": true,
  "archive.unreachable": true,
  "connector.failure_rate": true,
} satisfies Record<AlertCode, true>;

const CODES = Object.keys(ALL_ALERT_CODES) as AlertCode[];

describe("alertKey (M16 16.7 — the shape migration 0027 parses)", () => {
  it("no AlertCode contains a colon, so split_part(alert_key, ':', 1) recovers the code", () => {
    for (const code of CODES) {
      expect(code, `AlertCode "${code}" contains a colon`).not.toContain(":");
    }
  });

  it("round-trips every code through split_part's first-segment semantics", () => {
    for (const code of CODES) {
      // The three shapes `alertKey` can produce: machine-keyed, connector-keyed, and the `*`
      // fallback the two deployment-global codes always take (neither carries a machine or a
      // connector, which is exactly why they belong to no tenant).
      const keys = [
        alertKey({ code, machineId: "m-1", connector: undefined }),
        alertKey({ code, machineId: undefined, connector: "claude" }),
        alertKey({ code, machineId: undefined, connector: undefined }),
      ];
      for (const key of keys) {
        expect(key.split(":")[0]).toBe(code);
      }
    }
  });

  it("keys the two DEPLOYMENT-scoped codes on '*' — they belong to no machine and no connector", () => {
    // The literal strings migration 0027's `IN (…)` predicate matches on. If either of these
    // changes, the dedupe silently stops re-homing that condition.
    expect(alertKey({ code: "catalog.update_requires_approval" })).toBe(
      "catalog.update_requires_approval:*",
    );
    expect(alertKey({ code: "ingest.auth_failure" })).toBe("ingest.auth_failure:*");
  });
});
