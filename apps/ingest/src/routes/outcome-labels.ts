import type { FastifyInstance } from "fastify";
import {
  createOutcomeLabel,
  deleteOutcomeLabel,
  getOutcomeLabel,
  listOutcomeLabelRevisions,
  listOutcomeLabels,
  sessionDetail,
  updateOutcomeLabel,
  withOrg,
  type CreateOutcomeLabelInput,
  type OutcomeLabelRow,
  type PatchOutcomeLabelInput,
} from "@420ai/db";
import {
  redactJson,
  toCsv,
  toJsonl,
  REDACTION_VERSION,
  type ExportManifest,
  type Friction,
  type LabelConfidence,
  type LabelOutcome,
  type LabelStatus,
  type TaskType,
} from "@420ai/shared";
import {
  createOutcomeLabelBodySchema,
  exportOutcomeLabelsQuerySchema,
  listOutcomeLabelsQuerySchema,
  patchOutcomeLabelBodySchema,
} from "../schemas.js";
import { resolvePrincipal, authorized } from "../auth.js";

/**
 * M16 16.1 — the §4.3 OUTCOME LABEL API (research plan §4.3 / §7 P0.2). Seven handlers, each
 * principal-authed, `authorized()`-gated and `withOrg`-wrapped.
 *
 * WHAT THIS SURFACE IS FOR. Automatic capture answers what happened; it cannot answer whether the
 * work was useful. These routes are how a human volunteers that answer — as a SEPARATE, separately
 * auditable record linked to a session, never as a mutation of a raw record or an event. Nothing
 * here writes to `events`, `raw_source_records` or any projection; the only read of them is the
 * existence guard below.
 *
 * THE ROLE PASSED TO `withOrg` IS `principal.role`, NEVER `SERVICE_ROLE`. Labelling is the caller's
 * OWN act — the 15.4 "whose action is this?" test answers "the person typing it" — so the 0016
 * RESTRICTIVE backstop is a genuine second layer here rather than an obstacle. A `viewer` reaching
 * a write path is stopped by the route gate FIRST; the RLS rejection behind it is the backstop, not
 * the primary defence. That asymmetry matters for DELETE in particular: Postgres has no `WITH
 * CHECK` for DELETE, so a policy-blocked delete is a silent `DELETE 0` with a 204 on top. The route
 * gate is the only layer that can be loud, which is why it must be complete rather than merely
 * present.
 *
 * ROLE GATES (D-16.1-4): reads/list/export at `viewer`, writes at `member`, and DELETE takes
 * `force` from `authorized(principal, "admin")`. Reads are org-scoped rather than author-scoped
 * (D-15.4-2 — every member sees every project and machine in their org), because 16.4's aggregate
 * needs the whole org's rows.
 */

/** CSV is row-flat; a label already is, so this is the column ORDER rather than a flattening. */
const LABEL_CSV_COLUMNS = [
  "id",
  "sessionId",
  "authorUserId",
  "status",
  "taskType",
  "intent",
  "outcome",
  "qualityRating",
  "primaryFriction",
  "followUpCommitOrPr",
  "confidence",
  "revision",
  "createdAt",
  "updatedAt",
] as const;

/** Keep a scope value safe for a `Content-Disposition` filename (mirrors `routes/exports.ts`). */
function safeScopeKey(value: string | undefined): string {
  if (!value) return "all";
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
}

