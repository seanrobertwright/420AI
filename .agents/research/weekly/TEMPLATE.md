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
