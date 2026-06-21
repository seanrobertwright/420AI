"use client";

import { useState } from "react";
import { PageShell } from "@/components/page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const inputCls = "border-border bg-background rounded-md border px-3 py-2 text-sm";
const selectCls = "border-border bg-background rounded-md border px-3 py-2 text-sm";
const linkCls = cn(
  "inline-block rounded-md border px-4 py-2 text-sm font-medium transition-colors",
  "border-border hover:bg-muted",
);
const disabledCls = cn(
  "inline-block rounded-md border px-4 py-2 text-sm font-medium",
  "border-border opacity-50",
);

/** Build a proxy URL with only the non-empty params set. */
function buildUrl(base: string, params: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v.trim()) qs.set(k, v.trim());
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

/**
 * Export downloads (M12 12.2b, PRD §22). Client component: three forms (events / report /
 * transcript) that build a same-origin proxy URL and download via an `<a download>` — the proxy
 * streams ingest's already-redacted response with the admin bearer added server-side, so NO
 * token is ever in the browser (D8) and the bytes are redaction-versioned. Events support
 * json|jsonl|csv; report md|json; transcript md|json|jsonl (the per-subject formats ingest
 * accepts).
 */
export function ExportView() {
  // Events
  const [evFormat, setEvFormat] = useState<"json" | "jsonl" | "csv" | "parquet">("jsonl");
  const [evProjectId, setEvProjectId] = useState("");
  const [evConnector, setEvConnector] = useState("");
  const [evStart, setEvStart] = useState("");
  const [evEnd, setEvEnd] = useState("");

  // Report
  const [reportId, setReportId] = useState("");
  const [reportFormat, setReportFormat] = useState<"md" | "json">("md");

  // Transcript
  const [sessionId, setSessionId] = useState("");
  const [txFormat, setTxFormat] = useState<"md" | "json" | "jsonl">("md");

  const eventsUrl = buildUrl("/api/exports/events", {
    format: evFormat,
    projectId: evProjectId,
    connector: evConnector,
    start: evStart,
    end: evEnd,
  });
  const reportUrl = reportId.trim()
    ? buildUrl(`/api/reports/${encodeURIComponent(reportId.trim())}/export`, {
        format: reportFormat,
      })
    : null;
  const transcriptUrl = sessionId.trim()
    ? buildUrl(`/api/sessions/${encodeURIComponent(sessionId.trim())}/transcript/export`, {
        format: txFormat,
      })
    : null;

  return (
    <PageShell
      title="Export"
      subtitle="Download redacted archive data — no token leaves the server."
    >
      <div className="space-y-8">
        {/* Events */}
        <Card>
          <CardHeader>
            <CardTitle>Events</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <select
                value={evFormat}
                onChange={(e) =>
                  setEvFormat(e.target.value as "json" | "jsonl" | "csv" | "parquet")
                }
                className={selectCls}
                aria-label="Events format"
              >
                <option value="jsonl">JSONL</option>
                <option value="json">JSON</option>
                <option value="csv">CSV</option>
                <option value="parquet">Parquet</option>
              </select>
              <input
                value={evProjectId}
                onChange={(e) => setEvProjectId(e.target.value)}
                placeholder="Project id (optional)"
                className={cn(inputCls, "w-56 font-mono text-xs")}
                aria-label="Project id"
              />
              <input
                value={evConnector}
                onChange={(e) => setEvConnector(e.target.value)}
                placeholder="Connector (optional)"
                className={cn(inputCls, "w-44")}
                aria-label="Connector"
              />
              <input
                value={evStart}
                onChange={(e) => setEvStart(e.target.value)}
                placeholder="Start ISO (optional)"
                className={cn(inputCls, "w-52 font-mono text-xs")}
                aria-label="Start"
              />
              <input
                value={evEnd}
                onChange={(e) => setEvEnd(e.target.value)}
                placeholder="End ISO (optional)"
                className={cn(inputCls, "w-52 font-mono text-xs")}
                aria-label="End"
              />
            </div>
            <a href={eventsUrl} download className={linkCls}>
              Download events
            </a>
          </CardContent>
        </Card>

        {/* Report */}
        <Card>
          <CardHeader>
            <CardTitle>Report artifact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={reportId}
                onChange={(e) => setReportId(e.target.value)}
                placeholder="Report id (uuid)"
                className={cn(inputCls, "w-80 font-mono text-xs")}
                aria-label="Report id"
              />
              <select
                value={reportFormat}
                onChange={(e) => setReportFormat(e.target.value as "md" | "json")}
                className={selectCls}
                aria-label="Report format"
              >
                <option value="md">Markdown</option>
                <option value="json">JSON</option>
              </select>
            </div>
            {reportUrl ? (
              <a href={reportUrl} download className={linkCls}>
                Download report
              </a>
            ) : (
              <span className={disabledCls}>Download report</span>
            )}
          </CardContent>
        </Card>

        {/* Transcript */}
        <Card>
          <CardHeader>
            <CardTitle>Session transcript</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="Session id"
                className={cn(inputCls, "w-80 font-mono text-xs")}
                aria-label="Session id"
              />
              <select
                value={txFormat}
                onChange={(e) => setTxFormat(e.target.value as "md" | "json" | "jsonl")}
                className={selectCls}
                aria-label="Transcript format"
              >
                <option value="md">Markdown</option>
                <option value="json">JSON</option>
                <option value="jsonl">JSONL</option>
              </select>
            </div>
            {transcriptUrl ? (
              <a href={transcriptUrl} download className={linkCls}>
                Download transcript
              </a>
            ) : (
              <span className={disabledCls}>Download transcript</span>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
