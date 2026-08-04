import { and, asc, desc, eq } from "drizzle-orm";
import type { DbClient } from "../client.js";
import { outcomeLabels, outcomeLabelRevisions } from "../schema.js";
import type { TaskType, LabelOutcome, Friction, LabelConfidence } from "@420ai/shared";

/**
 * M16 16.1 — the §4.3 OUTCOME LABEL repository (research plan §4.3 / §7 P0.2). Silent library
 * (CLAUDE.md): throws typed errors, never logs.
 *
 * `DbClient`, not `Db`, and here that is load-bearing rather than conventional. Every caller
 * reaches these from inside `withOrg`, which IS a transaction, and `updateOutcomeLabel` takes a
 * `FOR UPDATE` lock on the label row that only holds across the mutation if the read and the write
 * share one transaction. Taking a `Tx`-compatible type is what makes that true by type rather than
 * by convention. Do NOT call `withOrg` inside these functions — `insertReportArtifact` does, but
 * that is a deliberate exception for its retry loop, and there is no retry here.
 *
 * `orgId` IS ALWAYS THE SECOND PARAMETER (CLAUDE.md's 15.2 rule), so a transposed argument between
 * two adjacent `string` parameters is visible in review. It matters more than usual here:
 * `session_id` is a CONNECTOR-SUPPLIED, GLOBALLY-SCOPED string — two tenants can hold the same
 * value — so every read keyed on one merges tenants unless it also filters `orgId`. Unlike
 * `repositories/members.ts` there IS an RLS backstop behind a forgotten predicate (both tables are
 * STRICT, migration 0024), but the predicate is the primary defence and the backstop is a backstop.
 *
 * §7 P0.2's central claim — "a separately auditable record linked to a session, never a mutation of
 * a raw record or an event" — is a property of this file: nothing here touches `events`,
 * `raw_source_records` or any projection. `outcome-labels.int.test.ts` asserts that across the full
 * create/edit/delete lifecycle rather than assuming it.
 */

/** Thrown when a label mutation is refused. `app.ts` maps each reason to a status code. */
export class OutcomeLabelError extends Error {
  constructor(
    message: string,
    readonly reason: "already_labeled" | "not_found" | "not_author" | "incomplete_label",
  ) {
    super(message);
    this.name = "OutcomeLabelError";
  }
}

/**
 * One label's current state.
 *
 * NOTE `orgId` IS DELIBERATELY ABSENT. These rows reach `reply.send()` and no `apps/ingest` route
 * declares a Fastify `response` schema, so nothing strips extra properties — a bare `select()`
 * would put the tenant id on the wire, which is exactly how 15.1's `org_id` leaked into six
 * endpoints. Keep this interface == `outcomeLabelRowColumns` below.
 */
