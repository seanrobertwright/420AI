import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const code = "bg-muted/40 rounded px-1.5 py-0.5 font-mono text-xs";
const cta = cn(
  "inline-flex items-center rounded-md px-4 py-2 text-sm font-medium transition-colors",
  "bg-primary text-primary-foreground hover:bg-primary/90",
);

/**
 * First-run empty state (M13 13.6, PRD §19). Rendered on the Live Monitor when no machine has
 * paired yet (zero machines in the snapshot) instead of three empty tables — it points a fresh
 * operator straight at the pairing flow and the quickstart. Pure/presentational: it carries no
 * data and no token, so it is safe to render from the client island.
 */
export function OnboardingCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome to 420AI — no collectors paired yet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-muted-foreground text-sm">
          Nothing is being captured yet. Pair this machine&apos;s collector to start streaming your
          Claude Code, Codex, and Gemini sessions into the archive — this view fills in within a few
          seconds of the first event.
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            Generate a pairing code on the{" "}
            <Link href="/pairing" className="text-primary hover:underline">
              Pairing
            </Link>{" "}
            page.
          </li>
          <li>
            Pair the collector:{" "}
            <code className={code}>collector pair &lt;url&gt; &lt;code&gt;</code>
          </li>
          <li>
            Start capture: <code className={code}>collector watch</code>
          </li>
        </ol>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/pairing" className={cta}>
            Generate pairing code
          </Link>
          <span className="text-muted-foreground text-xs">
            Full walkthrough: <code className={code}>docs/guide/quickstart.md</code>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
