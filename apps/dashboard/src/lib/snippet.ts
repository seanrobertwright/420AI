/**
 * ts_headline snippet segmentation (M13 13.4). Postgres emits highlight markers
 * with the DEFAULT `StartSel=<b>, StopSel=</b>` (search.ts leaves them unset), so
 * a snippet is plain redacted text interleaved with literal `<b>…</b>` pairs.
 * `splitSnippet` turns that into typed segments the view renders as React text
 * nodes / `<strong>` elements — the markers are the ONLY trusted markup, and
 * NOTHING is ever handed to `dangerouslySetInnerHTML`. Any other HTML-looking
 * text in the body (including a stray unpaired `<b>` or `</b>`) stays literal
 * text, which React escapes on render.
 */

/** One run of snippet text; `bold` when it sat inside a `<b>…</b>` pair. */
export interface SnippetSegment {
  text: string;
  bold: boolean;
}

/**
 * Split a `ts_headline` snippet on its `<b>…</b>` marker pairs. Only complete,
 * non-nested pairs become bold segments; unpaired markers are literal text.
 * Empty pairs (`<b></b>`) produce no segment.
 */
export function splitSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  const pair = /<b>([\s\S]*?)<\/b>/g;
  let last = 0;
  for (const m of snippet.matchAll(pair)) {
    if (m.index > last) segments.push({ text: snippet.slice(last, m.index), bold: false });
    if (m[1]) segments.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) segments.push({ text: snippet.slice(last), bold: false });
  return segments;
}
