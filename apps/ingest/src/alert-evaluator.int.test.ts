import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  createDb,
  ensurePersonalOrg,
  listAlertFirings,
  machines,
  memberships,
  pricingCatalogs,
  recordHeartbeat,
  recordIngestAuthFailure,
  setUserPassword,
  withOrg,
} from "@420ai/db";
import type { AlertFiring, LiveMonitorSnapshot } from "@420ai/shared";
import { SERVICE_ROLE } from "@420ai/shared";
import { buildApp } from "./app.js";
import { hashPassword } from "./password.js";
import { runEvaluatorTick, evaluateOrgAlerts, type EvaluatorDeps } from "./alert-evaluator.js";
import {
  AnalysisProviderError,
  type AnalysisProvider,
  type AnalysisRequest,
} from "./analysis/provider.js";
import { seedBootstrapKey } from "./test-support/bootstrap-key.js";

const TEST_URL = process.env.DATABASE_URL_TEST;
const APP_URL = process.env.DATABASE_URL_TEST_APP;

const ADMIN_EMAIL = "admin@test.local";
const PASSWORD = "correct-horse";

const stubProvider: AnalysisProvider = {
  async interpret(_req: AnalysisRequest) {
    throw new AnalysisProviderError("not used in evaluator tests", "unavailable");
  },
};

/**
 * M16 16.6 — the background alert evaluator (INC-2026-07), proved end to end.
 *
 * TWO ROLES, AND THE APP ROLE IS THE POINT. Every assertion below runs the evaluator against a
 * handle connected as `420ai_app`; the owner handle appears only for `TRUNCATE` (which requires
 * table ownership) and for seeding. CLAUDE.md's `bypassed ≠ enforced`: `alert_firings` carries a
 * STRICT policy, so an evaluator that lost its org context would read ZERO rows, deliver nothing,
 * and report success — while passing every owner-connected suite in the repo. That is not
 * hypothetical here; it is exactly the shape of the 15.3 defect where `deliverPendingFirings` ran
 * on an unwrapped handle and outbound delivery was completely dead with a 200 and no log.
 *
 * THE TICK IS DRIVEN DIRECTLY, WITH AN INJECTED CLOCK. No timer is started and nothing sleeps.
 * A wall-clock test against a 60 s cadence is either slow or flaky, and M15 15.5's lesson is that
 * a timing test at the wrong LAYER cannot fail informatively. The plugin's interval is trivia
 * (`plugins/alert-evaluator.ts`); the composition is the slice, so the composition is what is
 * pinned. The one thing the timer owns — teardown — is asserted at the bottom.
 */
