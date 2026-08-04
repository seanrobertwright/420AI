import { and, asc, eq, inArray } from "drizzle-orm";
import {
  parseClaudeCodeSession,
  parseCodexSession,
  CLAUDE_CODE_CONNECTOR,
  CODEX_CLI_CONNECTOR,
  GEMINI_CLI_CONNECTOR,
  type ParseResult,
  type RecoverabilityRow,
} from "@420ai/shared";
import type { DbClient } from "../client.js";
import { decryptField } from "../crypto.js";
import { events, rawSourceRecords } from "../schema.js";
import { reassembleClaude, reassembleCodex } from "./reparse.js";

/**
 * M16 16.4 — §5.1 recoverability, as a READ-ONLY TWIN of the re-parse engine (D-16.4-6).
 *
 * §5.1 defines it as "sampled raw records reparse successfully with EXPECTED OUTPUT". The existing
 * `reparseAll` (reparse.ts) is the WRITE engine — it upserts events and GCs orphans. Running it to
 * MEASURE recoverability would mutate the very archive under audit: the measurement would change
 * its own subject, and a clean result would partly be an artifact of the re-parse having just run.
 *
 * So this performs the identical decrypt → reassemble → re-parse sequence and then only COMPARES
 * FINGERPRINT SETS. No insert, no update, no upsert, no delete — that is the entire contract of
 * this file, and an integration test snapshots `count(*)` of both `events` and `raw_source_records`
 * across a run to pin it.
 *
 * "Expected output" is defined as fingerprint-set EQUALITY, which is the strongest available claim:
 * the fingerprint is the dedup/idempotency key (PRD §12/§23), so if the re-parse reproduces the
 * same set, the archive's derived layer is fully re-derivable from its sacred raw records.
 *
 * THE REASSEMBLERS ARE IMPORTED, NOT COPIED. `reassembleCodex`/`reassembleClaude` gained an
 * `export` keyword and nothing else. A duplicated reassembler would drift from the write engine and
 * make this metric measure the copy rather than the product.
 *
 * SCOPE IS INHERITED, NOT RE-DECIDED (D-M13-2): Claude Code + Codex only. A Gemini session's raw
 * records are per-message re-serializations that cannot reconstruct the parser's whole-file input,
 * and a custom connector has no shared parser at all. Both are reported as `skipped` WITH their
 * reason — never counted as a failure (a fabricated defect) and never silently dropped (which
 * would inflate the ratio).
 */

/** IN-list chunk size — bounds bound-param counts on a long session. Mirrors reparse.ts. */
const CHUNK = 500;

function* chunks<T>(arr: T[], size: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}

/** One subject of the dry run. Raw is PER-MACHINE, so the machine is part of the identity. */
export interface RecoverabilityTarget {
  sessionId: string;
  sourceConnector: string;
  machineId: string;
}

function skipped(
  t: RecoverabilityTarget,
  reason: NonNullable<RecoverabilityRow["skippedReason"]>,
): RecoverabilityRow {
  return {
    sessionId: t.sessionId,
    sourceConnector: t.sourceConnector,
    machineId: t.machineId,
    storedEvents: 0,
    reparsedEvents: 0,
    missing: 0,
    extra: 0,
    // `false`, and deliberately NOT surfaced as a failure: the pure layer keys on `skippedReason`
    // and excludes the row from both halves of the ratio. `ok:true` here would be worse — it would
    // read as "this session was proven recoverable" to anything that ignored the reason.
    ok: false,
    skippedReason: reason,
  };
}

/**
 * Re-parse each target from its sacred raw records and compare the resulting fingerprint set
 * against what is stored. Writes nothing.
 *
 * `orgId` is the SECOND parameter (D-15.2-4). Every read below carries it explicitly rather than
 * leaning on RLS: `session_id` and `source_connector` are connector-supplied, globally-scoped
 * strings two tenants can share (the 15.2 rule), and this function is also reachable from an
 * owner-role caller against which RLS is inert.
 */
