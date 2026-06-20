"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * M12 12.3 login form — a client island. POSTs {email,password} JSON to the same-origin
 * /api/auth/login route handler (which forwards to ingest and sets the httpOnly session cookie,
 * D8 — the token never touches client JS). On success it navigates to the `next` param (the page
 * the middleware bounced from) or /monitor. Mirrors the mutation discipline of project-create.tsx:
 * check res.ok, disable in-flight, surface a friendly error.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (res.ok) {
        // Only follow a SAME-ORIGIN absolute path. Reject protocol-relative ("//evil.com") and
        // backslash ("/\evil.com") forms that pass a naive startsWith("/") but redirect off-site.
        const next = searchParams.get("next");
        const safeNext =
          next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
            ? next
            : "/monitor";
        router.push(safeNext);
        router.refresh();
        return;
      }
      if (res.status === 401) setError("Invalid email or password.");
      else if (res.status === 502) setError("Archive unreachable.");
      else setError(`Login failed (${res.status}).`);
    } catch {
      setError("Archive unreachable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="pt-6">
        <h1 className="mb-1 font-mono text-lg font-bold tracking-tight">420AI</h1>
        <p className="text-muted-foreground mb-5 text-sm">Sign in to the archive.</p>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            autoComplete="username"
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            aria-label="Email"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            className="border-border bg-background rounded-md border px-3 py-2 text-sm"
            aria-label="Password"
          />
          <button
            type="submit"
            disabled={!email.trim() || !password || busy}
            className={cn(
              "rounded-md border px-4 py-2 text-sm font-medium transition-colors",
              "border-border hover:bg-muted disabled:opacity-50",
            )}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {error ? <span className="text-destructive text-xs">{error}</span> : null}
        </form>
      </CardContent>
    </Card>
  );
}
