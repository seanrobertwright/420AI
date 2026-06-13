import { openSync, readSync, fstatSync, closeSync } from "node:fs";

/**
 * Byte-offset tailer (PURE — proven in PRE-FLIGHT #4).
 *
 * Reads a file's complete-line prefix and reports the new cursor offset. A
 * partial trailing line (no newline yet) is HELD BACK — the cursor never
 * advances over it — so a half-written JSON record is never captured. On
 * truncation/rotation (size < saved offset) it resets and re-reads from 0.
 *
 * Returns the WHOLE-FILE prefix `[0 .. last '\n']` as `text` (not just the
 * delta) because the Claude parser is whole-file: it derives
 * session.started/ended from the earliest/latest timestamp across ALL records
 * and falls back to `${session}:${lineIndex}` ids. The queue's content-hash
 * dedup keeps re-parsing the whole prefix each tick cheap + correct.
 */
export interface TailResult {
  /** The complete-line prefix to parse (whole file up to last newline), or "". */
  text: string;
  /** The cursor to persist — end of the last complete line. */
  newOffset: number;
  /** True when at least one new complete line appeared since `fromOffset`. */
  grew: boolean;
  /** True when the file shrank below `fromOffset` (truncation/rotation). */
  reset: boolean;
}

export function readGrownPrefix(path: string, fromOffset: number): TailResult {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const reset = size < fromOffset; // truncation/rotation -> re-read from 0

    // No growth and no truncation -> nothing to do.
    if (!reset && size === fromOffset) {
      return { text: "", newOffset: fromOffset, grew: false, reset };
    }

    const buf = Buffer.allocUnsafe(size);
    readSync(fd, buf, 0, size, 0); // whole file (<=~1MB sessions, PRD §8.5)

    // lastIndexOf on the Buffer (byte 0x0a), not a decoded string — multibyte-safe.
    const lastNL = buf.lastIndexOf(0x0a);
    if (lastNL < 0) {
      // No complete line yet (only a partial trailing line exists).
      return { text: "", newOffset: reset ? 0 : fromOffset, grew: false, reset };
    }
    const newOffset = lastNL + 1;
    // The file grew in bytes, but if no NEW complete line appeared beyond the
    // cursor (only a partial trailing line was appended), hold it back: emit
    // nothing and leave the cursor where it was. (On reset we always re-read.)
    if (!reset && newOffset <= fromOffset) {
      return { text: "", newOffset: fromOffset, grew: false, reset };
    }
    return {
      text: buf.subarray(0, newOffset).toString("utf8"),
      newOffset,
      grew: true,
      reset,
    };
  } finally {
    closeSync(fd);
  }
}
