import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../client.js";
import { ensurePersonalOrg } from "./organizations.js";
import { setUserPassword } from "./users.js";
import {
  PasswordResetError,
  consumePasswordReset,
  createPasswordReset,
} from "./password-resets.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
const HASH = "scrypt$c2FsdA$ZGs"; // never verified here — these tests never log in

/**
 * M15 15.5 — the CONCURRENCY proof for password-reset tokens.
 *
 * This file exists because two races in `password-resets.ts` were fixed WITHOUT tests, and an
 * untested concurrency fix is indistinguishable from a comment. Both tests below are written to
 * FAIL against the pre-fix code — verified by reverting each guard in turn:
 *
 *   1. `consumePasswordReset` used to SELECT, check `consumed_at`, then UPDATE unconditionally. Two
 *      overlapping consumers both passed the SELECT (neither sees the other's uncommitted stamp),
 *      the second blocked on the row lock, and then — with no `consumed_at IS NULL` in the UPDATE's
 *      WHERE — proceeded to stamp again and return a userId. BOTH callers then wrote a password from
 *      ONE token, which defeats the entire point of single-use.
 *   2. `createPasswordReset` used to UPDATE-then-INSERT with no lock, so two requests for a user with
 *      no live token both stamped zero rows and both inserted — leaving the two live tokens the
 *      one-live-token rule exists to prevent.
 *
 * Both are the SAME lesson CLAUDE.md now records for `members.ts`: a shared transaction is
 * ATOMICITY, not isolation. The fixes are a row lock and a predicate in the UPDATE's WHERE; these
 * tests observe those mechanisms directly rather than hoping two concurrent calls interleave.
 *
 * Assertions run on the non-owner app handle (what the server connects as); the owner handle does
 * setup only, because TRUNCATE requires table ownership.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.5 password-reset concurrency (two-role)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let userId: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!);
    appRole = createDb(APP_URL!);
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    userId = await setUserPassword(owner.db, "resetme@example.com", HASH);
    await ensurePersonalOrg(owner.db, userId, "resetme@example.com");
  });

  async function liveTokens(): Promise<number> {
    const r = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from password_reset_tokens where consumed_at is null`,
    );
    return r.rows[0]!.n;
  }

  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");
    const bypass = await appRole.db.execute<{ rolbypassrls: boolean }>(
      sql`select rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.rolbypassrls).toBe(false);
  });

  // 1 ── NO DOUBLE-SPEND. Two overlapping consumers of ONE token: exactly one may win.
  it("two overlapping consumers of one token: exactly ONE succeeds", async () => {
    const { token } = await createPasswordReset(appRole.db, userId);

    let releaseTx1: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    // tx1 consumes and HOLDS the transaction open, so its stamp is uncommitted and its row lock held.
    const tx1 = appRole.db.transaction(async (tx) => {
      const r = await consumePasswordReset(tx, token);
      await gate;
      return r;
    });

    await new Promise((r) => setTimeout(r, 200));

    // tx2 passes the SELECT (tx1's stamp is invisible to it) and then blocks on the row lock.
    let tx2Settled = false;
    const tx2 = appRole.db
      .transaction((tx) => consumePasswordReset(tx, token))
      .then(
        () => {
          tx2Settled = true;
          return "resolved" as const;
        },
        (e: unknown) => {
          tx2Settled = true;
          return e instanceof PasswordResetError ? ("rejected" as const) : ("other" as const);
        },
      );

    // Release tx1 even if the assertion fails, or the held transaction keeps its pooled connection
    // and every later test in this file times out — one real failure wearing several fake ones.
    try {
      await new Promise((r) => setTimeout(r, 400));
      expect(tx2Settled, "tx2 must be BLOCKED on tx1's row lock").toBe(false);
    } finally {
      releaseTx1!();
      await tx1.catch(() => {});
    }

    // tx2 wakes, its UPDATE re-evaluates `consumed_at IS NULL` against tx1's committed stamp, matches
    // ZERO rows, and refuses. Without that predicate it would have stamped again and returned a
    // userId — two password writes from one token.
    expect(await tx2).toBe("rejected");
    expect(await liveTokens()).toBe(0);
  });

  it("a sequential second consume is refused too (the ordinary single-use path)", async () => {
    const { token } = await createPasswordReset(appRole.db, userId);
    expect((await appRole.db.transaction((tx) => consumePasswordReset(tx, token))).userId).toBe(
      userId,
    );
    await expect(
      appRole.db.transaction((tx) => consumePasswordReset(tx, token)),
    ).rejects.toMatchObject({ name: "PasswordResetError", reason: "consumed" });
  });

  // 2 ── ONE LIVE TOKEN, even when two mints overlap.
  it("two overlapping mints leave exactly ONE live token", async () => {
    let releaseOuter: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseOuter = resolve;
    });

    // The outer transaction takes the user-row lock via createPasswordReset's own FOR UPDATE
    // (passing a Tx makes its internal transaction a SAVEPOINT, so the lock is held by THIS one).
    const outer = appRole.db.transaction(async (tx) => {
      await createPasswordReset(tx, userId);
      await gate;
    });

    await new Promise((r) => setTimeout(r, 200));

    let secondSettled = false;
    const second = createPasswordReset(appRole.db, userId).finally(() => {
      secondSettled = true;
    });

    try {
      await new Promise((r) => setTimeout(r, 400));
      // Blocked on the user-row lock. Without FOR UPDATE this mint would already have inserted a
      // second live token alongside the first.
      expect(secondSettled, "the second mint must BLOCK on the user-row lock").toBe(false);
    } finally {
      releaseOuter!();
      await outer.catch(() => {});
    }

    await second;
    // The second mint consumed the token the first had just created, then inserted its own.
    expect(await liveTokens()).toBe(1);
  });
});
