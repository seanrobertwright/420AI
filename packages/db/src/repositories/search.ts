import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  redact,
  REDACTION_VERSION,
  type ReindexCounts,
  type SearchEntityType,
  type SearchResults,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import { decryptField } from "../crypto.js";
import {
  searchDocuments as searchDocumentsTbl,
  reportArtifacts,
  projects,
  workspaces,
  workspaceKeys,
  events,
  rawSourceRecords,
  machines,
} from "../schema.js";

/**
 * M12 §21 redacted search projection repository.
 *
 *   - `rebuildSearchIndex(db)` — the admin-triggered FULL rebuild. Deletes every
 *     `search_documents` row, then re-materializes from reports + projects +
 *     sessions. SESSION content is the ONLY decrypt path here (mirrors
 *     `transcript.ts` / `exports.ts`@304): each raw record is `decryptField`-ed,
 *     the concatenation `redact()`-ed, and only the MASKED text is stored. Every
 *     string written (titles included) passes `redact()` first — search snippets
 *     leave the archive, so this is the §18 gate for this surface. Each row stamps
 *     `REDACTION_VERSION` (§23).
 *
 *   - `indexSessions(db, sessionIds)` / `indexProjectDoc` / `indexReportDoc` —
 *     M13 13.4 INCREMENTAL maintenance: the same doc builds scoped to the entities
 *     a mutation just touched, upserting on the `(entity_type, entity_id)` unique
 *     index. Callers (ingest/project/report routes) invoke them best-effort AFTER
 *     their write transaction — index maintenance must never fail the write path.
 *
 *   - `searchDocuments(db, opts)` — the `websearch_to_tsquery` + `ts_rank` read.
 *     The user query is a BOUND param (`websearch_to_tsquery` sanitizes it); the
 *     `'english'` regconfig is a constant literal in the SQL, never a param.
 *
 * Silent library (CLAUDE.md): throws on a decrypt/key error (the AES-GCM tag
 * fails loudly), never logs. The query fn is named `searchDocuments`; the TABLE is
 * imported as `searchDocumentsTbl` so the two never collide.
 */

/**
 * Total decrypted chars per session document. Mirrors the spirit of
 * `DEFAULT_TRANSCRIPT_CAPS.maxTotalChars` — a session's full raw bytes can reach
 * multiple MB, but the searchable signal is the first tens of KB. Capping bounds
 * both the index size and the decrypt work per reindex.
 */
const SESSION_BODY_MAX_CHARS = 48000;

/** A doc to (re-)materialize. `title`/`body` are ALREADY redacted by the caller. */
interface DocInput {
  userId: string;
  entityType: SearchEntityType;
  entityId: string;
  projectId: string | null;
  title: string | null;
  body: string;
}

/**
 * Upsert one document on the `(entity_type, entity_id)` unique index. After the
 * wholesale delete a plain insert would suffice, but the upsert keeps the rebuild
 * idempotent even if an entity somehow appears twice — and NEVER touches
 * `search_vector` (GENERATED; an explicit write errors).
 */
async function upsertDoc(db: DbClient, doc: DocInput): Promise<void> {
  await db
    .insert(searchDocumentsTbl)
    .values({
      userId: doc.userId,
      entityType: doc.entityType,
      entityId: doc.entityId,
      projectId: doc.projectId,
      title: doc.title,
      body: doc.body,
      redactionVersion: REDACTION_VERSION,
    })
    .onConflictDoUpdate({
      target: [searchDocumentsTbl.entityType, searchDocumentsTbl.entityId],
      set: {
        userId: doc.userId,
        projectId: doc.projectId,
        title: doc.title,
        body: doc.body,
        redactionVersion: REDACTION_VERSION,
        indexedAt: new Date(),
      },
    });
}

/**
 * Build the report doc: all plaintext (derived metrics only), but redact
 * defensively — `redact()` is idempotent, and a path/name in the markdown could
 * carry a home-dir username. title = report_type, body = redacted markdown.
 */
function reportDoc(r: {
  id: string;
  userId: string;
  projectId: string | null;
  reportType: string;
  markdown: string;
}): DocInput {
  return {
    userId: r.userId,
    entityType: "report",
    entityId: r.id,
    projectId: r.projectId,
    title: redact(r.reportType).redacted,
    body: redact(r.markdown).redacted,
  };
}

/**
 * Build the project doc: name + remote + every mapped workspace root path (paths
 * leak home-dir usernames → redact). entityId = projectId = the project uuid.
 */
function projectDoc(
  p: { id: string; userId: string; name: string; gitRemote: string | null },
  rootPaths: string[],
): DocInput {
  const parts = [p.name, p.gitRemote, ...rootPaths].filter((s): s is string => Boolean(s));
  return {
    userId: p.userId,
    entityType: "project",
    entityId: p.id,
    projectId: p.id,
    title: redact(p.name).redacted,
    body: redact(parts.join(" ")).redacted,
  };
}