export interface OutcomeLabelRow {
  id: string;
  sessionId: string;
  authorUserId: string;
  /** `labeled` | `skipped` (D-16.1-2). A skip carries NULL in all six §4.3 fields. */
  status: string;
  taskType: string | null;
  intent: string | null;
  outcome: string | null;
  qualityRating: number | null;
  primaryFriction: string | null;
  followUpCommitOrPr: string | null;
  /** NULL means NOT STATED, deliberately distinct from `low` (D-16.1-8). */
  confidence: string | null;
  /** 1 at creation, +1 per edit. The snapshots are in `outcome_label_revisions`. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One immutable snapshot of a label, as it stood at `revision` (D-16.1-1). */
export interface OutcomeLabelRevisionRow {
  id: string;
  revision: number;
  authorUserId: string;
  status: string;
  taskType: string | null;
  intent: string | null;
  outcome: string | null;
  qualityRating: number | null;
  primaryFriction: string | null;
  followUpCommitOrPr: string | null;
  confidence: string | null;
  recordedAt: Date;
}

/** The columns an `OutcomeLabelRow` is made of. EXPLICIT — see the interface's note on `orgId`. */
const outcomeLabelRowColumns = {
  id: outcomeLabels.id,
  sessionId: outcomeLabels.sessionId,
  authorUserId: outcomeLabels.authorUserId,
  status: outcomeLabels.status,
  taskType: outcomeLabels.taskType,
  intent: outcomeLabels.intent,
  outcome: outcomeLabels.outcome,
  qualityRating: outcomeLabels.qualityRating,
  primaryFriction: outcomeLabels.primaryFriction,
  followUpCommitOrPr: outcomeLabels.followUpCommitOrPr,
  confidence: outcomeLabels.confidence,
  revision: outcomeLabels.revision,
  createdAt: outcomeLabels.createdAt,
  updatedAt: outcomeLabels.updatedAt,
};

/** The columns an `OutcomeLabelRevisionRow` is made of. Same rule: no `orgId`, no `labelId`. */
const outcomeLabelRevisionRowColumns = {
  id: outcomeLabelRevisions.id,
  revision: outcomeLabelRevisions.revision,
  authorUserId: outcomeLabelRevisions.authorUserId,
  status: outcomeLabelRevisions.status,
  taskType: outcomeLabelRevisions.taskType,
  intent: outcomeLabelRevisions.intent,
  outcome: outcomeLabelRevisions.outcome,
  qualityRating: outcomeLabelRevisions.qualityRating,
  primaryFriction: outcomeLabelRevisions.primaryFriction,
  followUpCommitOrPr: outcomeLabelRevisions.followUpCommitOrPr,
  confidence: outcomeLabelRevisions.confidence,
  recordedAt: outcomeLabelRevisions.recordedAt,
};

/**
 * The six §4.3 fields plus `confidence`, as stored. Every one is nullable because a `skipped` row
 * carries none of them (D-16.1-2).
 *
 * The required-when-`labeled` shape is therefore NOT a column constraint — no closed set in this
 * repo carries a CHECK — and it is enforced in exactly one place, `assertLabelShape`, which runs on
 * the MERGED row in both the create and the edit path. `CreateOutcomeLabelInput`'s discriminated
 * union and the route's JSON schema are the earlier, cheaper layers that catch most of it at
 * compile time and at the edge; neither can see a merged PATCH, which is why they are not the
 * enforcement.
 */
interface LabelFieldValues {
  taskType: TaskType | null;
  intent: string | null;
  outcome: LabelOutcome | null;
  qualityRating: number | null;
  primaryFriction: Friction | null;
  followUpCommitOrPr: string | null;
  confidence: LabelConfidence | null;
}

/**
 * What a caller may supply at CREATE time, discriminated on `status`.
 *
 * The union is the enforcement: a `labeled` create missing `outcome` is a COMPILE ERROR at every
 * internal call site, and a `skipped` create cannot carry a rating at all. That is the same
 * "enforcement in code, not in a constraint" trade the whole repo makes for closed sets.
 */
export type CreateOutcomeLabelInput =
  | { status: "skipped" }
  | {
      status: "labeled";
      taskType: TaskType;
      intent: string;
      outcome: LabelOutcome;
      qualityRating: number;
      primaryFriction: Friction;
      followUpCommitOrPr?: string | null;
      confidence?: LabelConfidence | null;
    };

/**
 * What a caller may change on an existing label. Every field optional; `undefined` means LEAVE
 * ALONE and `null` means CLEAR. The route's schema rejects an empty patch (`minProperties: 1`) so
 * an edit always produces a real revision rather than a no-op bump.
 *
 * BE PRECISE ABOUT WHICH FIELDS ARE ACTUALLY CLEARABLE, because an earlier version of this comment
 * was not and the review caught it: only `followUpCommitOrPr` and `confidence` accept `null` over
 * HTTP (`patchOutcomeLabelBodySchema` types them `["string","null"]`), and they are the two §4.3
 * marks OPTIONAL. The five required-when-`labeled` fields are `{type:"string"}` at the edge, so a
 * `null` for them is a 400 — and even if one got through, `assertLabelShape` would refuse it. That
 * is the intended shape rather than a limitation: clearing `outcome` on a row that still says
 * `labeled` would produce exactly the incoherent evidence this guard exists to prevent. To retract
 * a judgement, patch `status` to `skipped`, which clears all seven at once and keeps the prior
 * revision readable.
 *
 * `status` is patchable on purpose: a `skipped` label edited into a `labeled` one is the single
 * most interesting transition in this data ("I did go back and judge it"), and refusing it would
 * force a delete-and-recreate that destroys the history the revisions table exists to keep.
 */
export interface PatchOutcomeLabelInput {
  status?: "labeled" | "skipped";
  taskType?: TaskType | null;
  intent?: string | null;
  outcome?: LabelOutcome | null;
  qualityRating?: number | null;
  primaryFriction?: Friction | null;
  followUpCommitOrPr?: string | null;
  confidence?: LabelConfidence | null;
}

/**
 * True for the `outcome_labels_org_session` unique violation — i.e. "this session is already
 * labelled in this org", the D-16.1-3 conflict. Drizzle WRAPS the driver error, so the pg
 * `code`/`constraint` fields live on `.cause` (same shape as `reports.ts`'s `isVersionConflict`
 * and as asserted in `tenancy.int.test.ts`).
 *
 * Keyed on the CONSTRAINT NAME, not on `code === "23505"` alone: this transaction also writes the
 * revisions table, whose own unique index can raise 23505, and reporting that as "already
 * labelled" would be a confidently wrong answer to a concurrency bug.
 */
function isAlreadyLabeled(e: unknown): boolean {
  const c = (e as { cause?: { code?: string; constraint?: string } })?.cause;
  return c?.code === "23505" && c?.constraint === "outcome_labels_org_session";
}

/**
 * The field set a `skipped` row carries: nothing (D-16.1-2).
 *
 * A NAMED CONSTANT rather than an inline literal in `fieldsFromCreate`, because the CREATE path is
 * no longer the only writer that has to produce it — `updateOutcomeLabel` blanks a row the same way
 * when an edit turns a judgement back into a skip. Two hand-written copies of "all seven are null"
 * is exactly how one of them ends up with six.
 */
const EMPTY_LABEL_FIELDS: LabelFieldValues = {
  taskType: null,
  intent: null,
  outcome: null,
  qualityRating: null,
  primaryFriction: null,
  followUpCommitOrPr: null,
  confidence: null,
};

/**
 * The five §4.3 fields a `labeled` row MUST carry. `followUpCommitOrPr` and `confidence` are
 * deliberately absent: §4.3 marks the first optional and §7 P0.2 marks the second.
 */
const REQUIRED_WHEN_LABELED = [
  "taskType",
  "intent",
  "outcome",
  "qualityRating",
  "primaryFriction",
] as const;

/**
 * THE `labeled`/`skipped` INVARIANT, enforced on the MERGED ROW rather than on any one caller's
 * input. Throws `incomplete_label` when a row claiming to be `labeled` is missing a §4.3 field.
 *
 * IT LIVES HERE, AND THE REVIEW THAT FOUND IT MISSING IS THE REASON. 16.1 originally enforced this
 * only on the create path — the route checked the POST body and the discriminated
 * `CreateOutcomeLabelInput` made an incomplete create a compile error — while `updateOutcomeLabel`
 * merged `status` like any other field. Both directions were measured against a live database:
 *
 *   * `PATCH {"status":"skipped"}` on a judged session returned 200 with `outcome: "shipped"` and
 *     `qualityRating: 4` still set — a skip carrying a full judgement, which every per-outcome
 *     histogram in 16.4 would then count as an opinion the operator explicitly declined to give;
 *   * `PATCH {"status":"labeled"}` on a skipped session returned 200 with all five fields NULL — a
 *     row in the NUMERATOR of "sessions I judged" containing nothing a human decided. That one is
 *     worse, because the completion metric then reports a judgement that does not exist.
 *
 * Checking the PATCH BODY would not have fixed it: a partial edit of an already-complete label
 * legitimately sends one field. The invariant is a property of the ROW, so the merged state is the
 * only thing worth checking — and the repository is the only layer that knows it, which is also why
 * this guard is not in the route (the same argument `repositories/members.ts` makes for the
 * last-owner guard: it must hold for any future caller, including a script).
 */
function assertLabelShape(fields: LabelFieldValues, status: string): void {
  if (status !== "labeled") return;
  const missing = REQUIRED_WHEN_LABELED.filter(
    (k) => fields[k] === null || fields[k] === undefined,
  );
  if (missing.length > 0) {
    throw new OutcomeLabelError(
      `a labeled outcome requires: ${missing.join(", ")}`,
      "incomplete_label",
    );
  }
}

/** Normalize a create input into the full nullable field set a row (and its snapshot) carries. */
function fieldsFromCreate(input: CreateOutcomeLabelInput): LabelFieldValues {
  if (input.status === "skipped") {
    return { ...EMPTY_LABEL_FIELDS };
  }
  return {
    taskType: input.taskType,
    intent: input.intent,
    outcome: input.outcome,
    qualityRating: input.qualityRating,
    primaryFriction: input.primaryFriction,
    followUpCommitOrPr: input.followUpCommitOrPr ?? null,
    confidence: input.confidence ?? null,
  };
}

/**
 * Create the label for a session, at `revision: 1`, AND its v1 snapshot — in the caller's
 * transaction, so a label can never exist without the history row that records what it originally
 * said. Throws `OutcomeLabelError("…", "already_labeled")` when this `(org, session)` already
 * carries one (D-16.1-3: a second author is a 409, not a second row).
 *
 * The existence of the session is NOT checked here. There is no `sessions` table to FK against — a
 * session is a projection over `events` — so the guard is `sessionDetail` at the route, where it
 * belongs; see `routes/outcome-labels.ts`.
 */
export async function createOutcomeLabel(
  tx: DbClient,
  orgId: string,
  input: { sessionId: string; authorUserId: string } & CreateOutcomeLabelInput,
): Promise<OutcomeLabelRow> {
  const fields = fieldsFromCreate(input);
  // The SAME guard the edit path runs, against the same merged shape. `CreateOutcomeLabelInput`'s
  // discriminated union already makes an incomplete `labeled` create a compile error at every
  // INTERNAL call site, so this fires only for a caller that reached here across an untyped
  // boundary — which is precisely the route, whose body arrives as JSON. Cheap, and it means the
  // invariant has exactly one owner rather than one per entry point.
  assertLabelShape(fields, input.status);
  let row: OutcomeLabelRow;
  try {
    const [created] = await tx
      .insert(outcomeLabels)
      .values({
        orgId,
        sessionId: input.sessionId,
        authorUserId: input.authorUserId,
        status: input.status,
        ...fields,
        revision: 1,
      })
      .returning(outcomeLabelRowColumns);
    row = created as OutcomeLabelRow;
  } catch (e) {
    if (isAlreadyLabeled(e)) {
      throw new OutcomeLabelError("this session is already labelled", "already_labeled");
    }
    throw e;
  }

  await tx.insert(outcomeLabelRevisions).values({
    orgId,
    labelId: row.id,
    revision: 1,
    authorUserId: input.authorUserId,
    status: input.status,
    ...fields,
  });

  return row;
}

/**
 * The current label for one session in one org, or undefined.
 *
 * An unknown session and another org's session are deliberately INDISTINGUISHABLE — both yield
 * `undefined`, which the route turns into 404. Never 403: that would leak the existence of another
 * tenant's label (the same reasoning as `getReportArtifact`).
 */
export async function getOutcomeLabel(
  tx: DbClient,
  orgId: string,
  sessionId: string,
): Promise<OutcomeLabelRow | undefined> {
  const [row] = await tx
    .select(outcomeLabelRowColumns)
    .from(outcomeLabels)
    .where(and(eq(outcomeLabels.orgId, orgId), eq(outcomeLabels.sessionId, sessionId)))
    .limit(1);
  return row as OutcomeLabelRow | undefined;
}

/**
 * Edit a label: bump `revision`, write the merged state, and append a snapshot of the NEW state at
 * the new revision number.
 *
 * AUTHOR-ONLY (D-16.1-4), and no rung overrides it — not `admin`, not `owner`. A label is an
 * opinion with a name on it, 16.4 reads these rows as EVIDENCE, and rewriting someone else's answer
 * is falsification of ground truth rather than administration. (DELETE is different: retraction is
 * not rewriting, so `admin`+ may force one — see `deleteOutcomeLabel`.)
 *
 * THE `FOR UPDATE` LOCK IS WHAT SERIALISES THIS, NOT THE ENCLOSING TRANSACTION — the M15 15.5
 * lesson, and it applies verbatim. A plain `SELECT` takes NO locks under READ COMMITTED, so two
 * concurrent patches would both read `revision = 3`, both write 4, and both insert a v4 snapshot;
 * the `outcome_label_revisions_label_revision` unique index would turn one of them into a 500 and,
 * worse, the two labels' merged states would race. `FOR UPDATE` on the label row makes the second
 * transaction block and then re-read the bumped revision, so revisions stay contiguous by
 * construction. Naming the mechanism matters: "it's in a transaction" almost never is the reason.
 */
export async function updateOutcomeLabel(
  tx: DbClient,
  orgId: string,
  sessionId: string,
  authorUserId: string,
  patch: PatchOutcomeLabelInput,
): Promise<OutcomeLabelRow> {
  const [current] = await tx
    .select(outcomeLabelRowColumns)
    .from(outcomeLabels)
    .where(and(eq(outcomeLabels.orgId, orgId), eq(outcomeLabels.sessionId, sessionId)))
    .limit(1)
    .for("update");

  if (!current) throw new OutcomeLabelError("no label for this session", "not_found");
  const existing = current as OutcomeLabelRow;
  if (existing.authorUserId !== authorUserId) {
    throw new OutcomeLabelError("only the label's author may edit it", "not_author");
  }

  // `undefined` means LEAVE ALONE; `null` means CLEAR. Spreading `patch` directly would be wrong
  // in drizzle's `set()` — an explicit `undefined` key is dropped there, which happens to be the
  // behaviour we want, but the MERGED value is also what the snapshot must record, so the merge is
  // done here once and used for both.
  const status = patch.status ?? existing.status;
  const mergedFields: LabelFieldValues = {
    taskType:
      patch.taskType === undefined ? (existing.taskType as TaskType | null) : patch.taskType,
    intent: patch.intent === undefined ? existing.intent : patch.intent,
    outcome:
      patch.outcome === undefined ? (existing.outcome as LabelOutcome | null) : patch.outcome,
    qualityRating: patch.qualityRating === undefined ? existing.qualityRating : patch.qualityRating,
    primaryFriction:
      patch.primaryFriction === undefined
        ? (existing.primaryFriction as Friction | null)
        : patch.primaryFriction,
    followUpCommitOrPr:
      patch.followUpCommitOrPr === undefined
        ? existing.followUpCommitOrPr
        : patch.followUpCommitOrPr,
    confidence:
      patch.confidence === undefined
        ? (existing.confidence as LabelConfidence | null)
        : patch.confidence,
  };

  // TURNING A JUDGEMENT BACK INTO A SKIP CLEARS IT, rather than leaving the old answers attached to
  // a row that says nobody answered. A skip means "I declined to judge this session"; a skipped row
  // still carrying `outcome: shipped` is not a weaker statement, it is a contradictory one, and
  // 16.4 reads these as evidence. The blanking is deliberate DATA LOSS on the current row and it is
  // safe precisely because of D-16.1-1: every prior revision keeps its own snapshot, so the
  // judgement is still readable at `GET …/label/revisions` — it has been retracted, not erased.
  const merged =
    status === "skipped" ? { status, ...EMPTY_LABEL_FIELDS } : { status, ...mergedFields };
  // …and the other direction: a row claiming to be `labeled` must actually carry a judgement.
  assertLabelShape(merged, status);

  const nextRevision = existing.revision + 1;

  const [updated] = await tx
    .update(outcomeLabels)
    .set({ ...merged, revision: nextRevision, updatedAt: new Date() })
    .where(and(eq(outcomeLabels.orgId, orgId), eq(outcomeLabels.sessionId, sessionId)))
    .returning(outcomeLabelRowColumns);

  await tx.insert(outcomeLabelRevisions).values({
    orgId,
    labelId: existing.id,
    revision: nextRevision,
    authorUserId,
    ...merged,
  });

  return updated as OutcomeLabelRow;
}

/**
 * D-16.1-6 — HARD-delete a label and ALL of its revisions, in the caller's transaction. Returns
 * false when no row matched, or when the requester may not delete this one.
 *
 * THE ARCHIVE POLICY, stated here because this is the code that implements it: a DELETE removes the
 * label row and every revision row, retains nothing, and touches nothing else — the session's raw
 * records, events, reports and search documents are unaffected. That does not weaken this repo's
 * "raw records sacred" invariant, and the reason is the whole argument: a label is neither raw nor
 * derived. Raw records are permanent because they are captured evidence nobody can recreate; events
 * are disposable because they are re-derivable. A label is a third thing — volunteered human ground
 * truth — re-creatable only by the human who gave it, and therefore the one object in the archive
 * they are entitled to retract.
 *
 * `force` IS THE ADMIN LEVER (D-16.1-4). Retraction is not rewriting, so unlike editing this is not
 * author-only: an org admin needs a data-hygiene lever for a mis-scoped bulk label or a departed
 * colleague's rows. A plain `member` who is not the author gets `false` (→ 404 at the route) rather
 * than 403 — the label is not theirs, and saying "it exists but you may not touch it" tells them
 * about a colleague's judgement they have no claim to.
 *
 * REVISIONS FIRST: the FK is `ON DELETE no action` by this schema's convention, so the child rows
 * must go first. The cascade is deliberately visible HERE, in code, rather than hidden in DDL —
 * a reader of this function can see exactly what a delete destroys.
 */
export async function deleteOutcomeLabel(
  tx: DbClient,
  orgId: string,
  sessionId: string,
  opts: { requesterUserId: string; force: boolean },
): Promise<boolean> {
  const [row] = await tx
    .select({ id: outcomeLabels.id, authorUserId: outcomeLabels.authorUserId })
    .from(outcomeLabels)
    .where(and(eq(outcomeLabels.orgId, orgId), eq(outcomeLabels.sessionId, sessionId)))
    .limit(1);

  if (!row) return false;
  if (!opts.force && row.authorUserId !== opts.requesterUserId) return false;

  await tx
    .delete(outcomeLabelRevisions)
    .where(and(eq(outcomeLabelRevisions.orgId, orgId), eq(outcomeLabelRevisions.labelId, row.id)));
  const deleted = await tx
    .delete(outcomeLabels)
    .where(and(eq(outcomeLabels.orgId, orgId), eq(outcomeLabels.id, row.id)))
    .returning({ id: outcomeLabels.id });
  return deleted.length > 0;
}

/**
 * Every label in one org, most recently edited first, optionally filtered and paged.
 *
 * ORG-SCOPED AT THE REPOSITORY, NOT USER-SCOPED, and that is D-15.4-2 applied: every member sees
 * every project and machine in their org, and 16.4's completion aggregate needs the whole org's
 * rows. A per-author filter would make the audit's denominator wrong by construction.
 *
 * `limit`/`offset` apply ONLY when provided — an omitted limit returns the full list, mirroring
 * `listReportArtifacts`. The `id` tiebreaker keeps offset pages deterministic when two labels share
 * an `updatedAt`.
 */
export async function listOutcomeLabels(
  tx: DbClient,
  orgId: string,
  filter?: {
    status?: string;
    outcome?: string;
    taskType?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
  },
): Promise<OutcomeLabelRow[]> {
  const conditions = [eq(outcomeLabels.orgId, orgId)];
  if (filter?.status) conditions.push(eq(outcomeLabels.status, filter.status));
  if (filter?.outcome) conditions.push(eq(outcomeLabels.outcome, filter.outcome));
  if (filter?.taskType) conditions.push(eq(outcomeLabels.taskType, filter.taskType));
  if (filter?.sessionId) conditions.push(eq(outcomeLabels.sessionId, filter.sessionId));
  const query = tx
    .select(outcomeLabelRowColumns)
    .from(outcomeLabels)
    .where(and(...conditions))
    .orderBy(desc(outcomeLabels.updatedAt), desc(outcomeLabels.id))
    .$dynamic();
  if (filter?.limit !== undefined) query.limit(filter.limit);
  if (filter?.offset !== undefined) query.offset(filter.offset);
  const rows = await query;
  return rows as OutcomeLabelRow[];
}

/**
 * The full edit history of one session's label, oldest revision first. Empty when there is no
 * label (the route 404s on the label itself first, so an empty list here means the label exists and
 * somehow has no snapshots — which `createOutcomeLabel` makes unrepresentable).
 *
 * The join carries an org predicate on BOTH sides. `outcome_label_revisions.org_id` alone gives
 * ISOLATION; the predicate on the LABEL is what gives OWNERSHIP — without it, org B asking for org
 * A's session id would get an empty list rather than a wrong one, but the join would be scoped by
 * a connector-supplied string alone, which is the 15.2 shape this repo has been bitten by twice.
 */
export async function listOutcomeLabelRevisions(
  tx: DbClient,
  orgId: string,
  sessionId: string,
): Promise<OutcomeLabelRevisionRow[]> {
  const rows = await tx
    .select(outcomeLabelRevisionRowColumns)
    .from(outcomeLabelRevisions)
    .innerJoin(outcomeLabels, eq(outcomeLabels.id, outcomeLabelRevisions.labelId))
    .where(
      and(
        eq(outcomeLabelRevisions.orgId, orgId),
        eq(outcomeLabels.orgId, orgId),
        eq(outcomeLabels.sessionId, sessionId),
      ),
    )
    .orderBy(asc(outcomeLabelRevisions.revision));
  return rows as OutcomeLabelRevisionRow[];
}
