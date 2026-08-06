# Week YYYY-WW

<!--
  COPY THIS FILE to `.agents/research/weekly/YYYY-WW.md` (ISO week) and fill it in.
  The body below is the research-analysis-plan.md §10 template, verbatim.

  PRIVACY RULE (§3): no captured session content, secrets, access tokens, or personally
  identifying source data. Aggregate metrics, anonymized consented quotes, and links/IDs only.

  RECORD UNKNOWN VALUES EXPLICITLY (§5.1). Do NOT substitute zero for absent data — write
  "unknown" or "not measured". A zero and a gap mean opposite things, and the whole point of
  this scorecard is that the difference stays visible.
-->

## Capture health

<!--
  FILL THIS BLOCK FROM THE DATA-QUALITY AUDIT REPORT (M16 16.4) — do not guess the numbers.
  Generate it from the Reports page ("Generate audit"), or:
      npm run reports:generate -- --audit
  The report does NOT have one table matching this block one-for-one — two of the rows below come
  from elsewhere in it. Where each row comes from:

      Captured sessions           <- the report's HEADER bullet "Sessions in window"
      Capture coverage (audit)    <- §5.1 table (always `unknown` — see below)
      Correct project attribution <- §5.1 table, the "correctness" row (always `unknown`)
      Token completeness          <- §5.1 table
      Parse success               <- §5.1 table
      Duplicate rate              <- §5.1 table
      Stale/unhealthy connectors  <- the "Capture health (from 16.3)" verdict counts
                                     (not-capturing + broken), NOT the §5.1 table
      Alerts fired (detection)    <- NOT in the report. Dashboard → Alerts, or
                                     `GET /v1/alerts` — count firings whose `firstFiredAt`
                                     falls in the week. Record OPEN and UNACKED separately:
                                     "3 fired / 1 still open".
      Collector fault present?    <- NOT in the report and NOT server-side at all. Check the
                                     COLLECTOR machine for `~/.420ai/fault.json` (M16 16.6).
                                     yes / no / unknown. Its presence means the archive
                                     rejected this collector's credential and capture stopped.

  THE LAST TWO ROWS ARE THE DETECTION ROWS, added by 16.6 after INC-2026-07 — the week capture
  ran dead for 8 days and every other row above would have read a plausible, quiet zero. They ask
  the question the rest of the block cannot: "did anything TELL us?". A week with zero captured
  sessions and zero alerts fired is a DETECTION failure, not a quiet week; the two rows exist so
  that combination is visible on the page rather than inferred later. `unknown` is a legal answer
  for both and a zero is not a substitute — same rule as every row above.

  The §5.1 table also carries "Project attribution — coverage", "Sync freshness" and
  "Recoverability", which this block has no slot for — read them in the report.

  Every §5.1 row carries its basis (`measured` / `sampled (n=N)` / `unknown` + reason). Copy the
  basis across too: a metric the archive cannot answer must land here as "unknown", never as a
  blank or a zero. Capture coverage and attribution CORRECTNESS are ALWAYS `unknown` — answer them
  by hand from the report's §4.4 reconciliation worksheet.
-->

| Measure                       | This week | Target       | Notes |
| ----------------------------- | --------: | -----------: | ----- |
| Captured sessions             |           |          20+ |       |
| Capture coverage (audit)      |           |          95% |       |
| Correct project attribution   |           |          90% |       |
| Token completeness            |           |          95% |       |
| Parse success                 |           |          99% |       |
| Duplicate rate                |           |          <1% |       |
| Stale/unhealthy connectors    |           | 0 unresolved |       |
| Alerts fired (detection)      |           |            — |       |
| Collector fault present?      |           |           no |       |

## Value

- Reports reviewed:
- Useful insights:
- Decisions made because of 420AI:
- Follow-ups completed:
- Trust score / explanation:

## Incidents and data gaps

<!-- Also append anything here to `../incidents.md`, categorized per §4.4. -->

| Severity | Category | What happened | User impact | Root cause | Fix / owner | Regression test? |
| -------- | -------- | ------------- | ----------- | ---------- | ----------- | ---------------- |

## This week's decision

<!-- Also file this as a DEC-YYYY-NN entry in `../decisions.md`. -->

- **Evidence:**
- **Action:**
- **Expected result:**
- **Check again on:**

## Next week's single priority