describe.skipIf(!TEST_URL || !APP_URL)("M16 16.6 background alert evaluator", () => {
  let owner: ReturnType<typeof createDb>;
  let appRole: ReturnType<typeof createDb>;
  let app: FastifyInstance;
  let ADMIN: string;
  let orgId: string;
  let userId: string;

  const delivered: AlertFiring[] = [];
  const deliverer = {
    deliver: vi.fn(async (f: AlertFiring): Promise<void> => {
      delivered.push(f);
    }),
  };

  /**
   * THE HEADLINE CLAIM MADE LITERAL. INC-2026-07's whole mechanism was that evaluation only ever
   * happened inside `GET /v1/monitor`, so "the evaluator delivers without a dashboard" is the one
   * assertion that must not be implicit. This counts every HTTP request the app serves, and the
   * delivery tests assert it is still 0 at the moment the webhook fires.
   */
  let httpRequests = 0;

  beforeAll(async () => {
    owner = createDb(TEST_URL!); // setup + TRUNCATE only
    appRole = createDb(APP_URL!); // what the SERVER connects as — and what the evaluator uses
    app = buildApp({
      db: appRole.db,
      adminEmail: ADMIN_EMAIL,
      // Reconcile on EVERY tick so the dashboard-collision test below is not racing the 30 s
      // production throttle (M15 15.4's note, same reason `delivery.int.test.ts` injects 0).
      reconcileThrottleMs: 0,
      analysisProvider: stubProvider,
      alertDeliverer: deliverer,
      // DELIBERATELY OMITTED: `alertEvaluatorIntervalMs`. The default is 0/disabled, so this suite
      // starts no timer — the tick is called by hand. See the teardown test at the bottom.
      logger: false,
    });
    app.addHook("onRequest", async () => {
      httpRequests += 1;
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // CLEAN UP AFTER OURSELVES, not merely before ourselves — and this is not tidiness.
    //
    // `beforeEach` truncates, so the residue of every test but the LAST one is cleared by the next
    // test. The final `seedBootstrapKey` writes one `api_key.minted` row into `audit_events` that
    // nothing afterwards removes, and `audit_events` is the one table the application can never
    // DELETE from (M15 15.10's APPEND_ONLY classification), so no later suite clears it either.
    // That single row is enough: `rollback.int.test.ts` asserts `count(*) = 0` on `audit_events`,
    // and with `fileParallelism: false` a leak like this lands as a failure in a FILE THAT WAS
    // NEVER TOUCHED — 1 real defect wearing somebody else's name. Measured, not guessed: the full
    // suite is green with this file removed and fails in `rollback.int.test.ts` with it present.
    await owner.db.execute(
      sql`TRUNCATE alert_firings, ingest_auth_failures, pricing_catalogs, audit_events, machine_heartbeats, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    await owner.pool.end();
    await appRole.pool.end();
  });

  beforeEach(async () => {
    // `ingest_auth_failures` has NO FK, so the users-CASCADE won't clear it — TRUNCATE explicitly.
    //
    // `pricing_catalogs` LIKEWISE, and it is here for a reason worth stating rather than copying.
    // TWO of the nine alert codes are GLOBAL — they are derived from tables with no `org_id` at
    // all (`countPendingCatalogs`, `countRecentAuthFailures`) — so the tick emits them for EVERY
    // org in the deployment. That is correct and matches what the dashboard already does, but it
    // makes this suite's per-org counts depend on deployment-wide state that no org owns.
    //
    // Leaving it out did not fail this file in isolation; it failed only in a full `vitest run`,
    // where a suite that runs earlier and truncates `pricing_catalogs` only in its OWN `beforeEach`
    // leaves pending rows behind. Every count in this file then came out at exactly DOUBLE — one
    // `collector.offline` plus one inherited `catalog.update_requires_approval` per org. A suite
    // whose assertions depend on a global input must own that input.
    await owner.db.execute(
      sql`TRUNCATE alert_firings, ingest_auth_failures, pricing_catalogs, machine_heartbeats, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    // Re-minted after every TRUNCATE: `api_keys` cascades away with `users`.
    ADMIN = await seedBootstrapKey(owner.db, ADMIN_EMAIL);
    userId = await setUserPassword(owner.db, ADMIN_EMAIL, hashPassword(PASSWORD));
    orgId = await ensurePersonalOrg(owner.db, userId, ADMIN_EMAIL);
    deliverer.deliver.mockClear();
    delivered.length = 0;
    httpRequests = 0;
    // RESET, and assert on it in the happy paths below. Without this the array accumulated across
    // the whole file and only the exploding-deliverer test ever looked at it — so a swallowed
    // per-firing delivery error in any other test went unnoticed. That is the exact silent-failure
    // shape this component exists to surface: `result.failed` covers a per-ORG throw, but a
    // per-FIRING delivery error only ever reaches `onError`.
    errors.length = 0;
  });

  const errors: unknown[] = [];
  const deps = (over: Partial<EvaluatorDeps> = {}): EvaluatorDeps => ({
    db: appRole.db,
    deliverer,
    now: new Date(),
    onError: (e) => errors.push(e),
    ...over,
  });

  /** A machine in `org` whose last heartbeat is 10 min old → `deriveMachineStatus` → offline. */
  async function seedOfflineMachine(org: string, user: string, name: string): Promise<string> {
    const [m] = await owner.db
      .insert(machines)
      .values({ orgId: org, userId: user, name })
      .returning({ id: machines.id });
    await recordHeartbeat(owner.db, m!.id, {
      queuePending: 0,
      queueInflight: 0,
      collectorVersion: "0.9.1",
      now: new Date(Date.now() - 10 * 60 * 1000),
    });
    return m!.id;
  }

  async function countOpenFirings(): Promise<number> {
    const rows = await owner.db.execute<{ n: string }>(
      sql`SELECT count(*)::int AS n FROM alert_firings WHERE status = 'open'`,
    );
    return Number((rows.rows[0] as { n: number | string }).n);
  }

  // 0 ── THE SUITE'S OWN PRECONDITION, and it must be first. RLS is inert against a role with
  // `rolbypassrls`, and `DATABASE_URL_TEST` is exactly that (it owns the tables). Point `APP_URL`
  // at the owner handle by mistake and every assertion below still passes while proving nothing
  // about whether the evaluator carries an org context — CLAUDE.md: "without that first test the
  // whole file is theatre".
  it("the evaluator's connection is the non-bypassing app role", async () => {
    const r = await appRole.db.execute<{ u: string; b: boolean }>(
      sql`select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as b`,
    );
    expect(r.rows[0]!.u).toBe("420ai_app");
    expect(r.rows[0]!.b).toBe(false);
  });

  it("delivers collector.offline from a tick alone — with NO dashboard request", async () => {
    const machineId = await seedOfflineMachine(orgId, userId, "dogfood-machine");

    const result = await runEvaluatorTick(deps());

    expect(result.orgs).toBe(1);
    expect(result.failed).toBe(0);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
    expect(delivered[0]!.code).toBe("collector.offline");
    expect(delivered[0]!.machineId).toBe(machineId);
    expect(delivered[0]!.status).toBe("open");
    // THE ASSERTION THE SLICE EXISTS FOR: nobody opened the dashboard.
    expect(httpRequests).toBe(0);
    // Nothing was swallowed on the way. `result.failed` only counts per-ORG throws; a per-firing
    // delivery error reaches `onError` alone, so the happy path must assert the sink is empty.
    expect(errors).toEqual([]);
  });

  it("does NOT duplicate the dashboard's firing — one open row, one delivery", async () => {
    await seedOfflineMachine(orgId, userId, "dogfood-machine");
    await runEvaluatorTick(deps());
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);

    // Now a human finally opens the monitor. D-16.6-2: the tick reconciled as the org's OWNER, so
    // it collided with the row the dashboard would write rather than opening a second one.
    // `alert_firings_open_key` is unique on `(user_id, alert_key) WHERE status='open'`, so a tick
    // that picked a DIFFERENT user would produce a second open row and a second email for one
    // outage — this test is what fails loudly if that choice ever changes.
    const res = await app.inject({
      method: "GET",
      url: "/v1/monitor",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    const snap = res.json() as LiveMonitorSnapshot;
    const open = snap.alertFirings.filter(
      (f) => f.code === "collector.offline" && f.status === "open",
    );
    expect(open).toHaveLength(1);
    expect(await countOpenFirings()).toBe(1);
    // `delivery_attempted_at` was stamped by the tick, so the dashboard read re-delivers nothing.
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — two consecutive ticks deliver once and leave one open row", async () => {
    await seedOfflineMachine(orgId, userId, "dogfood-machine");

    await runEvaluatorTick(deps());
    await runEvaluatorTick(deps());

    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
    expect(await countOpenFirings()).toBe(1);
  });

  it("delivers ingest.auth_failure from a tick alone (the direct INC-2026-07 regression)", async () => {
    // The signal that existed for the whole 8-day incident. `plugins/auth.ts` wrote one of these
    // rows on every rejected token, `deriveAuthFailureAlerts` fired at ≥3 in 15 min, and nothing
    // ever evaluated it because nobody opened the dashboard. Note there is no machine here at all:
    // the archive's machine row had been reset away, which is precisely why `collector.offline`
    // could not fire and why THIS is the alert that mattered.
    await recordIngestAuthFailure(appRole.db, { remoteIp: "1.1.1.1" });
    await recordIngestAuthFailure(appRole.db, { remoteIp: "1.1.1.1" });

    // Below the threshold → nothing.
    await runEvaluatorTick(deps());
    expect(deliverer.deliver).not.toHaveBeenCalled();

    await recordIngestAuthFailure(appRole.db, { remoteIp: "2.2.2.2" });
    await runEvaluatorTick(deps());

    const firing = delivered.find((f) => f.code === "ingest.auth_failure");
    expect(firing).toBeDefined();
    expect(firing!.severity).toBe("warning");
    expect(firing!.status).toBe("open");
    expect(httpRequests).toBe(0);
  });

  it("evaluates EVERY org in one tick, and never attributes one org's firing to another", async () => {
    const userB = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
    const orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    expect(orgB).not.toBe(orgId);
    const machineA = await seedOfflineMachine(orgId, userId, "machine-a");
    const machineB = await seedOfflineMachine(orgB, userB, "machine-b");

    const result = await runEvaluatorTick(deps());

    expect(result.orgs).toBe(2);
    expect(deliverer.deliver).toHaveBeenCalledTimes(2);
    expect(delivered.map((f) => f.machineId).sort()).toEqual([machineA, machineB].sort());

    // Each firing row carries its OWN org — the loop must not smear one org's context over the
    // other. Read on the OWNER handle deliberately: the app role could not see both at once, so
    // only the owner can prove the two rows are correctly separated rather than merely filtered.
    const rows = await owner.db.execute<{ org_id: string; machine_id: string }>(
      sql`SELECT org_id, machine_id FROM alert_firings WHERE status = 'open' ORDER BY org_id`,
    );
    const byMachine = new Map(
      (rows.rows as { org_id: string; machine_id: string }[]).map((r) => [r.machine_id, r.org_id]),
    );
    expect(byMachine.get(machineA)).toBe(orgId);
    expect(byMachine.get(machineB)).toBe(orgB);
  });

  it("reconciles as the org's OWNER, not merely its oldest member (D-16.6-2)", async () => {
    // THE DISCRIMINATING FIXTURE. In a single-member org "the owner" and "the first member" are
    // the same row, so every other test in this file would pass against a naive `members[0]`.
    // Here the OLDEST membership is a viewer and the owner joins second, so the two answers
    // differ — and `alert_firings.user_id` records which one the tick actually used.
    //
    // The claim is load-bearing rather than stylistic: `alert_firings_open_key` is unique on
    // `(user_id, alert_key) WHERE status='open'`, so picking the wrong user opens a SECOND row
    // beside the dashboard's and sends a second email for one outage.
    const rows = await owner.db.execute<{ id: string }>(
      sql`INSERT INTO organizations (name) VALUES ('two-rung-org') RETURNING id`,
    );
    const org2 = (rows.rows[0] as { id: string }).id;
    const viewerId = await setUserPassword(owner.db, "viewer@example.com", hashPassword(PASSWORD));
    const ownerId = await setUserPassword(owner.db, "owner@example.com", hashPassword(PASSWORD));
    // The VIEWER's membership is inserted first, so `listMembers` (ordered by `created_at, id`)
    // returns it first. Both users already hold a personal-org membership from `setUserPassword`
    // → `ensurePersonalOrg`; these are additional memberships in `org2`, which is the one case
    // where INSERTing rather than MOVING is correct — nothing here resolves a principal.
    await owner.db.insert(memberships).values({ orgId: org2, userId: viewerId, role: "viewer" });
    await owner.db.insert(memberships).values({ orgId: org2, userId: ownerId, role: "owner" });
    await seedOfflineMachine(org2, ownerId, "two-rung-machine");

    await runEvaluatorTick(deps());

    const firings = await owner.db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM alert_firings WHERE org_id = ${org2} AND status = 'open'`,
    );
    expect(firings.rows).toHaveLength(1);
    expect((firings.rows[0] as { user_id: string }).user_id).toBe(ownerId);
    expect((firings.rows[0] as { user_id: string }).user_id).not.toBe(viewerId);
  });

  it("ISOLATES a failing org — the loop continues and later orgs still deliver", async () => {
    // `expect(result.failed).toBe(0)` appears five times in this file; `failed > 0` appeared
    // nowhere, so the try/catch around the loop body — which the source calls "the one outcome this
    // component may never produce" — was pinned by nothing. Deleting it would leave the whole file
    // green while making ONE bad org cost EVERY other org its detection, in the component whose
    // entire job is to survive to report other things' failures.
    //
    // The throwing deliverer test does NOT cover this: `deliverPendingFirings` catches internally,
    // so `failed` stays 0 there. The failure has to be at the ORG level, which is what proxying
    // `transaction` gives us — the first `withOrg` of the tick rejects.
    const userB = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
    const orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    await seedOfflineMachine(orgId, userId, "doomed-machine"); // org A — created first
    const machineB = await seedOfflineMachine(orgB, userB, "surviving-machine");

    // M16 16.7: fail the first ORG transaction, not simply the first transaction. The tick now
    // opens several `withDeployment` transactions BEFORE the org loop (the deployment reconcile
    // plus its two delivery passes), so a naive "reject call #0" now takes down the deployment
    // prologue instead — which is a different behaviour, covered by its own test below. The stack
    // check is what keeps this test about ORG isolation, which is what it was written for.
    let orgTransactions = 0;
    const flaky = new Proxy(appRole.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return (...args: unknown[]) => {
            const fromDeployment = (new Error().stack ?? "").includes("withDeployment");
            if (!fromDeployment && orgTransactions++ === 0) {
              return Promise.reject(new Error("simulated org failure"));
            }
            return (target.transaction as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const result = await runEvaluatorTick(deps({ db: flaky }));

    expect(result.failed).toBe(1);
    expect(result.orgs).toBe(1); // org B was still evaluated
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
    expect(delivered[0]!.machineId).toBe(machineB);
    // The error names WHICH org failed and preserves the original — without the wrapper the
    // operator gets a bare stack trace, in a sink shared by three different failure sources.
    expect(errors).toHaveLength(1);
    const err = errors[0] as Error;
    expect(err.message).toContain(orgId);
    expect((err as Error & { cause?: Error }).cause).toBeInstanceOf(Error);
  });

  it("skips an org with NO members rather than throwing", async () => {
    // Possible mid-teardown: the org row outlives its last membership. `withOrg` needs a user to
    // reconcile as, so there is nothing to do — but a throw here would take out every OTHER org's
    // detection in the same tick, which is the one outcome this component may never produce.
    await owner.db.execute(sql`INSERT INTO organizations (name) VALUES ('orphaned-org')`);
    await seedOfflineMachine(orgId, userId, "dogfood-machine");

    const result = await runEvaluatorTick(deps());

    expect(result.skipped).toBe(1);
    expect(result.orgs).toBe(1);
    expect(result.failed).toBe(0);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
  });

  it("still reconciles for an org whose only member is a VIEWER", async () => {
    // M15 15.4's "whose action is this?" — the reconcile is the ORG's bookkeeping, not the
    // viewer's mutation, so the tick runs as SERVICE_ROLE and the 0016 RESTRICTIVE write policies
    // do not apply. Under `principal.role` this would be rejected outright and the org would get
    // no detection at all, silently.
    //
    // MOVE the existing membership, never INSERT a second one: `ensurePersonalOrg` already made
    // this user an `owner`, and `findPrincipalByEmail` resolves the FIRST membership by
    // `(created_at, id)` — so an extra row would be shadowed and this test would quietly assert
    // nothing (CLAUDE.md's 15.4 seeding lesson).
    await owner.db
      .update(memberships)
      .set({ role: "viewer" })
      .where(sql`${memberships.orgId} = ${orgId}`);
    await seedOfflineMachine(orgId, userId, "dogfood-machine");

    const result = await runEvaluatorTick(deps());

    expect(result.failed).toBe(0);
    expect(result.orgs).toBe(1);
    expect(await countOpenFirings()).toBe(1);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
  });

  it("reconciles with NO deliverer wired — delivery early-returns, detection still persists", async () => {
    await seedOfflineMachine(orgId, userId, "dogfood-machine");

    const result = await runEvaluatorTick(deps({ deliverer: null }));

    expect(result.orgs).toBe(1);
    expect(deliverer.deliver).not.toHaveBeenCalled();
    // The firing ROW is the durable record; webhook/SMTP are a convenience push (M12 12.6).
    expect(await countOpenFirings()).toBe(1);
  });

  it("survives a deliverer that THROWS — reported via onError, never propagated", async () => {
    const orgB = await (async () => {
      const u = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
      const o = await ensurePersonalOrg(owner.db, u, "b@example.com");
      await seedOfflineMachine(o, u, "machine-b");
      return o;
    })();
    await seedOfflineMachine(orgId, userId, "machine-a");
    errors.length = 0;
    const exploding = {
      deliver: vi.fn(async (): Promise<void> => {
        throw new Error("webhook is down");
      }),
    };

    const result = await runEvaluatorTick(deps({ deliverer: exploding }));

    // BOTH orgs were still evaluated. A dead webhook must not cost the deployment its detection —
    // `deliverPendingFirings` catches per firing and hands the error to `log`, so nothing unwinds.
    expect(result.orgs).toBe(2);
    expect(result.failed).toBe(0);
    expect(exploding.deliver).toHaveBeenCalledTimes(2);
    expect(errors.length).toBeGreaterThan(0);
    expect(await countOpenFirings()).toBe(2);
    expect(orgB).toBeTruthy();
  });

  it("does not FLAP against the dashboard across multiple alert codes", async () => {
    // THE PARITY TEST. `reconcileAlertFirings` resolves every open firing whose key is absent from
    // the derived set (D5), so if the tick and `GET /v1/monitor` ever derive different code sets,
    // each closes what the other opens: the firing flaps every cycle and the operator gets a
    // resolve notice per tick for an outage that never ended.
    //
    // That requirement previously had ZERO coverage while appearing to have some — the test named
    // "does not flap on the nine codes" seeded a single offline machine, so only ONE code was ever
    // derived and no divergence could possibly show up. It has been renamed to what it does (see
    // below) and this test added, which seeds THREE distinct codes and interleaves tick → HTTP
    // read → tick. It fails the moment the two derive lists disagree, which is what makes the
    // shared `alert-set.ts` composition verifiable rather than merely asserted.
    await seedOfflineMachine(orgId, userId, "flap-machine"); // collector.offline
    await recordIngestAuthFailure(appRole.db, { remoteIp: "1.1.1.1" }); // ingest.auth_failure
    await recordIngestAuthFailure(appRole.db, { remoteIp: "1.1.1.1" });
    await recordIngestAuthFailure(appRole.db, { remoteIp: "2.2.2.2" });
    // catalog.update_requires_approval — a GLOBAL code, and the third distinct key. Inserted via
    // the typed schema rather than hand-written SQL: the first attempt guessed a `signed_by`
    // column that does not exist, which the 15.1 "explicit column list" habit exists to avoid.
    await owner.db
      .insert(pricingCatalogs)
      .values({ version: "flap-test-1", status: "pending", payload: {}, signature: "sig" });

    await runEvaluatorTick(deps());
    const codesAfterTick = new Set(delivered.map((f) => f.code));
    expect(codesAfterTick.size).toBeGreaterThanOrEqual(3);
    const openAfterTick = await countOpenFirings();
    expect(openAfterTick).toBeGreaterThanOrEqual(3);

    // The dashboard now reads. If it derived a DIFFERENT set, it would resolve whatever the tick
    // opened and re-open its own — visible as a changed open count and a second delivery.
    const res = await app.inject({
      method: "GET",
      url: "/v1/monitor",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(await countOpenFirings()).toBe(openAfterTick);

    // …and a second tick agrees with the dashboard, in the other direction.
    await runEvaluatorTick(deps());
    expect(await countOpenFirings()).toBe(openAfterTick);
    // Every firing is still OPEN — nothing was resolved and reopened behind our back.
    const resolved = await owner.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM alert_firings WHERE status = 'resolved'`,
    );
    expect(Number((resolved.rows[0] as { n: number }).n)).toBe(0);
    // At-most-once delivery held throughout: one per distinct code, no repeats.
    expect(deliverer.deliver.mock.calls.length).toBe(openAfterTick);
  });

  it("resolves an open firing once the condition clears", async () => {
    // The condition genuinely clears (a fresh heartbeat), so exactly one resolve is correct — and
    // the following dashboard read must not re-open it.
    const machineId = await seedOfflineMachine(orgId, userId, "dogfood-machine");
    await runEvaluatorTick(deps());
    expect(await countOpenFirings()).toBe(1);

    await recordHeartbeat(owner.db, machineId, {
      queuePending: 0,
      queueInflight: 0,
      collectorVersion: "0.9.1",
    });
    await runEvaluatorTick(deps());
    expect(await countOpenFirings()).toBe(0);

    const res = await app.inject({
      method: "GET",
      url: "/v1/monitor",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const snap = res.json() as LiveMonitorSnapshot;
    expect(snap.alertFirings.filter((f) => f.status === "open")).toHaveLength(0);
    expect(await countOpenFirings()).toBe(0);
  });

  it("evaluateOrgAlerts scopes to the org it is given and no other", async () => {
    const userB = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
    const orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
    await seedOfflineMachine(orgId, userId, "machine-a");
    await seedOfflineMachine(orgB, userB, "machine-b");

    const count = await evaluateOrgAlerts(deps(), orgB, userB);

    // Only org B's machine is visible from org B's context — one alert, not two.
    expect(count).toBe(1);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
    expect(delivered[0]!.machineName).toBe("machine-b");
    expect(await countOpenFirings()).toBe(1);
  });

  it("the DEFAULT buildApp starts no evaluator — an offline machine stays undetected", async () => {
    // The reason the default is 0: ~30 int-test files call `buildApp` without this option, and a
    // timer in all of them would race `app.close()` as flaky failures in unrelated suites.
    //
    // THE FIRST VERSION OF THIS TEST COULD NOT FAIL. It timed `app.close()` and asserted it
    // returned within 2 s, on the stated theory that a leaked timer would make it hang. That
    // theory is simply false — Fastify's `close()` neither inspects nor awaits `setInterval`
    // handles, and the plugin `unref()`s its timer anyway — so it passed whether or not a timer
    // existed. Worse than useless: a false claim about the mechanism, which CLAUDE.md's 15.5
    // lesson identifies as the real defect, because the next reader trusts it.
    //
    // What discriminates is a tick-OBSERVABLE side effect. An offline machine is seeded; if a
    // default-built app ever started an evaluator, a firing would appear.
    await seedOfflineMachine(orgId, userId, "no-evaluator-machine");
    const disposable = buildApp({
      db: appRole.db,
      analysisProvider: stubProvider,
      alertDeliverer: deliverer,
      logger: false,
    });
    await disposable.ready();
    await new Promise((r) => setTimeout(r, 150));
    expect(deliverer.deliver).not.toHaveBeenCalled();
    expect(await countOpenFirings()).toBe(0);
    await disposable.close();
  });

  it("clears its interval on close — no delivery continues afterwards", async () => {
    // A leaked timer is invisible to `tsc` and to every assertion; it surfaces as a vitest run that
    // never exits. So this drives a fast cadence, lets it tick, closes, and asserts nothing more
    // happens.
    //
    // NOTE WHAT WAS WRONG BEFORE: this app was built WITHOUT `alertDeliverer`, so
    // `app.alertDeliverer` was null, `deliverPendingFirings` early-returned before any query, and
    // the suite-level spy was unreachable from it under ANY circumstances. The final assertion
    // compared 0 to 0 and would have passed against a plugin with no `onClose` hook at all — the
    // single test guarding the one failure class CLAUDE.md says `tsc` and tests do not catch. It
    // now wires the deliverer AND seeds a machine, so `before` is non-zero and a leaked timer
    // genuinely moves the count.
    await seedOfflineMachine(orgId, userId, "teardown-machine");
    const timed = buildApp({
      db: appRole.db,
      analysisProvider: stubProvider,
      alertDeliverer: deliverer,
      alertEvaluatorIntervalMs: 25,
      logger: false,
    });
    await timed.ready();
    await new Promise((r) => setTimeout(r, 120));
    await timed.close();
    const before = deliverer.deliver.mock.calls.length;
    expect(before).toBeGreaterThan(0); // the spy IS reachable — the old version's fatal omission
    await new Promise((r) => setTimeout(r, 120));
    expect(deliverer.deliver.mock.calls.length).toBe(before);
  });

  it("close() WAITS for a tick already in flight instead of abandoning it", async () => {
    // The half of teardown that `clearInterval` does not cover. Clearing the interval stops FUTURE
    // ticks; a tick that started moments ago is several awaits deep in a transaction and keeps
    // running against a handle the caller now believes is closed. In this suite that lands as
    // `Cannot use a pool after calling end` in whatever file runs next — a real defect wearing
    // someone else's name, which is the same shape as the `audit_events` leak this file's
    // `afterAll` exists to prevent.
    //
    // MAKING THIS DISCRIMINATE TOOK A SECOND ATTEMPT, which is the point worth recording. The
    // first version simply started a 20 ms interval, slept 25 ms and closed — and it passed
    // IDENTICALLY with and without `await inFlight`, because a tick over this fixture finishes in
    // a couple of milliseconds and had always completed before `close()` was called. A green test
    // advertising a guarantee nobody had checked, which is M15 15.5's lesson verbatim.
    //
    // The fix is to make the tick genuinely slow AT THE MOMENT OF CLOSE, by holding it inside a
    // deliverer that sleeps. Then the assertion is a fact, not a race: if `onClose` awaits the
    // in-flight tick, `finished` is necessarily true by the time `close()` returns; if it does not,
    // `close()` returns while the deliverer is still sleeping and `finished` is false. Re-verified
    // by deleting `await inFlight` — this test then fails and it is the only one that does.
    await seedOfflineMachine(orgId, userId, "close-race-machine");
    let finished = false;
    const slow = {
      deliver: vi.fn(async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 200));
        finished = true;
      }),
    };
    const timed = buildApp({
      db: appRole.db,
      analysisProvider: stubProvider,
      alertDeliverer: slow,
      alertEvaluatorIntervalMs: 20,
      logger: false,
    });
    await timed.ready();
    // Let a tick START and reach the (slow) deliverer, then close while it is still in there.
    await new Promise((r) => setTimeout(r, 60));
    expect(slow.deliver).toHaveBeenCalled();
    expect(finished).toBe(false); // still inside the deliverer — the race window is open
    await timed.close();
    expect(finished).toBe(true); // close() waited for it rather than abandoning it
    // …and nothing continues afterwards.
    const after = slow.deliver.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(slow.deliver.mock.calls.length).toBe(after);
  });

  /**
   * M16 16.7 — THE HEADLINE REGRESSION. One deployment-wide condition, three orgs, ONE firing.
   *
   * Before 16.7 the tick derived `catalog.update_requires_approval` and `ingest.auth_failure`
   * INSIDE the per-org loop, from tables that carry no `org_id` at all (`pricing_catalogs`,
   * `ingest_auth_failures`). So one pending catalog opened a firing in EVERY org and — with a
   * deliverer wired, which production has — sent one notice per org, then one resolve notice per
   * org when it cleared.
   *
   * That is not a multi-tenant hypothetical. `ensurePersonalOrg` gives every user their own org, so
   * ORG COUNT TRACKS USER COUNT: inviting two teammates makes this a three- or four-org deployment
   * the same afternoon, and nobody ever opens a dashboard for a colleague's auto-created personal
   * org, so before 16.6 those orgs were never evaluated at all and the duplication was invisible.
   *
   * Three orgs rather than two, deliberately: with two, "one firing" and "one per org" differ by a
   * factor a `toHaveBeenCalledTimes(2)` typo could absorb. With three the numbers cannot be
   * confused — 1 versus 3.
   */
  describe("M16 16.7 — deployment-scoped codes fire ONCE for the whole deployment", () => {
    /** Seed two further orgs (three including the suite's default), each with its own user. */
    async function seedThreeOrgs(): Promise<string[]> {
      const userB = await setUserPassword(owner.db, "b@example.com", hashPassword(PASSWORD));
      const orgB = await ensurePersonalOrg(owner.db, userB, "b@example.com");
      const userC = await setUserPassword(owner.db, "c@example.com", hashPassword(PASSWORD));
      const orgC = await ensurePersonalOrg(owner.db, userC, "c@example.com");
      expect(new Set([orgId, orgB, orgC]).size).toBe(3);
      return [orgId, orgB, orgC];
    }

    /** A pending signed pricing catalog — deployment-wide by construction (no `org_id` column). */
    async function seedPendingCatalog(): Promise<void> {
      await owner.db
        .insert(pricingCatalogs)
        .values({ version: "m167-1", status: "pending", payload: {}, signature: "sig" });
    }

    it("ONE pending catalog across THREE orgs produces exactly ONE open firing and ONE delivery", async () => {
      const orgs = await seedThreeOrgs();
      await seedPendingCatalog();

      const result = await runEvaluatorTick(deps());

      expect(result.orgs).toBe(3);
      expect(result.failed).toBe(0);
      // Derived once, not once per org — and broken out so the log line can say which.
      expect(result.deploymentAlerts).toBe(1);

      // ONE row, and its `org_id` is NULL: it belongs to the deployment, not to whichever org the
      // loop happened to reach first. Read on the OWNER handle — the app role sees the row under
      // any context, so only the owner can prove there is exactly one of it.
      const rows = await owner.db.execute<{ org_id: string | null }>(sql`
        SELECT org_id FROM alert_firings
         WHERE status = 'open' AND alert_key = 'catalog.update_requires_approval:*'`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.org_id).toBeNull();

      // ONE notice, not three.
      const catalogNotices = delivered.filter((f) => f.code === "catalog.update_requires_approval");
      expect(catalogNotices).toHaveLength(1);
      expect(catalogNotices[0]!.scope).toBe("deployment");
      expect(deliverer.deliver).toHaveBeenCalledTimes(1);
      expect(httpRequests).toBe(0);

      // …and EVERY org can still see it. One row is only the right answer if it is universally
      // visible — otherwise this "fix" would have hidden the condition from two orgs out of three.
      for (const org of orgs) {
        const seen = await withOrg(appRole.db, org, SERVICE_ROLE, (tx) =>
          listAlertFirings(tx, org, new Date()),
        );
        expect(
          seen.find((f) => f.alertKey === "catalog.update_requires_approval:*"),
          `org ${org} cannot see the deployment firing`,
        ).toBeDefined();
      }
    });

    it("resolves ONCE too — one resolve notice for three orgs, not three", async () => {
      await seedThreeOrgs();
      await seedPendingCatalog();
      await runEvaluatorTick(deps());
      expect(deliverer.deliver).toHaveBeenCalledTimes(1);

      // The catalog is approved: the condition clears deployment-wide.
      await owner.db.execute(sql`UPDATE pricing_catalogs SET status = 'active'`);
      await runEvaluatorTick(deps());

      const resolves = delivered.filter((f) => f.status === "resolved");
      expect(resolves).toHaveLength(1);
      expect(resolves[0]!.code).toBe("catalog.update_requires_approval");
      expect(await countOpenFirings()).toBe(0);
    });

    it("ingest.auth_failure is likewise deployment-scoped — one row across three orgs", async () => {
      await seedThreeOrgs();
      for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
        await recordIngestAuthFailure(appRole.db, { remoteIp: ip });
      }

      const result = await runEvaluatorTick(deps());

      expect(result.deploymentAlerts).toBe(1);
      const rows = await owner.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM alert_firings
         WHERE status = 'open' AND alert_key = 'ingest.auth_failure:*'`);
      expect(rows.rows[0]!.n).toBe(1);
      expect(delivered.filter((f) => f.code === "ingest.auth_failure")).toHaveLength(1);
    });

    it("org-scoped codes are UNAFFECTED — three orgs with three offline machines still get three", async () => {
      // The control. If the deployment split had accidentally swallowed the per-org codes too, the
      // headline test above would still pass while the evaluator had stopped detecting anything
      // per-tenant. Same tick, opposite expectation.
      const [orgA, orgB, orgC] = await seedThreeOrgs();
      const users = await owner.db.execute<{ user_id: string; org_id: string }>(
        sql`SELECT user_id, org_id FROM memberships`,
      );
      const byOrg = new Map(
        (users.rows as { user_id: string; org_id: string }[]).map((r) => [r.org_id, r.user_id]),
      );
      for (const [i, org] of [orgA!, orgB!, orgC!].entries()) {
        await seedOfflineMachine(org, byOrg.get(org)!, `machine-${i}`);
      }

      const result = await runEvaluatorTick(deps());

      expect(result.orgs).toBe(3);
      expect(delivered.filter((f) => f.code === "collector.offline")).toHaveLength(3);
      expect(delivered.every((f) => f.scope === "org")).toBe(true);
    });

    it("does not FLAP: the deployment firing survives an org tick that derives nothing", async () => {
      // D-16.7-3 END TO END. The org reconcile resolves every open firing in ITS scope whose key is
      // absent from the derived set — and it derives no deployment codes at all. If the two scopes'
      // predicates overlapped, each tick would resolve the deployment firing and the next re-open
      // it, sending a resolve notice per cycle for a condition that never cleared.
      await seedThreeOrgs();
      await seedPendingCatalog();
      await runEvaluatorTick(deps());
      const opened = delivered.filter((f) => f.code === "catalog.update_requires_approval");
      expect(opened).toHaveLength(1);

      // Three more ticks, no state change. Nothing further should be delivered at all.
      for (let i = 0; i < 3; i++) await runEvaluatorTick(deps());
      expect(delivered.filter((f) => f.status === "resolved")).toHaveLength(0);
      expect(deliverer.deliver).toHaveBeenCalledTimes(1);

      const rows = await owner.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM alert_firings
         WHERE alert_key = 'catalog.update_requires_approval:*'`);
      expect(rows.rows[0]!.n).toBe(1); // still ONE row, still open — never resolved and re-opened
    });

    it("ISOLATES a failing deployment pass — the org loop still runs", async () => {
      // The deployment pass is the tick's shared PROLOGUE, so an unhandled failure there would
      // abort every org's evaluation — one broken deployment-wide count taking down the whole
      // detector. It gets the same try/catch the per-org loop has, and the error is labelled so an
      // operator can tell which pass produced it (`onError` is also the sink for per-firing
      // delivery failures from three other places).
      await seedThreeOrgs();
      await seedOfflineMachine(orgId, userId, "still-detected");
      const brokenDb = new Proxy(appRole.db, {
        get(target, prop, receiver) {
          // Fail ONLY the deployment pass: it is the one that runs with no org context.
          if (prop === "transaction") {
            return async (fn: unknown, ...rest: unknown[]) => {
              const stack = new Error().stack ?? "";
              if (stack.includes("withDeployment")) throw new Error("deployment pass exploded");
              return (
                Reflect.get(target, prop, receiver) as (
                  f: unknown,
                  ...r: unknown[]
                ) => Promise<unknown>
              ).call(target, fn, ...rest);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof appRole.db;

      const result = await runEvaluatorTick(deps({ db: brokenDb }));

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(errors.some((e) => String(e).includes("deployment"))).toBe(true);
      // …and the org loop still ran and still delivered.
      expect(result.orgs).toBe(3);
      expect(delivered.filter((f) => f.code === "collector.offline")).toHaveLength(1);
    });
  });
});
