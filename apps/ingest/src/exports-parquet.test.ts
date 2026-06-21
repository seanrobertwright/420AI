import { describe, it, expect } from "vitest";
import { parquetReadObjects } from "hyparquet";
import { eventsToParquetBuffer } from "./exports-parquet.js";

// The flat tabular schema the events export uses (mirrors EVENT_CSV_COLUMNS / flattenEventRow).
const COLUMNS = [
  "fingerprint",
  "ts",
  "sourceConnector",
  "eventType",
  "model",
  "tokens_total",
  "cost_usd",
  "cost_confidence",
] as const;

/** A Node Buffer is a view over a larger pooled ArrayBuffer — slice out just these bytes. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe("eventsToParquetBuffer (PRD §22 parquet serializer)", () => {
  const rows: Record<string, unknown>[] = [
    {
      fingerprint: "m6-u1",
      ts: "2026-06-14T00:00:00.000Z",
      sourceConnector: "claude-code",
      eventType: "usage.reported",
      model: "claude-opus-4-8",
      tokens_total: 200,
      cost_usd: 0.0234,
      cost_confidence: null, // a usage event has no cost confidence → column stays nullable
    },
    {
      fingerprint: "m6-c1",
      ts: "2026-06-14T00:01:00.000Z",
      sourceConnector: "claude-code",
      eventType: "cost.estimated",
      model: "claude-opus-4-8",
      tokens_total: null, // a cost event has no token total
      cost_usd: 0.5,
      cost_confidence: "estimated-model-known",
    },
  ];

  it("emits a Buffer with PAR1 magic at head and tail", () => {
    const buf = eventsToParquetBuffer(rows, COLUMNS);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString("latin1")).toBe("PAR1");
    expect(buf.subarray(buf.length - 4).toString("latin1")).toBe("PAR1");
  });

  it("round-trips rows deep-equal (nulls, ints, and floats preserved)", async () => {
    const buf = eventsToParquetBuffer(rows, COLUMNS);
    const readBack = await parquetReadObjects({ file: toArrayBuffer(buf) });
    expect(readBack).toEqual(rows);
    // Spot-check the numeric fidelity the spike asserted.
    expect(readBack[0]!.cost_usd).toBe(0.0234);
    expect(readBack[0]!.tokens_total).toBe(200);
    expect(readBack[0]!.cost_confidence).toBeNull();
    expect(readBack[1]!.tokens_total).toBeNull();
  });

  it("produces a valid non-empty file for an empty row set", async () => {
    const buf = eventsToParquetBuffer([], COLUMNS);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 4).toString("latin1")).toBe("PAR1");
    const readBack = await parquetReadObjects({ file: toArrayBuffer(buf) });
    expect(readBack).toEqual([]);
  });
});
