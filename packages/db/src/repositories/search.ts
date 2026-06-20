import { and, asc, desc, eq, sql } from "drizzle-orm";
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
 * M12 §21 redacted search projection repository. Two functions:
 *
 *   - `rebuildSearchIndex(db)` — the admin-triggered FULL rebuild. Deletes every
 *     `search_documents` row, then re-materializes from reports + projects +
 *     sessions. SESSION content is the ONLY decrypt path here (mirrors
 *     `transcript.ts` / `exports.ts`@304): each raw record is `decryptField`-ed,
 *     the concatenation `redact()`-ed, and only the MASKED text is stored. Every
 *     string written (titles included) passes `redact()` first — search snippets
 *     leave the archive, so this is the §18 gate for this surface. Each row stamps
 *     `REDACTION_VERSION` (§23). Manual-first (the M10 catalog precedent) — the
 *     hot ingest path is untouched.
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
    let sessions = 0;

    // 1. Reports — all plaintext (derived metrics only), but redact defensively:
    //    `redact()` is idempotent, and a path/name in the markdown could carry a
    //    home-dir username. title = report_type, body = redacted markdown.
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
      await upsertDoc(tx, {
        userId: r.userId,
        entityType: "report",
        entityId: r.id,
        projectId: r.projectId,
        title: redact(r.reportType).redacted,
        body: redact(r.markdown).redacted,
      });
      reports++;
    }

    // 2. Projects — name + remote + every mapped workspace root path (paths leak
    //    home-dir usernames → redact). entityId = projectId = the project uuid.
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
      const parts = [p.name, p.gitRemote, ...wsRows.map((w) => w.rootPath)].filter(
        (s): s is string => Boolean(s),
      );
      await upsertDoc(tx, {
        userId: p.userId,
        entityType: "project",
        entityId: p.id,
        projectId: p.id,
        title: redact(p.name).redacted,
        body: redact(parts.join(" ")).redacted,
      });
      projectCount++;
    }

    // 3. Sessions — one doc per distinct sessionId. `min()` aggregates pick a
    //    representative connector/user so the result is EXACTLY one row per session
    //    (the (entity_type, entity_id) unique index forbids two). Content comes from
    //    the session's raw records (decrypt → cap → redact); projectId via the M5
    //    attribution join (null when unattributed — never blocks the rebuild).
    const sessionMeta = await tx
      .select({
        sessionId: rawSourceRecords.sessionId,
        sourceConnector: sql<string>`min(${rawSourceRecords.sourceConnector})`,
        userId: sql<string>`min(${machines.userId}::text)`,
      })
      .from(rawSourceRecords)
      .innerJoin(machines, eq(machines.id, rawSourceRecords.machineId))
      .groupBy(rawSourceRecords.sessionId);

    for (const s of sessionMeta) {
      // Resolve the session's project via the M5 attribution join (best-effort).
      const [attr] = await tx
        .select({ projectId: workspaces.projectId })
        .from(events)
        .innerJoin(workspaceKeys, eq(events.projectPath, workspaceKeys.projectKey))
        .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
        .where(eq(events.sessionId, s.sessionId))
        .limit(1);
      const projectId = attr?.projectId ?? null;

      // Read + decrypt the session's verbatim raw records, ordered, capped.
      const rawRows = await tx
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
      await upsertDoc(tx, {
        userId: s.userId,
        entityType: "session",
        entityId: s.sessionId,
        projectId,
        title: redact(`${s.sourceConnector} · ${s.sessionId}`).redacted,
        body: redact(combined).redacted,
      });
      sessions++;
    }

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
  opts: { q: string; type?: SearchEntityType; projectId?: string | null; limit?: number },
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
    .orderBy(desc(rank))
    .limit(opts.limit ?? 20);

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
