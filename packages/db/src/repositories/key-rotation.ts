import { and, asc, eq, isNotNull, like, not } from "drizzle-orm";
import type { Db, Tx } from "../client.js";
import { activeKeyId, decryptField, encryptField, type EncryptedField } from "../crypto.js";
import { events, gitCommits, rawSourceRecords } from "../schema.js";

/**
 * M12 12.4e — re-encrypt every encrypted row under the ACTIVE keyring key. The keyId rides
 * inside the ciphertext string ("<id>.<base64>"), so rotation is a pure data pass: no schema
 * change, no read-site change. Finds un-rotated rows with a `NOT LIKE '<active>.%'` scan and
 * re-encrypts the decrypted plaintext (the re-encrypt stamps the active prefix), in id-ordered
 * batches so the same rows aren't re-selected and memory stays bounded on large raw tables.
 *
 * Only meaningful in KEYRING mode: in legacy single-key mode the active id is "legacy" and
 * ciphertext is un-prefixed, so a rotation would be a no-op (and silently mask a misconfig) —
 * we throw instead.
 */
const BATCH = 500;

export interface RotationCounts {
  rawSourceRecords: number;
  events: number;
  gitCommits: number;
}

interface EncRow {
  key: string;
  ct: string | null;
  iv: string | null;
  tag: string | null;
}

/** Run one table's rotation in a single transaction; returns how many rows were re-encrypted. */
async function rotateTable(
  db: Db,
  selectBatch: (tx: Tx) => Promise<EncRow[]>,
  applyUpdate: (tx: Tx, key: string, enc: EncryptedField) => Promise<unknown>,
): Promise<number> {
  return db.transaction(async (tx) => {
    let count = 0;
    for (;;) {
      const rows = await selectBatch(tx);
      if (rows.length === 0) break;
      for (const r of rows) {
        // The WHERE filters non-null trios, so this guard is defensive (and narrows for TS).
        if (r.ct === null || r.iv === null || r.tag === null) continue;
        const enc = encryptField(decryptField({ ciphertext: r.ct, iv: r.iv, tag: r.tag }));
        await applyUpdate(tx, r.key, enc);
        count += 1;
      }
    }
    return count;
  });
}

export async function reencryptAll(db: Db): Promise<RotationCounts> {
  const active = activeKeyId();
  if (active === "legacy") {
    throw new Error(
      "rotation requires ARCHIVE_ENCRYPTION_KEYS + ARCHIVE_ENCRYPTION_ACTIVE_KEY_ID (keyring mode)",
    );
  }
  const prefix = `${active}.%`;

  const rawCount = await rotateTable(
    db,
    (tx) =>
      tx
        .select({
          key: rawSourceRecords.id,
          ct: rawSourceRecords.payloadCiphertext,
          iv: rawSourceRecords.payloadIv,
          tag: rawSourceRecords.payloadTag,
        })
        .from(rawSourceRecords)
        .where(not(like(rawSourceRecords.payloadCiphertext, prefix)))
        .orderBy(asc(rawSourceRecords.id))
        .limit(BATCH),
    (tx, key, enc) =>
      tx
        .update(rawSourceRecords)
        .set({ payloadCiphertext: enc.ciphertext, payloadIv: enc.iv, payloadTag: enc.tag })
        .where(eq(rawSourceRecords.id, key)),
  );

  const eventsCount = await rotateTable(
    db,
    (tx) =>
      tx
        .select({
          key: events.fingerprint,
          ct: events.payloadCiphertext,
          iv: events.payloadIv,
          tag: events.payloadTag,
        })
        .from(events)
        .where(
          and(
            isNotNull(events.payloadCiphertext),
            isNotNull(events.payloadIv),
            isNotNull(events.payloadTag),
            not(like(events.payloadCiphertext, prefix)),
          ),
        )
        .orderBy(asc(events.fingerprint))
        .limit(BATCH),
    (tx, key, enc) =>
      tx
        .update(events)
        .set({ payloadCiphertext: enc.ciphertext, payloadIv: enc.iv, payloadTag: enc.tag })
        .where(eq(events.fingerprint, key)),
  );

  const gitCount = await rotateTable(
    db,
    (tx) =>
      tx
        .select({
          key: gitCommits.id,
          ct: gitCommits.messageCiphertext,
          iv: gitCommits.messageIv,
          tag: gitCommits.messageTag,
        })
        .from(gitCommits)
        .where(
          and(
            isNotNull(gitCommits.messageCiphertext),
            isNotNull(gitCommits.messageIv),
            isNotNull(gitCommits.messageTag),
            not(like(gitCommits.messageCiphertext, prefix)),
          ),
        )
        .orderBy(asc(gitCommits.id))
        .limit(BATCH),
    (tx, key, enc) =>
      tx
        .update(gitCommits)
        .set({ messageCiphertext: enc.ciphertext, messageIv: enc.iv, messageTag: enc.tag })
        .where(eq(gitCommits.id, key)),
  );

  return { rawSourceRecords: rawCount, events: eventsCount, gitCommits: gitCount };
}