/** `Date` columns → ISO on the wire, so an export and an in-app read agree on the format. */
function serializeLabel(row: OutcomeLabelRow): Record<string, unknown> {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * The POST body AS IT ARRIVES — every §4.3 field optional and the closed sets typed as bare
 * strings, because that is what the wire actually carries. The narrowing happens once, below, after
 * ajv has already constrained each value to its enum; re-deriving these from the shared unions here
 * would claim a guarantee the type system cannot make about an untrusted request.
 */
interface LabelBody {
  status: LabelStatus;
  taskType?: TaskType;
  intent?: string;
  outcome?: LabelOutcome;
  qualityRating?: number;
  primaryFriction?: Friction;
  followUpCommitOrPr?: string;
  confidence?: LabelConfidence;
}

export default async function outcomeLabelRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/sessions/:sessionId/label — record a label, or a SKIP (D-16.1-2).
   *
   * THE EXISTENCE GUARD IS A WRITE-PATH GUARD EVEN THOUGH NO CONSTRAINT REQUIRES ONE, and that is
   * exactly why it needs a comment: there is no `sessions` table, so `session_id` carries no FK and
   * a bogus id CANNOT raise a database error. Without this check a typo'd or hostile id would
   * create a permanent ORPHAN label — a row counted by 16.4's completion metric whose denominator
   * has no matching session, i.e. silent corruption of the one number this milestone exists to make
   * trustworthy. Do not "simplify" it away on the grounds that nothing enforces it.
   *
   * `isUuid` IS DELIBERATELY NOT USED on `sessionId`: it is a connector-supplied string, not a uuid
   * (`routes/reports.ts` makes the same note for `/v1/sessions/:sessionId/reports`). The guard is
   * `sessionDetail`, not a format check.
   */
  app.post<{ Params: { sessionId: string }; Body: LabelBody }>(
    "/v1/sessions/:sessionId/label",
    { schema: { body: createOutcomeLabelBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const { sessionId } = request.params;
      const body = request.body;

      // The required-when-`labeled` shape, checked HERE rather than with an ajv `if/then` so the
      // 400 names the missing field. `followUpCommitOrPr` and `confidence` stay optional (§4.3
      // marks the first optional; §7 P0.2 marks the second).
      if (body.status === "labeled") {
        const missing = (
          ["taskType", "intent", "outcome", "qualityRating", "primaryFriction"] as const
        ).filter((k) => body[k] === undefined);
        if (missing.length > 0) {
          return reply
            .code(400)
            .send({ error: `a labeled outcome requires: ${missing.join(", ")}` });
        }
      }

      const outcome = await withOrg(app.db, principal.orgId, principal.role, async (tx) => {
        const session = await sessionDetail(tx, principal.orgId, sessionId);
        if (session.eventCount === 0) return "no_such_session" as const;
        // The discriminated union is reconstructed rather than spread, so the repository's
        // compile-time guarantee survives the untyped wire boundary.
        const input: CreateOutcomeLabelInput =
          body.status === "skipped"
            ? { status: "skipped" }
            : {
                status: "labeled",
                // The non-null assertions are earned by the `missing` check above, which is why
                // that check is a 400 rather than a silent default — a defaulted `outcome` would
                // put a value no human chose into the one table 16.4 reads as ground truth.
                taskType: body.taskType!,
                intent: body.intent!,
                outcome: body.outcome!,
                qualityRating: body.qualityRating!,
                primaryFriction: body.primaryFriction!,
                followUpCommitOrPr: body.followUpCommitOrPr ?? null,
                confidence: body.confidence ?? null,
              };
        return createOutcomeLabel(tx, principal.orgId, {
          sessionId,
          // D-16.1-8 — the author is ALWAYS the request principal. There is no service-role write
          // path anywhere in this slice, which makes "a label no human authored" unrepresentable
          // rather than merely unset: the strongest available form of §5.3's guarantee.
          authorUserId: principal.userId,
          ...input,
        });
      });

      if (outcome === "no_such_session") {
        return reply.code(404).send({ error: "no such session" });
      }
      // `already_labeled` throws `OutcomeLabelError` and is mapped to 409 in app.ts (D-16.1-3:
      // a second author is a conflict, not a second row).
      return reply.code(201).send({ label: serializeLabel(outcome) });
    },
  );

  // ── GET /v1/sessions/:sessionId/label — the current label. `viewer`: reading a colleague's
  //    judgement of a session is not a privileged act within an org (D-15.4-2), and 16.2's review
  //    table needs it for a read-only account.
  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/label",
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const row = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        getOutcomeLabel(tx, principal.orgId, request.params.sessionId),
      );
      // An unknown session and another org's session are deliberately indistinguishable — both 404.
      // Never 403, which would leak the existence of another tenant's label.
      if (!row) return reply.code(404).send({ error: "no label for this session" });
      // NOT redacted, on purpose: this is an authenticated in-app read by the label's own org,
      // exactly like `GET /v1/reports/:id` — whose `/export` sibling redacts while it does not
      // (D-16.1-7). The export route below is where the §18 gate applies.
      return reply.code(200).send({ label: serializeLabel(row) });
    },
  );

  /**
   * PATCH /v1/sessions/:sessionId/label — edit a label; bumps `revision` and appends a snapshot.
   *
   * AUTHOR-ONLY, and no rung overrides it (D-16.1-4). The repository throws `not_author`, which
   * app.ts maps to 403 — a deliberate contrast with DELETE's 404 for the same situation. The
   * difference is what the two answers admit to: refusing an EDIT tells the author of a label that
   * their answer is protected, whereas a non-author DELETE has no claim on the row at all.
   */
  app.patch<{ Params: { sessionId: string }; Body: PatchOutcomeLabelInput }>(
    "/v1/sessions/:sessionId/label",
    { schema: { body: patchOutcomeLabelBodySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const row = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        updateOutcomeLabel(
          tx,
          principal.orgId,
          request.params.sessionId,
          principal.userId,
          request.body,
        ),
      );
      return reply.code(200).send({ label: serializeLabel(row) });
    },
  );

  /**
   * DELETE /v1/sessions/:sessionId/label — D-16.1-6, the archive policy for labels.
   *
   * A HARD delete of the label row and ALL of its revision rows, in one transaction. Nothing is
   * retained and nothing else is touched: the session's raw records, events, reports and search
   * documents are unaffected. This is the FIRST deletable object in the archive, and it does not
   * weaken "raw records sacred" — a label is neither raw nor derived but volunteered human ground
   * truth, re-creatable only by the person who gave it, and therefore the one thing they may
   * retract.
   *
   * `force` IS THE ADMIN LEVER: retraction is not rewriting, so unlike PATCH this is not
   * author-only. An org admin needs a data-hygiene lever (a mis-scoped bulk label, a departed
   * colleague's rows). A plain `member` who is not the author gets 404, not 403 — the row is not
   * theirs, and confirming it exists would tell them about a colleague's judgement.
   */
  app.delete<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/label",
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "member")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const deleted = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        deleteOutcomeLabel(tx, principal.orgId, request.params.sessionId, {
          requesterUserId: principal.userId,
          force: authorized(principal, "admin"),
        }),
      );
      if (!deleted) return reply.code(404).send({ error: "no label for this session" });
      return reply.code(204).send();
    },
  );

  // ── GET /v1/sessions/:sessionId/label/revisions — the edit history (D-16.1-1). This is what
  //    makes §7 P0.2's "preserve … edits" a record rather than a claim: v1 is the label as first
  //    given, so a rating revised upward a week later is visible AS a revision — the hindsight
  //    §4.3's "what success meant before hindsight" exists to guard against.
  app.get<{ Params: { sessionId: string } }>(
    "/v1/sessions/:sessionId/label/revisions",
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const revisions = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        listOutcomeLabelRevisions(tx, principal.orgId, request.params.sessionId),
      );
      return reply.code(200).send({
        revisions: revisions.map((r) => ({ ...r, recordedAt: r.recordedAt.toISOString() })),
      });
    },
  );

  // ── GET /v1/labels — the org's labels, newest edit first, filtered and paged. 16.2's review
  //    table and 16.4's audit both read this.
  app.get<{
    Querystring: {
      status?: string;
      outcome?: string;
      taskType?: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
    };
  }>(
    "/v1/labels",
    { schema: { querystring: listOutcomeLabelsQuerySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const rows = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        listOutcomeLabels(tx, principal.orgId, request.query),
      );
      return reply.code(200).send({ labels: rows.map(serializeLabel) });
    },
  );

  /**
   * GET /v1/labels/export — json | jsonl | csv, REDACTED (D-16.1-7).
   *
   * The §18 gate applies here and not to the reads above, and the reason is the field rather than
   * the route: `intent` is 200 characters of free human text and `followUpCommitOrPr` is a URL a
   * person pasted. Either may carry a token, a credentialed URL or a customer name that the person
   * typing it never thought of as leaving the archive. `redactJson` before any bytes leave, the
   * same `X-Export-*` headers and the same manifest shape as the three M10 export routes.
   *
   * No `EXPORT_MAX_ROWS` cap and therefore no `truncated: true` case: labels are bounded by the
   * number of sessions a human volunteered an opinion on — a few hundred over the research period,
   * against `exportEvents`'s millions. `truncated` is still emitted as `false` so the manifest shape
   * stays uniform and a future cap has somewhere honest to report itself.
   */
  app.get<{
    Querystring: {
      format: "json" | "jsonl" | "csv";
      status?: string;
      outcome?: string;
      taskType?: string;
      sessionId?: string;
    };
  }>(
    "/v1/labels/export",
    { schema: { querystring: exportOutcomeLabelsQuerySchema } },
    async (request, reply) => {
      const principal = await resolvePrincipal(app, request);
      if (!principal) {
        return reply.code(401).send({ error: "admin authorization required" });
      }
      if (!authorized(principal, "viewer")) {
        return reply.code(403).send({ error: "insufficient role" });
      }
      const { format, status, outcome, taskType, sessionId } = request.query;
      // The RLS context wraps ONLY the DB read — redaction and serialization stay outside it, so a
      // transaction never spans CPU-bound work (the `routes/exports.ts` rule).
      const rows = await withOrg(app.db, principal.orgId, principal.role, (tx) =>
        listOutcomeLabels(tx, principal.orgId, { status, outcome, taskType, sessionId }),
      );

      const { value: redacted, findings } = redactJson(rows.map(serializeLabel));
      const exportedAt = new Date().toISOString();
      const manifest: ExportManifest = {
        exportedAt,
        subject: "labels",
        format,
        scope: { status, outcome, taskType, sessionId },
        redactionVersion: REDACTION_VERSION,
        rowCount: redacted.length,
        truncated: false,
        redactionFindings: findings,
      };

      let body: string;
      if (format === "json") {
        body = JSON.stringify({ manifest, rows: redacted });
      } else if (format === "jsonl") {
        body = toJsonl(redacted);
      } else {
        body = toCsv(redacted, LABEL_CSV_COLUMNS);
      }

      const stamp = exportedAt.replace(/:/g, "-");
      const scopeKey = safeScopeKey(sessionId ?? status ?? outcome ?? taskType);
      reply.header(
        "content-disposition",
        `attachment; filename="420ai-labels-${scopeKey}-${stamp}.${format}"`,
      );
      reply.header("x-export-row-count", String(redacted.length));
      reply.header("x-export-truncated", "false");
      reply.header("x-export-redaction-version", REDACTION_VERSION);
      const contentType =
        format === "json"
          ? "application/json"
          : format === "jsonl"
            ? "application/x-ndjson"
            : "text/csv";
      return reply.type(contentType).send(body);
    },
  );
}
