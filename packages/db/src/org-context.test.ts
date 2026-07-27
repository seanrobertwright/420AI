import { describe, it, expect } from "vitest";
import type { SQL } from "drizzle-orm";
import { APP_ROLE_NAME, ORG_SETTING, withOrg } from "./org-context.js";
import type { Db, Tx } from "./client.js";

/**
 * M15 15.3 — pure unit test for the SQL `withOrg` emits. No DB (the real enforcement lives in
 * `repositories/rls.int.test.ts`, which needs two roles). What this file pins is the SHAPE of
 * the statement, because two specific mis-writings are both plausible and both dangerous:
 *
 *   1. `SET LOCAL app.current_org = ${orgId}` — Postgres REJECTS a bind parameter in a `SET`
 *      (15.0 Finding 4). The "obvious fix" is to interpolate the org id into the SQL string,
 *      which puts an INJECTION VECTOR inside the tenant-isolation primitive itself. An
 *      injected `'; reset all; --` would disable the context for the rest of the transaction.
 *   2. `set_config(..., false)` — session-scoped instead of transaction-scoped, so the context
 *      SURVIVES the connection's return to the pool and the next request inherits the previous
 *      request's org (15.0 Finding 3). That is a cross-tenant read that no test would notice.
 *
 * Neither is a type error, and neither would fail a single-tenant integration test. Hence a
 * unit test that reads the emitted SQL directly. The fake `Db` follows the repo's
 * inject-dependencies-for-determinism discipline (CLAUDE.md "Testing").
 */

/** Capture what `withOrg` executes, without a database. */
function fakeDb(): { db: Db; executed: SQL[]; transactions: number } {
  const executed: SQL[] = [];
  const state = { transactions: 0 };
  const tx = {
    execute: (q: SQL) => {
      executed.push(q);
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Tx;
  const db = {
    transaction: (cb: (t: Tx) => Promise<unknown>) => {
      state.transactions += 1;
      return cb(tx);
    },
  } as unknown as Db;
  return {
    db,
    executed,
    get transactions() {
      return state.transactions;
    },
  };
}

/** The drizzle `SQL` AST: string chunks in `queryChunks`, bound values as Param nodes. */
function chunkText(q: SQL): string {
  const chunks = (q as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((c) => (c && typeof c === "object" && "value" in c ? String(c.value) : ""))
    .join("");
}

const ORG = "3f2b7c14-9d05-4a6e-8b21-6c0f5ad84e77";

describe("withOrg", () => {
  it("sets the org context via set_config with is_local = true", async () => {
    const f = fakeDb();
    await withOrg(f.db, ORG, async () => "result");

    expect(f.executed).toHaveLength(1);
    const text = chunkText(f.executed[0]!);
    expect(text).toContain("set_config");
    expect(text).toContain(`'${ORG_SETTING}'`);
    // is_local = true ⇒ exact SET LOCAL semantics: the context dies with the transaction and
    // can never ride a pooled connection into the next request (15.0 Finding 3).
    expect(text).toContain("true");
    expect(text).not.toContain("false");
  });

  it("NEVER emits `SET LOCAL` (Postgres rejects a bind param there — 15.0 Finding 4)", async () => {
    const f = fakeDb();
    await withOrg(f.db, ORG, async () => undefined);
    expect(chunkText(f.executed[0]!).toUpperCase()).not.toContain("SET LOCAL");
  });

  it("passes the org id as a BOUND PARAMETER, never interpolated into the SQL text", async () => {
    const f = fakeDb();
    await withOrg(f.db, ORG, async () => undefined);
    const q = f.executed[0]!;

    // The literal uuid must NOT appear in the statement's string chunks…
    expect(chunkText(q)).not.toContain(ORG);
    // …it must appear as a bound param instead. This is the injection guard: if a future edit
    // switches to string building, the value moves out of `params` and this fails.
    expect(JSON.stringify((q as unknown as { queryChunks: unknown[] }).queryChunks)).toContain(ORG);
  });

  it("opens exactly ONE transaction and returns the callback's value", async () => {
    const f = fakeDb();
    const out = await withOrg(f.db, ORG, async (tx) => {
      expect(tx).toBeDefined();
      return { ok: 42 };
    });
    expect(out).toEqual({ ok: 42 });
    expect(f.transactions).toBe(1);
  });

  it("propagates a thrown callback (so the transaction — and the context — roll back)", async () => {
    const f = fakeDb();
    await expect(
      withOrg(f.db, ORG, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // The context statement still ran; it is the ROLLBACK that discards it (pinned for real
    // against Postgres in rls.int.test.ts's containment test).
    expect(f.executed).toHaveLength(1);
  });

  it("REFUSES a blank org id without opening a transaction", async () => {
    // '' round-trips through `nullif(current_setting(…), '')` back to NULL, which leaves the
    // three BOOTSTRAP-PERMISSIVE policies fully open for the transaction while the strict ones
    // fail closed — a half-open context that raises nothing. Reject it at the door instead.
    for (const blank of ["", "   "]) {
      const f = fakeDb();
      await expect(withOrg(f.db, blank, async () => undefined)).rejects.toThrow(/non-empty orgId/);
      expect(f.transactions).toBe(0);
    }
  });

  it("sets the context BEFORE the callback runs", async () => {
    const f = fakeDb();
    let executedCountAtCallback = -1;
    await withOrg(f.db, ORG, async () => {
      executedCountAtCallback = f.executed.length;
    });
    // A callback that queried before set_config would read with NO context — 0 rows, silently.
    expect(executedCountAtCallback).toBe(1);
  });
});

describe("shared constants", () => {
  it("spell the role and the setting once, for the migration, the CLI and the tests", () => {
    expect(APP_ROLE_NAME).toBe("420ai_app");
    expect(ORG_SETTING).toBe("app.current_org");
  });
});
