"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Persistent top nav (M12 12.2a) rendered by the root layout on every route. A thin client
 * island: it carries NO data and NO token — just `<Link>`s plus `usePathname()` to highlight
 * the active surface. The browser still reaches ingest only through the same-origin proxy
 * Route Handlers (D8); the nav is pure navigation.
 *
 * 12.2b adds /catalog, /pairing, /export, /settings — listing them here now is fine (they
 * 404 until 12.2b ships their pages).
 */
const LINKS: { href: string; label: string }[] = [
  { href: "/monitor", label: "Monitor" },
  { href: "/projects", label: "Projects" },
  { href: "/reports", label: "Reports" },
  { href: "/search", label: "Search" },
  { href: "/machines", label: "Machines" },
  { href: "/catalog", label: "Catalog" },
  { href: "/pairing", label: "Pairing" },
  { href: "/export", label: "Export" },
  { href: "/settings", label: "Settings" },
];

export function AppNav() {
  const pathname = usePathname();
  // M14 14.3: probe the admin identity through the same-origin proxy (the browser never holds the
  // token — /api/auth/me adds the bearer server-side). Hooks stay ABOVE the /login early-return
  // below (Rules of Hooks); the fetch guards on `pathname` instead.
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    // One-shot: skip the login surface, and once the (session-invariant) email is known do NOT
    // re-probe on every client navigation — the re-run when `email` flips null→value is a no-op.
    if (pathname === "/login" || email) return;
    let alive = true;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { email?: string } | null) => {
        if (alive && d?.email) setEmail(d.email);
      })
      .catch(() => {}); // swallow — a missing email just isn't shown
    return () => {
      alive = false;
    };
  }, [pathname, email]);

  // The login page is its own standalone surface — no nav (and no logout to show while logged out).
  if (pathname === "/login") return null;

  // M12 12.3 logout: POST the same-origin logout route (clears the httpOnly cookie), then a hard
  // nav to /login so the middleware re-gates with no session.
  async function logout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <nav className="border-border/60 bg-card/40 border-b backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-6 py-3">
        <span className="mr-4 font-mono text-sm font-bold tracking-tight">420AI</span>
        {LINKS.map((l) => {
          // Active when the path equals the link or is nested under it (e.g. /projects/<id>).
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {l.label}
            </Link>
          );
        })}
        {email ? (
          <span className="text-muted-foreground ml-auto mr-3 font-mono text-xs" title={email}>
            {email}
          </span>
        ) : null}
        <button
          type="button"
          onClick={logout}
          className={cn(
            "text-muted-foreground hover:text-foreground hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            // The email span owns the left auto-margin when present; without it, Logout keeps the
            // right-anchor so layout is unchanged when no email is shown (logged out / 401).
            !email && "ml-auto",
          )}
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
