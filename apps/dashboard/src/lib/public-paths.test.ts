import { describe, expect, it } from "vitest";
import { isPublicPath, PUBLIC_PATHS, PUBLIC_PREFIXES } from "./public-paths";

/**
 * M15 15.10 — the cheapest possible guard on the highest-risk line in the slice.
 *
 * The failure this pins does not look like a frontend bug when it happens: an invited colleague
 * clicks the one link the product emails them and lands on `/login?next=/invite/<token>` — a login
 * page they have no account for. Every previous incarnation of this trap (`/login/mfa`, twice) was
 * found by comparing screenshots by hand. This is four assertions instead.
 */
describe("isPublicPath", () => {
  it("has entries at all (a vacuous list would make every assertion below pass)", () => {
    expect(PUBLIC_PATHS.length).toBeGreaterThan(0);
    expect(PUBLIC_PREFIXES.length).toBeGreaterThan(0);
  });

  it("lets an invite token through", () => {
    expect(isPublicPath("/invite/abc123")).toBe(true);
    // A real token is 32 random bytes hex/base64url — nothing about the shape may matter.
    expect(isPublicPath("/invite/AbC-_9zZ".repeat(4))).toBe(true);
  });

  it("does NOT publish /invite or /invitex", () => {
    // The trailing slash in the prefix is what makes both of these gated. `/invite` alone has no
    // token so there is nothing to preview; `/invitex` is the accidental-neighbour case that a
    // prefix without the slash would silently publish.
    expect(isPublicPath("/invite")).toBe(false);
    expect(isPublicPath("/invitex")).toBe(false);
    expect(isPublicPath("/invitex/abc")).toBe(false);
  });

  it("keeps both login steps public and everything else gated", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/login/mfa")).toBe(true);
    for (const gated of ["/", "/team", "/monitor", "/settings", "/login/other", "/loginx"]) {
      expect(isPublicPath(gated), `${gated} must require a session`).toBe(false);
    }
  });
});