/** Session meta: the identity row the doc build needs, one per distinct sessionId. */
interface SessionMetaRow {
  sessionId: string;
  sourceConnector: string;
  userId: string;
}

/**
 * Build + upsert ONE session doc. Content comes from the session's raw records
 * (decrypt → cap → redact); projectId via the M5 attribution join (null when
 * unattributed — never blocks indexing).
 */
async function indexOneSession(db: DbClient, s: SessionMetaRow): Promise<void> {
  // Resolve the session's project via the M5 attribution join (best-effort).
  const [attr] = await db
    .select({ projectId: workspaces.projectId })
    .from(events)
    .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
    .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
    .where(eq(events.sessionId, s.sessionId))
    .limit(1);
  const projectId = attr?.projectId ?? null;

  // Read + decrypt the session's verbatim raw records, ordered, capped.
  const rawRows = await db
    .select({
      ciphertext: rawSourceRecords.payloadCiphertext,
      iv: rawSourceRecords.payloadIv,
      tag: rawSourceRecords.payloadTag,
    })
    .from(rawSourceRecords)
    .where(eq(rawSourceRecords.sessionId, s.sessionId))
    .orderBy(asc(rawSourceRecords.ingestedAt));

  let combined = "";
  for (const rr of rawRows) {
    if (combined.length >= SESSION_BODY_MAX_CHARS) break;
    // decryptField throws on a key/tag error — let it propagate (silent library).
    const plaintext = decryptField({ ciphertext: rr.ciphertext, iv: rr.iv, tag: rr.tag });
    combined += combined ? `\n${plaintext}` : plaintext;
  }
  if (combined.length > SESSION_BODY_MAX_CHARS) {
    combined = combined.slice(0, SESSION_BODY_MAX_CHARS);
  }

  // §18 gate: redact the decrypted concatenation BEFORE storing it.
  await upsertDoc(db, {
    userId: s.userId,
    entityType: "session",
    entityId: s.sessionId,
    projectId,
    title: redact(`${s.sourceConnector} · ${s.sessionId}`).redacted,
    body: redact(combined).redacted,
  });
}

/**
 * Cap on ids per `inArray` — each id is a bound param and the PG wire protocol
 * tops out at 65,535 per statement; a full rebuild passes EVERY session id
 * through here, so the meta lookup runs in bounded chunks.
 */
const INDEX_SESSIONS_CHUNK = 500;

/**
 * Incrementally (re-)index the given sessions (M13 13.4). One doc per distinct
 * sessionId — `min()` aggregates pick a representative connector/user so the
 * result is EXACTLY one row per session (the (entity_type, entity_id) unique
 * index forbids two). Unknown session ids (no raw records yet) are skipped.
 * Returns the number of session docs upserted.
 */
export async function indexSessions(db: DbClient, sessionIds: string[]): Promise<number> {
  const ids = [...new Set(sessionIds)];
  let indexed = 0;

  for (let i = 0; i < ids.length; i += INDEX_SESSIONS_CHUNK) {
    const sessionMeta = await db
      .select({
        sessionId: rawSourceRecords.sessionId,
        sourceConnector: sql<string>`min(${rawSourceRecords.sourceConnector})`,
        userId: sql<string>`min(${machines.userId}::text)`,
      })
      .from(rawSourceRecords)
      .innerJoin(machines, eq(machines.id, rawSourceRecords.machineId))
      .where(inArray(rawSourceRecords.sessionId, ids.slice(i, i + INDEX_SESSIONS_CHUNK)))
      .groupBy(rawSourceRecords.sessionId);

    for (const s of sessionMeta) {
      await indexOneSession(db, s);
    }
    indexed += sessionMeta.length;
  }
  return indexed;
}

/**
 * Incrementally (re-)index one project's doc (M13 13.4 — call after
 * create/rename). No-op when the project does not exist.
 */
