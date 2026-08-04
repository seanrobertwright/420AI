import { describe, it, expect } from "vitest";
import { buildDecisionStub, type DecisionStubInput } from "./decision-stub.js";

/**
 * M16 16.2 — §7 P1.5's stub, and D-16.2-5's privacy guarantee.
 *
 * The privacy test below can only ever confirm what `DecisionStubInput`'s `never` fields already
 * make unrepresentable, and that is the right order: PREVENT at the type level, then ASSERT. A test
 * alone would be a guard someone can delete without the compiler noticing.
 */

const BASE: DecisionStubInput = {
  sessionId: "sess-2026-08-04-abc",
  nowIso: "2026-08-04T09:30:00.000Z",
  sourceConnector: "claude-code",
  startedAt: "2026-08-04T08:00:00.000Z",
  lastEventAt: "2026-08-04T08:45:00.000Z",
  eventCount: 42,
  taskType: "feature",
  outcome: "shipped",
  primaryFriction: "context",
  qualityRating: 4,
  confidence: "high",
};

describe("buildDecisionStub", () => {
  it("renders the §11 template's lines verbatim", () => {
    const stub = buildDecisionStub(BASE);
    for (const line of [
      "- **Date / user / project:**",
      "- **Question:**",
      "- **Evidence reviewed:**",
      "- **Finding:**",
      "- **Action taken:**",
      "- **Expected effect:**",
      "- **Follow-up date:**",
      "- **Observed result:**",
      "- **Would I make this decision without 420AI?** yes / no / uncertain",
    ]) {
      expect(stub, `template line missing: ${line}`).toContain(line);
    }
  });

  it("pre-fills the ids, dates, counts and closed-set values", () => {
    const stub = buildDecisionStub(BASE);
    expect(stub).toContain("session `sess-2026-08-04-abc`");
    expect(stub).toContain("connector `claude-code`");
    expect(stub).toContain("42 events");
    expect(stub).toContain("2026-08-04");
    // Closed-set values render through the shared display maps, not as raw column text.
    expect(stub).toContain("task Feature");
    expect(stub).toContain("outcome Shipped");
    expect(stub).toContain("friction Context");
    expect(stub).toContain("usefulness 4/5");
    expect(stub).toContain("label confidence High");
  });

  // ══ D-16.2-5 — THE PRIVACY ASSERTION. ══
  it("emits no free human text, even when the label carries some", () => {
    // A label whose `intent` holds exactly what §3 forbids: a customer name and a token.
    const PLANTED = "acme-corp renewal, key sk-ant-api03-AAAABBBBCCCCDDDD";
    const PLANTED_URL = "https://internal.acme-corp.example/pr/42?token=hunter2";
    const PLANTED_PATH = "C:\\work\\acme-corp\\billing";

    // `as unknown as DecisionStubInput` is REQUIRED to write this test at all — the `never` fields
    // reject these three properties at compile time, which is the actual guarantee. The cast exists
    // solely so the runtime behaviour can be pinned too.
    const leaky = {
      ...BASE,
      intent: PLANTED,
      followUpCommitOrPr: PLANTED_URL,
      projectPath: PLANTED_PATH,
    } as unknown as DecisionStubInput;

    const stub = buildDecisionStub(leaky);
    expect(stub).not.toContain(PLANTED);
    expect(stub).not.toContain(PLANTED_URL);
    expect(stub).not.toContain(PLANTED_PATH);
    expect(stub).not.toContain("acme-corp");
    expect(stub).not.toContain("sk-ant-api03");
    expect(stub).not.toContain("hunter2");
    // …while still carrying the link that makes the entry useful (§3: "links/IDs only").
    expect(stub).toContain("sess-2026-08-04-abc");
  });

  it("takes the year from the injected clock, never the wall clock", () => {
    expect(buildDecisionStub(BASE)).toContain("## DEC-2026-NN");
    expect(buildDecisionStub({ ...BASE, nowIso: "2031-01-02T00:00:00.000Z" })).toContain(
      "## DEC-2031-NN",
    );
  });

  it("leaves NN as a visible placeholder rather than guessing a number", () => {
    const stub = buildDecisionStub(BASE);
    expect(stub).toContain("-NN —");
    expect(stub).not.toMatch(/## DEC-\d{4}-\d{2} —/);
  });

  it("degrades to blanks rather than lying when fields are absent", () => {
    const sparse = buildDecisionStub({ sessionId: "s1", nowIso: "2026-08-04T09:30:00.000Z" });
    expect(sparse).toContain("session `s1`");
    expect(sparse).not.toContain("events");
    expect(sparse).not.toContain("undefined");
    expect(sparse).not.toContain("null");
    expect(sparse).not.toContain("NaN");
    // An unstated confidence says so, rather than being omitted or guessed (D-16.1-8).
    expect(sparse).toContain("label confidence Not stated");
  });

  it("survives an unparseable timestamp without emitting Invalid Date", () => {
    const stub = buildDecisionStub({ ...BASE, nowIso: "not-a-date", startedAt: "also-not" });
    expect(stub).not.toContain("Invalid Date");
    expect(stub).not.toContain("NaN");
    expect(stub).toContain("## DEC-YYYY-NN");
  });
});
