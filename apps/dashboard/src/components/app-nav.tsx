"use client";

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
        <button
          type="button"
          onClick={logout}
          className="text-muted-foreground hover:text-foreground hover:bg-muted ml-auto rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
