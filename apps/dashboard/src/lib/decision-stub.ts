// NO `.js` SUFFIX on a relative import in this workspace. The dashboard is `moduleResolution:
// bundler` (CLAUDE.md "Frontend workspace"), so webpack resolves `./label-display` and FAILS on
// `./label-display.js` — while `tsc --noEmit` accepts both. The sibling `*.test.ts` files do carry
// `.js` because only vitest/esbuild ever reads them. This is exactly why `build:dashboard` is a
// gate: the type lane cannot catch it.
import { taskTypeLabel, outcomeLabel, frictionLabel, confidenceLabel } from "./label-display";

/**
 * M16 16.2 / research plan §7 P1.5 — build a `DEC-` entry stub for `.agents/research/decisions.md`.
 *
 * WHY THIS IS A STRING BUILDER AND NOT A TABLE (D-16.2-6). The decision log already exists as a
 * research-plan §3 source-of-truth artifact with a §11 template, in git. A `decisions` table would
 * create a SECOND log that diverges from the first, and would need a migration, an RLS
 * classification, a two-role suite and a dashboard surface just to reach parity with a markdown
 * file that already works. P1.5's acceptance criterion is "a report or session can link to a
 * decision without exposing raw contents externally" — that is met by GENERATING the link. The
 * product's only job here is to remove the copy-the-session-id friction and to enforce the file's
 * privacy rule by construction.
 *
 * ══ D-16.2-5 — WHAT THIS FUNCTION MAY NOT EMIT. THIS IS THE WHOLE POINT OF THE MODULE. ══
 *
 * `.agents/research/decisions.md` is COMMITTED TO A PUBLIC REPOSITORY and its §3 privacy rule is
 * "aggregate metrics, anonymized quotes with consent, and links/IDs only".
 *
 * `intent` is 200 characters of free human text and `followUpCommitOrPr` is a URL a person pasted.
 * Either may carry a customer name, an access token or a credentialed URL that the person typing it
 * never thought of as leaving the archive. They are precisely the two fields
 * `GET /v1/labels/export` REDACTS (D-16.1-7) — and pasting them into a public git file is strictly
 * worse than exporting them, because an export lands on the operator's disk while a commit is
 * permanent and world-readable.
 *
 * `projectPath` is excluded for the same reason and is worth naming separately, because it does not
 * look like free text: it is a filesystem path, and a filesystem path routinely contains a client
 * or employer name (`C:\work\acme-corp\...`). It is identifying source data under §3.
 *
 * SO THE EXCLUSION IS AT THE TYPE LEVEL, not in the body. `DecisionStubInput` declares
 * `intent?: never` and `followUpCommitOrPr?: never`, which makes passing an `OutcomeLabelRow`
 * straight in a COMPILE ERROR rather than a silent leak — the caller is forced to name the fields
 * it is handing over. That is strictly stronger than remembering not to interpolate them, and it is
 * why the test can only confirm what the type already prevents. Right order: prevent, then assert.
 *
 * Everything the stub DOES emit is either an ID, a timestamp, a count, or a member of a closed set
 * in `@420ai/shared/outcome-labels` — i.e. a value the operator SELECTED from a dropdown rather
 * than TYPED.
 *
 * THE CLOCK IS A PARAMETER (`nowIso`), never `new Date()` in here — the repo-wide injection rule,
 * and it is what makes the year in `DEC-YYYY-NN` testable.
 */

export interface DecisionStubInput {
  /** The link into the archive. §3: "a session id … points into the archive without copying anything out of it." */
  sessionId: string;
  /** Injected clock (ISO). Supplies the `DEC-YYYY-` year and the entry's Date field. */
  nowIso: string;
  sourceConnector?: string | null;
  startedAt?: string | null;
  lastEventAt?: string | null;
  eventCount?: number | null;
  // ── closed-set label values: SELECTED, never TYPED ──
  taskType?: string | null;
  outcome?: string | null;
  primaryFriction?: string | null;
  qualityRating?: number | null;
  confidence?: string | null;
  /**
   * ── NOT EMITTABLE. `never` so passing a whole label row is a compile error, not a leak. ──
   * See D-16.2-5 above. If you find yourself widening either of these, you are about to paste free
   * human text into a public repository; the answer is a link to the session, which is above.
   */
  intent?: never;
  followUpCommitOrPr?: never;
  projectPath?: never;
}

/** ISO → `YYYY-MM-DD`, or the empty string when unparseable (the human fills the line in). */
function isoDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Render the §11 template with the machine-knowable lines pre-filled and every judgement line left
 * blank for the human.
 *
 * `NN` IS LEFT AS THE LITERAL PLACEHOLDER, deliberately. Numbering is `DEC-YYYY-NN` "within the
 * year" and this builder cannot see the file, so it cannot know the next number. A confidently
 * wrong number would collide with an existing entry and be harder to spot than an obvious
 * placeholder — so the year is real and `NN` is visibly not.
 */
export function buildDecisionStub(input: DecisionStubInput): string {
  const year = isoDate(input.nowIso).slice(0, 4) || "YYYY";

  // Every fragment below is an ID, a timestamp, a count or a closed-set value (D-16.2-5).
  const evidence: string[] = [`session \`${input.sessionId}\``];
  if (input.sourceConnector) evidence.push(`connector \`${input.sourceConnector}\``);
  const from = isoDate(input.startedAt);
  const to = isoDate(input.lastEventAt);
  if (from && to) evidence.push(from === to ? from : `${from} → ${to}`);
  if (typeof input.eventCount === "number") evidence.push(`${input.eventCount} events`);

  // The operator's own label, as the confidence caveat §11 asks for. `confidenceLabel(null)` is
  // "Not stated", which is the honest rendering of an unstated confidence rather than a guess.
  const judgement: string[] = [];
  if (input.taskType) judgement.push(`task ${taskTypeLabel(input.taskType)}`);
  if (input.outcome) judgement.push(`outcome ${outcomeLabel(input.outcome)}`);
  if (input.primaryFriction) judgement.push(`friction ${frictionLabel(input.primaryFriction)}`);
  if (typeof input.qualityRating === "number")
    judgement.push(`usefulness ${input.qualityRating}/5`);
  judgement.push(`label confidence ${confidenceLabel(input.confidence ?? null)}`);

  return [
    `## DEC-${year}-NN — <short decision>`,
    ``,
    `- **Date / user / project:** ${isoDate(input.nowIso)}`,
    `- **Question:**`,
    `- **Evidence reviewed:** ${evidence.join(", ")}`,
    `- **Label:** ${judgement.join(", ")}`,
    `- **Finding:**`,
    `- **Action taken:**`,
    `- **Expected effect:**`,
    `- **Follow-up date:**`,
    `- **Observed result:**`,
    `- **Would I make this decision without 420AI?** yes / no / uncertain`,
    ``,
  ].join("\n");
}
