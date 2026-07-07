"use client";

import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Rich report rendering (M13 13.4): react-markdown + remark-gfm (report tables
 * are GFM), with fenced ```mermaid blocks rendered as diagrams. Mermaid (~1 MB)
 * is loaded via a LAZY dynamic import inside `useEffect` — it never SSRs and
 * never blocks first paint; until (or if) it renders, the block shows its
 * diagram source as preformatted text, so a mermaid failure degrades to exactly
 * the pre-13.4 view. Raw HTML in the markdown is NOT rendered — no rehype-raw
 * here, ever (report markdown transits redaction but is still archive-derived
 * content), and `skipHtml` drops raw-HTML nodes (e.g. the renderers' `<!-- -->`
 * source-of-truth comments) instead of showing them as literal text.
 */

// Mermaid render targets need unique DOM-safe ids; a module counter avoids the
// exotic characters React's useId emits (invalid inside mermaid's selectors).
let mermaidSeq = 0;
let mermaidInitialized = false;

async function renderMermaid(id: string, code: string): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  if (!mermaidInitialized) {
    // `strict` encodes labels/click handlers — diagram text cannot inject HTML.
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    mermaidInitialized = true;
  }
  const { svg } = await mermaid.render(id, code);
  return svg;
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  idRef.current ??= `report-mermaid-${++mermaidSeq}`;

  useEffect(() => {
    let cancelled = false;
    renderMermaid(idRef.current!, code)
      .then((rendered) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        /* invalid diagram / load failure → keep the <pre> source fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (svg === null) {
    return (
      <pre className="bg-muted/40 overflow-x-auto rounded-md p-4 text-xs whitespace-pre-wrap">
        {code}
      </pre>
    );
  }
  return (
    <div
      className="my-4 flex justify-center overflow-x-auto [&_svg]:max-w-full"
      // The ONLY innerHTML on this surface, and it is mermaid's OWN rendered SVG
      // (securityLevel "strict" encodes all diagram-provided text) — never the
      // report markdown itself. The snippet/markdown paths stay escape-by-default.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** A fenced code block: mermaid fences become diagrams, the rest styled <pre>. */
function CodeFence({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement(child)) {
    const props = child.props as { className?: string; children?: ReactNode };
    const text = String(props.children ?? "").replace(/\n$/, "");
    if (props.className?.includes("language-mermaid")) {
      return <MermaidBlock code={text} />;
    }
    return (
      <pre className="bg-muted/40 my-3 overflow-x-auto rounded-md p-4 text-xs">{children}</pre>
    );
  }
  return <pre className="bg-muted/40 my-3 overflow-x-auto rounded-md p-4 text-xs">{children}</pre>;
}

/** Render a report artifact's markdown as rich content (tables, mermaid, GFM). */
export function ReportMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: CodeFence,
          code: ({ className, children }) => (
            <code className={cn(className ?? "bg-muted/40 rounded px-1 py-0.5 font-mono text-xs")}>
              {children}
            </code>
          ),
          h1: ({ children }) => (
            <h1 className="mt-6 mb-3 text-xl font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-6 mb-2 text-lg font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>
          ),
          p: ({ children }) => <p className="my-2 leading-6">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          a: ({ href, children }) => (
            <a href={href} className="text-primary hover:underline">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-border border-b px-3 py-2 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-border/50 border-b px-3 py-2">{children}</td>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