export async function reparseDryRun(
  db: DbClient,
  orgId: string,
  targets: RecoverabilityTarget[],
): Promise<RecoverabilityRow[]> {
  const results: RecoverabilityRow[] = [];

  for (const t of targets) {
    if (t.sourceConnector === GEMINI_CLI_CONNECTOR) {
      results.push(skipped(t, "gemini"));
      continue;
    }
    if (t.sourceConnector !== CLAUDE_CODE_CONNECTOR && t.sourceConnector !== CODEX_CLI_CONNECTOR) {
      results.push(skipped(t, "unsupported-connector"));
      continue;
    }

    const rawRows = await db
      .select({
        sourceRecordId: rawSourceRecords.sourceRecordId,
        ciphertext: rawSourceRecords.payloadCiphertext,
        iv: rawSourceRecords.payloadIv,
        tag: rawSourceRecords.payloadTag,
        ingestedAt: rawSourceRecords.ingestedAt,
      })
      .from(rawSourceRecords)
      .where(
        and(
          eq(rawSourceRecords.orgId, orgId),
          eq(rawSourceRecords.sessionId, t.sessionId),
          eq(rawSourceRecords.sourceConnector, t.sourceConnector),
          eq(rawSourceRecords.machineId, t.machineId),
        ),
      )
      .orderBy(asc(rawSourceRecords.ingestedAt));
    if (rawRows.length === 0) {
      // Defensive, and unreachable by construction: `recoverabilityTargets` selects DISTINCT FROM
      // `raw_source_records`, so only a concurrent delete gets here. It carries its OWN reason
      // rather than borrowing `unsupported-connector`, because a wrong explanation on a worksheet
      // row is the failure this module exists to prevent.
      results.push(skipped(t, "no-raw-records"));
      continue;
    }

    // THE ONE DELIBERATE DEVIATION FROM THE SILENT-LIBRARY RULE IN THIS SLICE, named so it is not
    // "fixed" later. Everywhere else a decrypt/key error THROWS and the entrypoint reports it —
    // `reparseAll` does exactly that ten lines away. Here it is caught per row and recorded as
    // `decrypt-error`, because a bounded audit over a sample is precisely the context where one
    // corrupt row must not take down the instrument that would have reported it. An audit report
    // that fails to generate BECAUSE it found a problem is the worst possible failure mode for
    // this milestone. The catch is narrow (one target), loud (rendered on its worksheet row and
    // counted in the skip totals) and never silently widens the ratio.
    let decrypted: { sourceRecordId: string; plaintext: string }[];
    try {
      decrypted = rawRows.map((r) => ({
        sourceRecordId: r.sourceRecordId,
        plaintext: decryptField({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag }),
      }));
    } catch {
      results.push(skipped(t, "decrypt-error"));
      continue;
    }

    // Deterministic `ingestedAt` for the parse's fallbacks: the session's EARLIEST stored ingest
    // time, exactly as `reparseAll` does. Not `now` — a re-parse must not stamp today onto old
    // events, and a different value changes the parser's fallbacks and therefore the fingerprints,
    // which would make this metric fail against a perfectly recoverable archive.
    const ingestedAt = rawRows[0]!.ingestedAt.toISOString();

    const fileText =
      t.sourceConnector === CODEX_CLI_CONNECTOR
        ? reassembleCodex(decrypted)
        : reassembleClaude(decrypted);
    const parsed: ParseResult =
      t.sourceConnector === CODEX_CLI_CONNECTOR
        ? parseCodexSession(fileText, { ingestedAt })
        : parseClaudeCodeSession(fileText, { ingestedAt });

    const freshFingerprints = new Set(parsed.events.map((e) => e.fingerprint));

    // Scope the STORED set the same way `reparseAll`'s orphan GC does: to the raw ids this machine
    // holds, unioned with the ids the fresh parse produced. Events CONVERGE across machines (the
    // fingerprint is machine-independent), so comparing against every event of the session would
    // report another machine's longer capture as `missing` — a fabricated failure.
    const reparsedRawIds = [
      ...new Set([
        ...decrypted.map((r) => r.sourceRecordId),
        ...parsed.events.map((e) => e.rawRecordId),
      ]),
    ];
    const storedFingerprints = new Set<string>();
    for (const idChunk of chunks(reparsedRawIds, CHUNK)) {
      const rows = await db
        .select({ fingerprint: events.fingerprint })
        .from(events)
        .where(
          and(
            eq(events.orgId, orgId),
            eq(events.sessionId, t.sessionId),
            eq(events.sourceConnector, t.sourceConnector),
            inArray(events.rawRecordId, idChunk),
          ),
        );
      for (const r of rows) storedFingerprints.add(r.fingerprint);
    }

    let missing = 0;
    for (const fp of storedFingerprints) if (!freshFingerprints.has(fp)) missing += 1;
    let extra = 0;
    for (const fp of freshFingerprints) if (!storedFingerprints.has(fp)) extra += 1;

    results.push({
      sessionId: t.sessionId,
      sourceConnector: t.sourceConnector,
      machineId: t.machineId,
      storedEvents: storedFingerprints.size,
      reparsedEvents: freshFingerprints.size,
      missing,
      extra,
      ok: missing === 0 && extra === 0,
      skippedReason: null,
    });
  }

  return results;
}