export async function indexProjectDoc(db: DbClient, projectId: string): Promise<void> {
  const [p] = await db
    .select({
      id: projects.id,
      userId: projects.userId,
      name: projects.name,
      gitRemote: projects.gitRemote,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!p) return;
  const wsRows = await db
    .select({ rootPath: workspaces.rootPath })
    .from(workspaces)
    .where(eq(workspaces.projectId, p.id));
  await upsertDoc(
    db,
    projectDoc(
      p,
      wsRows.map((w) => w.rootPath),
    ),
  );
}

/**
 * Incrementally index one report artifact's doc (M13 13.4 — call after
 * `insertReportArtifact` returns). No-op when the artifact does not exist.
 */
export async function indexReportDoc(db: DbClient, reportId: string): Promise<void> {
  const [r] = await db
    .select({
      id: reportArtifacts.id,
      userId: reportArtifacts.userId,
      projectId: reportArtifacts.projectId,
      reportType: reportArtifacts.reportType,
      markdown: reportArtifacts.markdown,
    })
    .from(reportArtifacts)
    .where(eq(reportArtifacts.id, reportId))
    .limit(1);
  if (!r) return;
  await upsertDoc(db, reportDoc(r));
}

/**
 * Full rebuild of the redacted search index. Delete-then-rebuild from the three
 * sources; returns per-entity counts. Idempotent (re-running yields the same rows
 * — the unique index holds).
 *
 * ATOMIC: the delete + every re-insert run in ONE transaction (mirrors
 * ingest.ts/reports.ts), so a mid-rebuild failure (e.g. a decrypt/key error in the
 * session loop) rolls back and leaves the PREVIOUS index fully intact — a partial
 * index is never observable. `DbClient` supports `.transaction` (nested → savepoint).
 */
export async function rebuildSearchIndex(db: DbClient): Promise<ReindexCounts> {
  return db.transaction(async (tx) => {
    await tx.delete(searchDocumentsTbl);

    let reports = 0;
    let projectCount = 0;

    // 1. Reports.
    const reportRows = await tx
      .select({
        id: reportArtifacts.id,
        userId: reportArtifacts.userId,
        projectId: reportArtifacts.projectId,
        reportType: reportArtifacts.reportType,
        markdown: reportArtifacts.markdown,
      })
      .from(reportArtifacts);
    for (const r of reportRows) {
      await upsertDoc(tx, reportDoc(r));
      reports++;
    }

    // 2. Projects.
    const projectRows = await tx
      .select({
        id: projects.id,
        userId: projects.userId,
        name: projects.name,
        gitRemote: projects.gitRemote,
      })
      .from(projects);
    for (const p of projectRows) {
      const wsRows = await tx
        .select({ rootPath: workspaces.rootPath })
        .from(workspaces)
        .where(eq(workspaces.projectId, p.id));
      await upsertDoc(
        tx,
        projectDoc(
          p,
          wsRows.map((w) => w.rootPath),
        ),
      );
      projectCount++;
    }

    // 3. Sessions — every distinct sessionId through the shared incremental build.
    const idRows = await tx
      .selectDistinct({ sessionId: rawSourceRecords.sessionId })
      .from(rawSourceRecords);
    const sessions = await indexSessions(
      tx,
      idRows.map((r) => r.sessionId),
    );

    return { reports, projects: projectCount, sessions, total: reports + projectCount + sessions };
  });
}

/**
 * Full-text search over the redacted projection. `q` is sanitized by
 * `websearch_to_tsquery` (plain terms, "phrases", -negation); the `'english'`
 * regconfig is a constant literal (NOT a bound param — a parameterized regconfig
 * makes PG treat the SELECT/ORDER-BY exprs as distinct). Hits are ranked by
 * `ts_rank` (defensively `Number()`-coerced per the CLAUDE.md numeric gotcha) and
 * carry a redacted `ts_headline` snippet.
 */
export async function searchDocuments(
  db: DbClient,
  opts: {
    q: string;
    type?: SearchEntityType;
    projectId?: string | null;
    limit?: number;
    offset?: number;
  },
): Promise<SearchResults> {
  const tsq = sql`websearch_to_tsquery('english', ${opts.q})`;
  const rank = sql<number>`ts_rank(${searchDocumentsTbl.searchVector}, ${tsq})`;

  const conditions = [sql`${searchDocumentsTbl.searchVector} @@ ${tsq}`];
  if (opts.type) conditions.push(eq(searchDocumentsTbl.entityType, opts.type));
  if (opts.projectId) conditions.push(eq(searchDocumentsTbl.projectId, opts.projectId));

  const rows = await db
    .select({
      entityType: searchDocumentsTbl.entityType,
      entityId: searchDocumentsTbl.entityId,
      projectId: searchDocumentsTbl.projectId,
      title: searchDocumentsTbl.title,
      // Snippet over the ALREADY-redacted body — safe to render.
      snippet: sql<string>`ts_headline('english', ${searchDocumentsTbl.body}, ${tsq}, 'MaxFragments=2, MinWords=3, MaxWords=12')`,
      rank,
    })
    .from(searchDocumentsTbl)
    .where(and(...conditions))
    // The (entityType, entityId) tiebreaker makes equal-rank ordering deterministic,
    // so offset pagination never duplicates/drops a hit across pages.
    .orderBy(desc(rank), asc(searchDocumentsTbl.entityType), asc(searchDocumentsTbl.entityId))
    .limit(opts.limit ?? 20)
    .offset(opts.offset ?? 0);

  return {
    query: opts.q,
    hits: rows.map((r) => ({
      entityType: r.entityType as SearchEntityType,
      entityId: r.entityId,
      projectId: r.projectId,
      title: r.title,
      snippet: r.snippet,
      rank: Number(r.rank),
    })),
  };
}
