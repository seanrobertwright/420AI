import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../client.js";
import { API_KEY_PREFIX, hashToken } from "../tokens.js";
import { ensurePersonalOrg } from "./organizations.js";
import { setUserPassword } from "./users.js";
import {
  countLiveApiKeys,
  createApiKey,
  findLiveApiKey,
  mintApiKey,
  isApiKeyLive,
  listApiKeys,
  revokeAllApiKeys,
  revokeApiKey,
  touchApiKeyLastUsed,
} from "./api-keys.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;
const HASH = "scrypt$c2FsdA$ZGs"; // never verified here — these tests never log in

/**
 * M15 15.9 — the REPOSITORY-level proof. TWO ROLES, and the split with
 * `apps/ingest/src/api-keys.int.test.ts` is deliberate (the 15.8 precedent):
 *
 *   - the HTTP suite validates the PRIMARY defence (route gates, the ceiling, the floor, re-auth,
 *     the end-to-end flows);
 *   - THIS file validates the STORAGE AND REVOCATION MECHANISMS, and above all proves that the app
 *     role can hash-look-up a key WITH NO ORG CONTEXT SET — which is the entire premise of D-15.9-1
 *     and the one thing an owner-connected suite could never establish.
 *
 * Two roles because `bypassed ≠ enforced` is a habit, not a case-by-case judgement: the owner
 * handle does setup only (TRUNCATE requires ownership) and every assertion runs on the non-owner
 * handle the server actually connects as. Here it also proves migration 0021's claim that no
 * `GRANT` block is needed — if 0015's `ALTER DEFAULT PRIVILEGES` did not cover this table shape,
 * every test below would fail with a permission error rather than passing quietly.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M15 15.9 API keys repository (two-role)", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let userA: string;
  let userB: string;

  beforeAll(() => {
    owner = createDb(TEST_URL!); // setup + seeding only
    appRole = createDb(APP_URL!); // what the SERVER connects as — the point of this suite
  });

  afterAll(async () => {
    // BOTH pools, or vitest hangs on an open handle.
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    // `api_keys` is not named: it carries an FK to `users`, so the CASCADE clears it.
    await owner.db.execute(
      sql`TRUNCATE invites, password_reset_tokens, project_grants, search_documents, session_git_links, git_commit_files, git_commits, alert_firings, machine_heartbeats, report_artifacts, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    userA = await setUserPassword(owner.db, "a@example.com", HASH);
    userB = await setUserPassword(owner.db, "b@example.com", HASH);
    await ensurePersonalOrg(owner.db, userA, "a@example.com");
    await ensurePersonalOrg(owner.db, userB, "b@example.com");
  });

  // 1 ── ROLE IDENTITY. First, and non-negotiable: without it this whole file is theatre. Point the
  // "app" handle at the owner URL by mistake and every assertion below still passes.
  it("the app handle is a NON-SUPERUSER role with rolbypassrls = false", async () => {
    const su = await appRole.db.execute<{ v: string }>(
      sql`select current_setting('is_superuser') as v`,
    );
    expect(su.rows[0]!.v).toBe("off");
    const bypass = await appRole.db.execute<{ b: boolean }>(
      sql`select rolbypassrls as b from pg_roles where rolname = current_user`,
    );
    expect(bypass.rows[0]!.b).toBe(false);
  });

  // ── the pre-context read, which is the whole premise of the table's classification ──────────

  /**
   * D-15.9-1, asserted rather than assumed. `resolvePrincipal` performs this read at the one moment
   * before any org context exists, so it runs with NO `app.org_id` set. If `api_keys` ever acquires
   * a policy, this test is what fails — and it fails LOUDLY, unlike the production symptom, which
   * would be every API key silently 401ing with no error and no log.
   */
  it("mints and hash-looks-up a key on the APP role with NO org context set", async () => {
    const { key, token } = await createApiKey(appRole.db, userA, { name: "desktop" });
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
    const found = await findLiveApiKey(appRole.db, token);
    expect(found).toEqual({ id: key.id, userId: userA, role: null });
  });

  it("the PLAINTEXT token is stored nowhere — only its sha256", async () => {
    const { token } = await createApiKey(appRole.db, userA, { name: "desktop" });
    // The hash is what is stored...
    const byHash = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from api_keys where token_hash = ${hashToken(token)}`,
    );
    expect(byHash.rows[0]!.n).toBe(1);
    // ...and the plaintext appears in NO text column of the row. Cast the whole row to text and
    // search it, so a future column that accidentally captured the token would be caught too — a
    // per-column check would only ever cover the columns someone remembered to list.
    const anywhere = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from api_keys where api_keys::text like ${"%" + token + "%"}`,
    );
    expect(anywhere.rows[0]!.n).toBe(0);
  });

  it("an unknown token resolves to undefined", async () => {
    await createApiKey(appRole.db, userA, { name: "desktop" });
    expect(await findLiveApiKey(appRole.db, `${API_KEY_PREFIX}not-a-real-token`)).toBeUndefined();
  });

  // ── liveness: the three collapsed rejection reasons ─────────────────────────────────────────

  it("a REVOKED key is invisible to the lookup", async () => {
    const { key, token } = await createApiKey(appRole.db, userA, { name: "desktop" });
    expect(await revokeApiKey(appRole.db, userA, key.id)).toBe(true);
    expect(await findLiveApiKey(appRole.db, token)).toBeUndefined();
    expect(await isApiKeyLive(appRole.db, key.id)).toBe(false);
  });

  it("an EXPIRED key is invisible to the lookup", async () => {
    const { key, token } = await createApiKey(appRole.db, userA, {
      name: "expired",
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await findLiveApiKey(appRole.db, token)).toBeUndefined();
    expect(await isApiKeyLive(appRole.db, key.id)).toBe(false);
  });

  /**
   * THE REGRESSION THIS SLICE'S PREDICATE EXISTS FOR (D-15.9-8). `expires_at IS NULL` means "never
   * expires", so the live predicate must be `or(isNull(...), gt(...))`. A bare `gt` evaluates to
   * NULL for every never-expiring key and drops it from the result set — which is EVERY key minted
   * without an explicit expiry, i.e. the default. The failure would present as "API keys don't work
   * at all", and it would present that way in production rather than here unless this is pinned.
   */
  it("a key with a NULL expires_at is STILL LIVE (a bare `gt` would break every key)", async () => {
    const { key, token } = await createApiKey(appRole.db, userA, { name: "forever" });
    expect(key.expiresAt).toBeNull();
    expect(await findLiveApiKey(appRole.db, token)).toBeDefined();
    expect(await isApiKeyLive(appRole.db, key.id)).toBe(true);
  });

  it("a key expiring in the FUTURE is live", async () => {
    const { token } = await createApiKey(appRole.db, userA, {
      name: "later",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await findLiveApiKey(appRole.db, token)).toBeDefined();
  });

  it("carries the stored role through to the lookup", async () => {
    const { token } = await createApiKey(appRole.db, userA, { name: "reports", role: "member" });
    expect((await findLiveApiKey(appRole.db, token))?.role).toBe("member");
  });

  // ── ownership scoping ──────────────────────────────────────────────────────────────────────

  /**
   * The `userId`-is-the-second-parameter rule, behaviourally. Without that predicate any
   * authenticated caller could revoke any key id they could guess, and the route has no other
   * ownership check — it maps `false` straight to 404.
   */
  it("revokeApiKey REFUSES another user's key, and leaves it live", async () => {
    const { key, token } = await createApiKey(appRole.db, userA, { name: "desktop" });
    expect(await revokeApiKey(appRole.db, userB, key.id)).toBe(false);
    expect(await findLiveApiKey(appRole.db, token)).toBeDefined();
  });

  it("revokeApiKey is idempotent: a second revoke returns false", async () => {
    const { key } = await createApiKey(appRole.db, userA, { name: "desktop" });
    expect(await revokeApiKey(appRole.db, userA, key.id)).toBe(true);
    expect(await revokeApiKey(appRole.db, userA, key.id)).toBe(false);
  });

  it("listApiKeys returns only the caller's LIVE keys, newest first, without a token hash", async () => {
    const first = await createApiKey(appRole.db, userA, { name: "older" });
    // `created_at` defaults to now(); two inserts in the same statement-batch can share a
    // timestamp, so nudge the first one back rather than relying on clock resolution for ordering.
    await owner.db.execute(
      sql`update api_keys set created_at = now() - interval '1 minute' where id = ${first.key.id}`,
    );
    const newer = await createApiKey(appRole.db, userA, { name: "newer" });
    const revoked = await createApiKey(appRole.db, userA, { name: "revoked" });
    await revokeApiKey(appRole.db, userA, revoked.key.id);
    await createApiKey(appRole.db, userB, { name: "someone else's" });

    const rows = await listApiKeys(appRole.db, userA);
    expect(rows.map((r) => r.name)).toEqual(["newer", "older"]);
    expect(rows[0]!.id).toBe(newer.key.id);
    // The explicit column list is the enforcement (CLAUDE.md 15.1) — nothing strips extras on the
    // wire, so a bare `select()` here would have shipped the hash to every client.
    expect(rows[0]).not.toHaveProperty("tokenHash");
    expect(rows[0]).not.toHaveProperty("token_hash");
    expect(rows[0]).not.toHaveProperty("userId");
  });

  it("listApiKeys omits an EXPIRED key, which cannot authenticate anyway", async () => {
    await createApiKey(appRole.db, userA, {
      name: "expired",
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await listApiKeys(appRole.db, userA)).toHaveLength(0);
  });

  // ── bulk revocation (D-15.9-9) ─────────────────────────────────────────────────────────────

  it("revokeAllApiKeys revokes only that user's live keys and returns the count", async () => {
    await createApiKey(appRole.db, userA, { name: "one" });
    await createApiKey(appRole.db, userA, { name: "two" });
    const theirs = await createApiKey(appRole.db, userB, { name: "not mine to revoke" });

    expect(await revokeAllApiKeys(appRole.db, userA)).toBe(2);
    expect(await listApiKeys(appRole.db, userA)).toHaveLength(0);
    // The other user is untouched — the predicate is `user_id`, and a bulk revoke that reached
    // across users would be a denial-of-service with a 204.
    expect(await findLiveApiKey(appRole.db, theirs.token)).toBeDefined();
  });

  /**
   * IDEMPOTENT BY CONSTRUCTION, and this is the assertion that proves the stated MECHANISM rather
   * than the outcome. The `revoked_at IS NULL` predicate is what makes a second call update zero
   * rows instead of re-stamping — so the count means "how many were live", not "how many exist".
   * That is the same property that excludes the revoke-vs-revoke race without a lock (EvalPlanQual
   * re-evaluates the predicate), which the function's comment names explicitly.
   */
  it("revokeAllApiKeys is idempotent: the second call returns 0", async () => {
    await createApiKey(appRole.db, userA, { name: "one" });
    expect(await revokeAllApiKeys(appRole.db, userA)).toBe(1);
    expect(await revokeAllApiKeys(appRole.db, userA)).toBe(0);
  });

  // ── the mint guards (code-review finding 5) ────────────────────────────────────────────────

  it("mintApiKey succeeds under the cap and reports the live count", async () => {
    // POSITIVE FIRST: the guards must not be a blanket refusal.
    const r = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "one" }, 3));
    expect(r.ok).toBe(true);
    expect(await countLiveApiKeys(appRole.db, userA)).toBe(1);
  });

  it("REFUSES at the cap, and a revoke frees a slot", async () => {
    for (const name of ["a", "b"]) {
      const r = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name }, 2));
      expect(r.ok, `minting ${name}`).toBe(true);
    }
    const full = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "c" }, 2));
    expect(full).toEqual({ ok: false, reason: "at_capacity" });

    // The cap counts LIVE keys, so revoking one must free a slot — otherwise a user who hit the
    // cap could never recover without operator help.
    const [first] = await listApiKeys(appRole.db, userA);
    expect(await revokeApiKey(appRole.db, userA, first!.id)).toBe(true);
    const after = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "c" }, 2));
    expect(after.ok).toBe(true);
  });

  it("the cap is PER USER, not global", async () => {
    await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "a" }, 1));
    const theirs = await owner.db.transaction((tx) => mintApiKey(tx, userB, { name: "a" }, 1));
    expect(theirs.ok, "userB has their own budget, and may reuse the name").toBe(true);
  });

  it("REFUSES a duplicate LIVE name, and allows re-minting it after a revoke", async () => {
    const first = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "desktop" }, 9));
    expect(first.ok).toBe(true);
    const dup = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "desktop" }, 9));
    expect(dup).toEqual({ ok: false, reason: "duplicate_name" });

    // THE REASON THE INDEX IS PARTIAL. Rotating a key by the same name is the most common
    // operation there is; a plain unique index would make it fail forever.
    expect(await revokeApiKey(appRole.db, userA, (first as { key: { id: string } }).key.id)).toBe(
      true,
    );
    const reminted = await owner.db.transaction((tx) =>
      mintApiKey(tx, userA, { name: "desktop" }, 9),
    );
    expect(reminted.ok, "re-minting a revoked name must work").toBe(true);
  });

  /**
   * THE DEAD END THE PR REVIEW FOUND, pinned. The partial unique index is `WHERE revoked_at IS NULL`
   * and CANNOT test expiry (a partial-index predicate must be IMMUTABLE; `now()` is only STABLE),
   * while every other liveness predicate here DOES exclude expired rows. So before `mintApiKey`
   * reclaimed the name, an expired key was invisible to `listApiKeys`, unrevocable (no id to pass)
   * and still refused its own name — the day-91 "my `desktop` key expired" path, with no remedy
   * short of operator DB access.
   */
  it("reclaims an EXPIRED key's name so it can be re-minted", async () => {
    await createApiKey(appRole.db, userA, {
      name: "desktop",
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await listApiKeys(appRole.db, userA), "expired ⇒ invisible to the owner").toHaveLength(
      0,
    );
    const again = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "desktop" }, 9));
    expect(again.ok, "an expired name must be reclaimable").toBe(true);
  });

  it("does NOT sweep a never-expiring key when reclaiming a name", async () => {
    // The guard that keeps the reclaim honest: `expires_at IS NULL` means "never", so a bare
    // comparison would revoke the WORKING key the mint collides with — turning a 409 into silent
    // credential destruction.
    const { token } = await createApiKey(appRole.db, userA, { name: "desktop" });
    const dup = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "desktop" }, 9));
    expect(dup).toEqual({ ok: false, reason: "duplicate_name" });
    expect(await findLiveApiKey(appRole.db, token), "the live key must survive").toBeDefined();
  });

  it("does NOT sweep a FUTURE-expiring key when reclaiming a name", async () => {
    const { token } = await createApiKey(appRole.db, userA, {
      name: "desktop",
      expiresAt: new Date(Date.now() + 600_000),
    });
    const dup = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "desktop" }, 9));
    expect(dup).toEqual({ ok: false, reason: "duplicate_name" });
    expect(await findLiveApiKey(appRole.db, token), "not yet expired ⇒ must survive").toBeDefined();
  });

  it("an EXPIRED key consumes no slot (the cap counts LIVE, matching listApiKeys)", async () => {
    await createApiKey(appRole.db, userA, {
      name: "expired",
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await countLiveApiKeys(appRole.db, userA)).toBe(0);
    const r = await owner.db.transaction((tx) => mintApiKey(tx, userA, { name: "fresh" }, 1));
    expect(r.ok).toBe(true);
  });

  /**
   * THE CONCURRENCY TEST, AT THE RIGHT LAYER (CLAUDE.md 15.5). Two HTTP requests would serialise on
   * their own and pass with or without the lock — a green test advertising a guarantee nobody
   * checked. Only two HAND-HELD transactions discriminate: A takes the `FOR UPDATE` on the owner's
   * `users` row and holds it; B must still be UNSETTLED after a wait, because it is blocked.
   *
   * Without the lock, B would count 0 (A is uncommitted), see room under a cap of 1, and insert —
   * landing at 2 over a cap of 1.
   *
   * The release is in a `finally`: when 15.5's equivalent assertion first failed it skipped the
   * release, the held transaction kept its pooled connection, and five later tests timed out.
   */
  it("two concurrent mints cannot both pass a cap of 1 (FOR UPDATE serialises them)", async () => {
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let settled = false;

    try {
      const txA = owner.db.transaction(async (tx) => {
        const r = await mintApiKey(tx, userA, { name: "a" }, 1);
        await gate; // hold the lock open
        return r;
      });
      // Let A reach its insert and take the lock before B starts.
      await new Promise((r) => setTimeout(r, 250));

      const txB = owner.db
        .transaction((tx) => mintApiKey(tx, userA, { name: "b" }, 1))
        .then((r) => {
          settled = true;
          return r;
        });

      await new Promise((r) => setTimeout(r, 500));
      expect(settled, "B must be BLOCKED on A's row lock, not racing past it").toBe(false);

      releaseA();
      const [a, b] = await Promise.all([txA, txB]);
      // Exactly one wins, and the loser is refused for the RIGHT reason: it re-counted after the
      // lock released and saw A's committed row.
      expect(a.ok).toBe(true);
      expect(b).toEqual({ ok: false, reason: "at_capacity" });
      expect(await countLiveApiKeys(appRole.db, userA)).toBe(1);
    } finally {
      releaseA();
    }
  });

  // ── the throttled touch (D-15.9-7) ─────────────────────────────────────────────────────────

  it("touchApiKeyLastUsed moves last_used_at, which starts null", async () => {
    const { key } = await createApiKey(appRole.db, userA, { name: "desktop" });
    expect(key.lastUsedAt).toBeNull();
    await touchApiKeyLastUsed(appRole.db, key.id);
    const [row] = await listApiKeys(appRole.db, userA);
    expect(row!.lastUsedAt).toBeInstanceOf(Date);
  });

  /**
   * The SSE per-tick probe must NOT write. `isApiKeyLive` exists precisely so the stream's re-check
   * cannot become a write per tick per connected client (audit B.4) — and the only way to know it
   * kept that promise is to look at the column before and after.
   */
  it("isApiKeyLive does NOT stamp last_used_at", async () => {
    const { key } = await createApiKey(appRole.db, userA, { name: "desktop" });
    expect(await isApiKeyLive(appRole.db, key.id)).toBe(true);
    const [row] = await listApiKeys(appRole.db, userA);
    expect(row!.lastUsedAt).toBeNull();
  });
});
