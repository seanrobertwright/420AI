import { openSync, readSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Read a file in bounded chunks, invoking `onLine` for each complete (newline-
 * terminated) line, and return the FIRST non-undefined value `onLine` yields —
 * WITHOUT reading the rest of the file (plan D2: discovery is a cheap metadata
 * sweep, not a full-file slurp). The opening record of a session carries the
 * `cwd` / `session_meta`, so a few KB is read in practice.
 *
 * Uses a `StringDecoder` so a multi-byte UTF-8 sequence split across a chunk
 * boundary is not corrupted. `maxBytes` is a safety cap for a pathological file
 * with no newline. Returns undefined on a read error or if no line matches.
 *
 * Library file: synchronous + side-effect-free (no logging).
 */
export function scanLines<T>(
  filePath: string,
  onLine: (line: string) => T | undefined,
  opts: { chunkSize?: number; maxBytes?: number } = {},
): T | undefined {
  const chunkSize = opts.chunkSize ?? 64 * 1024;
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;

  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let total = 0;

    for (;;) {
      const bytes = readSync(fd, buf, 0, chunkSize, null);
      if (bytes === 0) break; // EOF
      total += bytes;
      carry += decoder.write(buf.subarray(0, bytes));

      let nl: number;
      while ((nl = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, nl).replace(/\r$/, "");
        carry = carry.slice(nl + 1);
        const result = onLine(line);
        if (result !== undefined) return result;
      }

      if (total >= maxBytes) break; // pathological single-line file — give up
    }

    carry += decoder.end();
    if (carry.length > 0) {
      const result = onLine(carry.replace(/\r$/, ""));
      if (result !== undefined) return result;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
