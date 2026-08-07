import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AlertFiring, OperationalAlert } from "@420ai/shared";
import { SERVICE_ROLE } from "@420ai/shared";
import { createDb } from "../index.js";
import { users, machines, memberships, alertFirings } from "../schema.js";
import {
  reconcileAlertFirings,
  reconcileDeploymentFirings,
  listAlertFirings,
  listDeploymentFirings,
  ackAlertFiring,
  deliverPendingFirings,
  deliverResolvedFirings,
  type FiringScope,
} from "./alert-firings.js";
import { ensurePersonalOrg } from "./organizations.js";

const TEST_URL = process.env.DATABASE_URL_TEST;

/** A fixed clock; firings are reconciled at explicit t0…t4 for determinism. */
const t0 = new Date("2026-06-15T12:00:00.000Z");
const t1 = new Date("2026-06-15T12:01:00.000Z");
const t2 = new Date("2026-06-15T12:02:00.000Z");
const t3 = new Date("2026-06-15T12:03:00.000Z");
const t4 = new Date("2026-06-15T12:04:00.000Z");

describe.skipIf(!TEST_URL)("alert-firings repository (integration)", () => {
  let dbh: ReturnType<typeof createDb>;
  let orgId: string;
  let userId: string;
  let machineId: string;
  /** M16 16.7 — a SECOND user in the SAME org. See `seedSecondMemberOfSameOrg`. */
  let userId2: string;
  /** M16 16.7 — a second ORG entirely, for the cross-tenant assertions. */
  let orgB: string;
  let userB: string;
  /** The org scope for `orgId`, spelled once. */
  let scope: FiringScope;

  beforeAll(() => {
    dbh = createDb(TEST_URL!);
  });

  afterAll(async () => {
    await dbh.pool.end();
  });

  beforeEach(async () => {
    await dbh.db.execute(
      sql`TRUNCATE alert_firings, machine_heartbeats, workspace_keys, workspaces, projects, raw_source_records, events, ingest_tokens, pairing_codes, machines, memberships, organizations, users RESTART IDENTITY CASCADE`,
    );
    const [u] = await dbh.db
      .insert(users)
      .values({ email: "test@example.com" })
      .returning({ id: users.id });
    userId = u!.id;
    orgId = await ensurePersonalOrg(dbh.db, userId, "test@example.com");
    scope = { kind: "org", orgId };
    const [m] = await dbh.db
      .insert(machines)
      .values({ orgId, userId, name: "laptop", os: "win32", hostname: "host-1" })
      .returning({ id: machines.id });
    machineId = m!.id;

    userId2 = await seedSecondMemberOfSameOrg("second@example.com");

    const [ub] = await dbh.db
      .insert(users)
      .values({ email: "orgb@example.com" })
      .returning({ id: users.id });
    userB = ub!.id;
    orgB = await ensurePersonalOrg(dbh.db, userB, "orgb@example.com");
  });

  /**
   * Seed a SECOND user into `orgId` — and MOVE their membership rather than INSERT one.
   *
   * THE M15 15.4 SEEDING TRAP, and this slice's central test is exactly the multi-user fixture that
   * springs it. `ensurePersonalOrg` auto-creates a personal `owner` membership for every user, and
   * `findPrincipalByEmail` resolves the FIRST membership by `(created_at, id)`. So adding a second
   * membership row pointing at `orgId` leaves the personal one in front of it: every assertion
   * would silently be testing a lone owner of their own org, i.e. the exact single-user shape this
   * slice exists to stop assuming. Moving the existing row is what actually puts them in one org.
   */
  async function seedSecondMemberOfSameOrg(email: string): Promise<string> {
    const [u2] = await dbh.db.insert(users).values({ email }).returning({ id: users.id });
    await ensurePersonalOrg(dbh.db, u2!.id, email);
    await dbh.db
      .update(memberships)
      .set({ orgId, role: "admin" })
      .where(eq(memberships.userId, u2!.id));
    // The move must be total — a leftover personal membership would shadow it.
    const rows = await dbh.db
      .select({ orgId: memberships.orgId })
      .from(memberships)
      .where(eq(memberships.userId, u2!.id));
    expect(rows.map((r) => r.orgId)).toEqual([orgId]);
    return u2!.id;
  }

  /** Build an offline-collector alert fixture for this machine. */
  function offlineAlert(): OperationalAlert {
    return {
      code: "collector.offline",
      severity: "critical",
      message: `Collector "laptop" is offline (no heartbeat for >5 min)`,
      machineId,
      machineName: "laptop",
      since: "2026-06-15T11:50:00.000Z",
    };
  }

  /** A DEPLOYMENT-scoped alert fixture — no machine, no connector, hence `alertKey` ends in `*`. */
  function catalogAlert(pending = 1): OperationalAlert {
    return {
      code: "catalog.update_requires_approval",
      severity: "warning",
      message: `${pending} signed pricing-catalog update(s) awaiting approval`,
      since: null,
    };
  }

  /** Count rows for a given alert_key IN THIS ORG (across statuses). */
  async function keyCount(alertKeyVal: string): Promise<number> {
    const rows = await dbh.db
      .select({ id: alertFirings.id })
      .from(alertFirings)
      .where(and(eq(alertFirings.orgId, orgId), eq(alertFirings.alertKey, alertKeyVal)));
    return rows.length;
  }

  /** Count DEPLOYMENT-scoped rows (`org_id IS NULL`) for a key, across statuses. */
  async function globalKeyCount(alertKeyVal: string): Promise<number> {
    const rows = await dbh.db
      .select({ id: alertFirings.id })
      .from(alertFirings)
      .where(and(isNull(alertFirings.orgId), eq(alertFirings.alertKey, alertKeyVal)));
    return rows.length;
  }

  it("opens a firing: status open, first_fired_at ≈ t0, acked_at null, derived alert_key", async () => {
    const firings = await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    expect(firings).toHaveLength(1);
    const f = firings[0]!;
    expect(f.status).toBe("open");
    expect(f.scope).toBe("org");
    expect(f.alertKey).toBe(`collector.offline:${machineId}`);
    expect(f.firstFiredAt).toBe(t0.toISOString());
    expect(f.lastSeenAt).toBe(t0.toISOString());
    expect(f.ackedAt).toBeNull();
    expect(f.resolvedAt).toBeNull();
    expect(f.machineId).toBe(machineId);
    expect(f.severity).toBe("critical");
  });

  it("idempotent re-fire: ONE row, first_fired_at unchanged, last_seen_at advances", async () => {
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    const after = await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t1);
    // The partial unique index holds: still exactly one row for the key.
    expect(await keyCount(`collector.offline:${machineId}`)).toBe(1);
    const f = after.find((x) => x.alertKey === `collector.offline:${machineId}`)!;
    expect(f.firstFiredAt).toBe(t0.toISOString()); // NOT overwritten (D4)
    expect(f.lastSeenAt).toBe(t1.toISOString()); // advanced
    expect(f.status).toBe("open");
  });

  it("resolve: reconciling [] resolves the open firing (notInArray([]) → true); a 2nd [] is a no-op", async () => {
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    const resolved = await reconcileAlertFirings(dbh.db, orgId, userId, [], t2);
    const f = resolved.find((x) => x.alertKey === `collector.offline:${machineId}`)!;
    expect(f.status).toBe("resolved");
    expect(f.resolvedAt).toBe(t2.toISOString());
    // A second reconcile with [] doesn't touch the already-resolved row.
    const again = await reconcileAlertFirings(dbh.db, orgId, userId, [], t3);
    const f2 = again.find((x) => x.alertKey === `collector.offline:${machineId}`)!;
    expect(f2.status).toBe("resolved");
    expect(f2.resolvedAt).toBe(t2.toISOString()); // still t2, not t3
  });

  it("re-fire after resolve: a NEW open row with a fresh first_fired_at (the resolved row stays)", async () => {
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    await reconcileAlertFirings(dbh.db, orgId, userId, [], t2); // resolve
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t3); // re-fire
    // Two rows now exist for the key: the resolved one + the new open one.
    expect(await keyCount(`collector.offline:${machineId}`)).toBe(2);
    const current = await listAlertFirings(dbh.db, orgId, t3);
    const open = current.find(
      (x) => x.alertKey === `collector.offline:${machineId}` && x.status === "open",
    )!;
    expect(open.firstFiredAt).toBe(t3.toISOString());
    expect(open.ackedAt).toBeNull();
  });

  it("ack: sets acked_at, stays open; an unknown id → undefined; another ORG's id → undefined", async () => {
    const [opened] = await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    const acked = await ackAlertFiring(dbh.db, orgId, opened!.id, t4);
    expect(acked).toBeDefined();
    expect(acked!.ackedAt).toBe(t4.toISOString());
    expect(acked!.status).toBe("open"); // ack does NOT resolve

    // Unknown id → undefined (which the route turns into 404, never 403 — no existence leak).
    expect(
      await ackAlertFiring(dbh.db, orgId, "00000000-0000-0000-0000-000000000000", t4),
    ).toBeUndefined();

    // M16 16.7: the scope that still refuses is the ORG, not the user. Another org cannot ack this
    // org's firing — that predicate is what remains after `userId` left the `where`.
    expect(await ackAlertFiring(dbh.db, orgB, opened!.id, t4)).toBeUndefined();
  });

  it("list window: a firing resolved beyond the resolved-window is excluded; an open one is always included", async () => {
    // Open + resolve at t0/t2.
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    await reconcileAlertFirings(dbh.db, orgId, userId, [], t2);
    // A `now` far past the resolved window (> 1h after t2) drops the resolved firing.
    const farLater = new Date(t2.getTime() + 2 * 60 * 60_000);
    const listed = await listAlertFirings(dbh.db, orgId, farLater);
    expect(listed.find((x) => x.alertKey === `collector.offline:${machineId}`)).toBeUndefined();

    // A still-open firing is always listed regardless of `now`.
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], farLater);
    const withOpen = await listAlertFirings(dbh.db, orgId, new Date(farLater.getTime() + 60_000));
    expect(
      withOpen.find((x) => x.alertKey === `collector.offline:${machineId}` && x.status === "open"),
    ).toBeDefined();
  });

  it("deliver-on-resolve: open→deliver→resolve→resolve-delivered EXACTLY once (M13 13.5)", async () => {
    const delivered: AlertFiring[] = [];
    const deliverer = { deliver: vi.fn(async (f: AlertFiring) => void delivered.push(f)) };

    // Open + deliver the open firing (stamps delivery_attempted_at).
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    await deliverPendingFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t1);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
    expect(delivered[0]!.status).toBe("open");

    // A resolve-delivery pass BEFORE resolution is a no-op (nothing resolved yet).
    await deliverResolvedFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t1);
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);

    // Resolve the firing (reconcile with []) then deliver the resolve notice — once.
    await reconcileAlertFirings(dbh.db, orgId, userId, [], t2);
    await deliverResolvedFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t3);
    expect(deliverer.deliver).toHaveBeenCalledTimes(2);
    expect(delivered[1]!.status).toBe("resolved");
    expect(delivered[1]!.resolvedAt).toBe(t2.toISOString());

    // A SECOND resolve-delivery pass is a no-op — resolve_delivered_at is now stamped.
    await deliverResolvedFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t4);
    expect(deliverer.deliver).toHaveBeenCalledTimes(2);

    // The resolve_delivered_at marker is set exactly once (at t3).
    const [row] = await dbh.db
      .select({ resolveDeliveredAt: alertFirings.resolveDeliveredAt })
      .from(alertFirings)
      .where(and(eq(alertFirings.orgId, orgId), eq(alertFirings.status, "resolved")));
    expect(row!.resolveDeliveredAt!.toISOString()).toBe(t3.toISOString());
  });

  it("deliver-on-resolve skips a firing whose OPEN state was never delivered", async () => {
    const deliverer = { deliver: vi.fn(async (_f: AlertFiring) => {}) };
    // Open then resolve WITHOUT ever calling deliverPendingFirings — delivery_attempted_at stays null.
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    await reconcileAlertFirings(dbh.db, orgId, userId, [], t2);
    await deliverResolvedFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t3);
    // No resolve notice for a firing that never emitted an open notice (no lone "resolved").
    expect(deliverer.deliver).not.toHaveBeenCalled();
  });

  it("deliver-on-resolve stamps + swallows a deliverer throw (at-most-once, best-effort)", async () => {
    const deliverer = {
      deliver: vi.fn(async (_f: AlertFiring) => {
        throw new Error("smtp down");
      }),
    };
    const logged: unknown[] = [];
    await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
    await deliverPendingFirings(
      dbh.db,
      scope,
      SERVICE_ROLE,
      { deliver: vi.fn(async () => {}) },
      t1,
    );
    await reconcileAlertFirings(dbh.db, orgId, userId, [], t2);
    // The throw is caught + logged, not propagated; the marker is still stamped (at-most-once).
    await deliverResolvedFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t3, (e) => logged.push(e));
    expect(logged).toHaveLength(1);
    const [row] = await dbh.db
      .select({ resolveDeliveredAt: alertFirings.resolveDeliveredAt })
      .from(alertFirings)
      .where(and(eq(alertFirings.orgId, orgId), eq(alertFirings.status, "resolved")));
    expect(row!.resolveDeliveredAt).not.toBeNull();
    // A re-run does NOT retry the failed delivery (marker already set).
    await deliverResolvedFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t4, (e) => logged.push(e));
    expect(deliverer.deliver).toHaveBeenCalledTimes(1);
  });

  it("connector firing: machine_id NULL, alert_key keyed on connector", async () => {
    const connectorAlert: OperationalAlert = {
      code: "connector.failing",
      severity: "warning",
      message: `Connector "claude-code" is failing (6/10 tool calls failed)`,
      connector: "claude-code",
      since: "2026-06-15T11:59:00.000Z",
    };
    const [f] = await reconcileAlertFirings(dbh.db, orgId, userId, [connectorAlert], t0);
    expect(f!.alertKey).toBe("connector.failing:claude-code");
    expect(f!.machineId).toBeNull();
    expect(f!.connector).toBe("claude-code");
  });

  /**
   * M16 16.7 — DEFECT 2: one condition, N members, N rows.
   *
   * The key was `(user_id, alert_key)`, and the dashboard reconciles as `principal.userId`. So an
   * `admin` or `viewer` opening the monitor opened a SECOND row for the same condition under their
   * own id — a second ack to perform and, with a deliverer wired, a second email. 16.6 made that
   * the DEFAULT rather than the exotic case, because the background tick guarantees the owner's row
   * always exists, so any non-owner viewer duplicates it.
   */
  describe("M16 16.7 — one org, one row (defect 2)", () => {
    it("two members reconciling the same alert produce ONE row", async () => {
      await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
      await reconcileAlertFirings(dbh.db, orgId, userId2, [offlineAlert()], t1);
      expect(await keyCount(`collector.offline:${machineId}`)).toBe(1);
    });

    it("the row keeps the OPENER's user_id — it is provenance, not a key (D-16.7-2)", async () => {
      await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
      await reconcileAlertFirings(dbh.db, orgId, userId2, [offlineAlert()], t1);
      const [row] = await dbh.db
        .select({ userId: alertFirings.userId, lastSeenAt: alertFirings.lastSeenAt })
        .from(alertFirings)
        .where(eq(alertFirings.orgId, orgId));
      // The SECOND caller updated the row (last_seen_at advanced) but did NOT take ownership of it.
      expect(row!.userId).toBe(userId);
      expect(row!.lastSeenAt.toISOString()).toBe(t1.toISOString());
    });

    it("both members see the SAME list", async () => {
      await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
      const a = await listAlertFirings(dbh.db, orgId, t1);
      const b = await listAlertFirings(dbh.db, orgId, t1);
      expect(a).toEqual(b);
      expect(a).toHaveLength(1);
    });

    it("EITHER member can ack it, and the other sees it acked", async () => {
      const [opened] = await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
      // The second member acks — impossible before 16.7, when the `where` carried `user_id`.
      const acked = await ackAlertFiring(dbh.db, orgId, opened!.id, t4);
      expect(acked?.ackedAt).toBe(t4.toISOString());
      const asSeenByOpener = await listAlertFirings(dbh.db, orgId, t4);
      expect(asSeenByOpener[0]!.ackedAt).toBe(t4.toISOString());
    });

    it("a DIFFERENT org still holds its own row for the same key (isolation preserved)", async () => {
      await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
      await reconcileAlertFirings(dbh.db, orgB, userB, [offlineAlert()], t1);
      const all = await dbh.db
        .select({ orgId: alertFirings.orgId })
        .from(alertFirings)
        .where(eq(alertFirings.alertKey, `collector.offline:${machineId}`));
      expect(all).toHaveLength(2);
      expect(new Set(all.map((r) => r.orgId))).toEqual(new Set([orgId, orgB]));
    });
  });

  /**
   * M16 16.7 — DEFECT 1: a deployment condition stored per-org.
   *
   * `catalog.update_requires_approval` and `ingest.auth_failure` derive from tables with no
   * `org_id`, so the 16.6 per-org tick opened one firing in EVERY org for one condition — and
   * `ensurePersonalOrg` makes org count track USER count.
   */
  describe("M16 16.7 — the deployment scope (defect 1)", () => {
    const CATALOG_KEY = "catalog.update_requires_approval:*";

    it("opens ONE row with org_id NULL and scope 'deployment'", async () => {
      const firings = await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      expect(firings).toHaveLength(1);
      expect(firings[0]!.scope).toBe("deployment");
      expect(firings[0]!.alertKey).toBe(CATALOG_KEY);
      expect(await globalKeyCount(CATALOG_KEY)).toBe(1);
    });

    it("a SECOND deployment reconcile updates rather than duplicating", async () => {
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert(1)], t0);
      await reconcileDeploymentFirings(dbh.db, userId2, [catalogAlert(4)], t1);
      expect(await globalKeyCount(CATALOG_KEY)).toBe(1);
      const [row] = await listDeploymentFirings(dbh.db, t1);
      expect(row!.message).toContain("4");
      expect(row!.firstFiredAt).toBe(t0.toISOString()); // never overwritten
    });

    it("EVERY org sees it — listAlertFirings unions the deployment rows", async () => {
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      for (const org of [orgId, orgB]) {
        const listed = await listAlertFirings(dbh.db, org, t1);
        const global = listed.find((f) => f.alertKey === CATALOG_KEY);
        expect(global, `org ${org} cannot see the deployment firing`).toBeDefined();
        expect(global!.scope).toBe("deployment");
      }
    });

    it("is ackable from ANY org — one row, one ack, universally visible", async () => {
      const [opened] = await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      // Acked under org B's context, though org B did not open it and does not own it.
      const acked = await ackAlertFiring(dbh.db, orgB, opened!.id, t4);
      expect(acked?.ackedAt).toBe(t4.toISOString());
      // …and org A sees the same row acked.
      const listedForA = await listAlertFirings(dbh.db, orgId, t4);
      expect(listedForA.find((f) => f.alertKey === CATALOG_KEY)!.ackedAt).toBe(t4.toISOString());
    });

    /**
     * D-16.7-3 AT THE DATA LAYER. `notInArray(alertKey, [])` resolves ALL open firings in scope, and
     * that "resolve everything" behaviour is exactly what would be catastrophic if the two scopes
     * overlapped: the deployment reconcile runs on a different schedule from every org's, so a
     * shared predicate would have each closing what the other opens, forever.
     */
    it("reconciling [] in the DEPLOYMENT scope resolves ONLY deployment rows", async () => {
      await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);
      await reconcileAlertFirings(dbh.db, orgB, userB, [offlineAlert()], t0);
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);

      await reconcileDeploymentFirings(dbh.db, userId, [], t2);

      // The deployment row resolved…
      const [global] = await listDeploymentFirings(dbh.db, t2);
      expect(global!.status).toBe("resolved");
      // …and BOTH orgs' rows are untouched.
      for (const org of [orgId, orgB]) {
        const orgRows = await dbh.db
          .select({ status: alertFirings.status })
          .from(alertFirings)
          .where(eq(alertFirings.orgId, org));
        expect(orgRows.map((r) => r.status)).toEqual(["open"]);
      }
    });

    it("reconciling [] in an ORG scope resolves ONLY that org's rows, never the deployment's", async () => {
      // The mirror image, and the one that would silently disable the two global codes: an org
      // reconcile that could reach `org_id IS NULL` rows would resolve the deployment firing on
      // every tick that did not happen to derive it.
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);

      await reconcileAlertFirings(dbh.db, orgId, userId, [], t2);

      const [global] = await listDeploymentFirings(dbh.db, t2);
      expect(global!.status).toBe("open");
    });

    it("a RESOLVED deployment firing does not block re-opening later (the partial index)", async () => {
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      await reconcileDeploymentFirings(dbh.db, userId, [], t2); // resolve
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t3); // re-open
      const open = (await listDeploymentFirings(dbh.db, t3)).filter((f) => f.status === "open");
      expect(open).toHaveLength(1);
      expect(open[0]!.firstFiredAt).toBe(t3.toISOString());
      expect(await globalKeyCount(CATALOG_KEY)).toBe(2); // the resolved one + the new open one
    });

    it("delivers ONCE for the whole deployment, and resolves once", async () => {
      const delivered: AlertFiring[] = [];
      const deliverer = { deliver: vi.fn(async (f: AlertFiring) => void delivered.push(f)) };
      const deploymentScope: FiringScope = { kind: "deployment" };

      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      await deliverPendingFirings(dbh.db, deploymentScope, SERVICE_ROLE, deliverer, t1);
      expect(deliverer.deliver).toHaveBeenCalledTimes(1);
      expect(delivered[0]!.scope).toBe("deployment");

      // A second pass claims nothing — 16.6's atomic claim, unchanged by the scope split.
      await deliverPendingFirings(dbh.db, deploymentScope, SERVICE_ROLE, deliverer, t2);
      expect(deliverer.deliver).toHaveBeenCalledTimes(1);

      await reconcileDeploymentFirings(dbh.db, userId, [], t2);
      await deliverResolvedFirings(dbh.db, deploymentScope, SERVICE_ROLE, deliverer, t3);
      expect(deliverer.deliver).toHaveBeenCalledTimes(2);
      expect(delivered[1]!.status).toBe("resolved");
    });

    it("an ORG delivery pass never claims the deployment row (and vice versa)", async () => {
      // If the delivery predicates overlapped, N orgs would each deliver the one deployment
      // condition — which is defect 1 wearing a different hat.
      const seen: AlertFiring[] = [];
      const deliverer = { deliver: vi.fn(async (f: AlertFiring) => void seen.push(f)) };
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      await reconcileAlertFirings(dbh.db, orgId, userId, [offlineAlert()], t0);

      await deliverPendingFirings(dbh.db, scope, SERVICE_ROLE, deliverer, t1);
      expect(seen.map((f) => f.scope)).toEqual(["org"]);

      await deliverPendingFirings(dbh.db, { kind: "deployment" }, SERVICE_ROLE, deliverer, t1);
      expect(seen.map((f) => f.scope)).toEqual(["org", "deployment"]);
    });

    /**
     * THE DB-ENFORCED SPLIT. Postgres suppresses conflicts only on the INFERRED arbiter index, so
     * an org-arbiter upsert against an existing global row is a hard error rather than a silent
     * duplicate. That is what makes "keep the two upserts separate" a database guarantee instead of
     * a reviewer's discipline — asserted here so nobody later "simplifies" it into a
     * `DO NOTHING` and turns the loud failure into a quiet duplicate.
     */
    it("crossing the arbiters RAISES rather than silently duplicating", async () => {
      await reconcileDeploymentFirings(dbh.db, userId, [catalogAlert()], t0);
      // Drizzle wraps the driver error, so the constraint name lives in the CAUSE chain rather
      // than the top-level message ("Failed query: insert into …"). Asserting on the chain is what
      // makes this test about the DATABASE's guarantee rather than about a statement failing for
      // any reason at all.
      const raised = await dbh.db
        .insert(alertFirings)
        .values({
          orgId: null,
          userId,
          alertKey: CATALOG_KEY,
          code: "catalog.update_requires_approval",
          severity: "warning",
          message: "second",
          since: null,
          status: "open",
          firstFiredAt: t1,
          lastSeenAt: t1,
        })
        .onConflictDoUpdate({
          // The ORG arbiter, against a row the GLOBAL index owns.
          target: [alertFirings.orgId, alertFirings.alertKey],
          targetWhere: sql`${alertFirings.status} = 'open' AND ${alertFirings.orgId} IS NOT NULL`,
          set: { message: "second" },
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(
        raised,
        "the crossed arbiter did NOT raise — the split is no longer DB-enforced",
      ).toBeDefined();
      const chain: string[] = [];
      for (let e: unknown = raised; e instanceof Error; e = e.cause) chain.push(e.message);
      expect(chain.join(" | ")).toMatch(/alert_firings_open_global_key/);
      expect(await globalKeyCount(CATALOG_KEY)).toBe(1);
    });
  });
});
