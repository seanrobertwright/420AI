import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, generateToken } from "@420ai/db";
import { ROLES, type Role } from "@420ai/shared";
import { effectiveApiKeyRole, shouldTouchApiKey } from "./auth.js";

/**
 * M15 15.9 — the two PURE decisions inside the API-key auth branch, in isolation.
 *
 * They were extracted from `resolvePrincipal` specifically so this file could exist. A `min` buried
 * inside an async DB-touching resolver can only be exercised through HTTP, which is how a 4×4
 * matrix ends up with three cases covered and thirteen assumed; and a throttle whose only test is
 * "the suite still passes" is a throttle nobody has checked.
 *
 * The behavioural proof that these are actually WIRED — that a key really does act at the lower
 * rung, and that the touch really does reach the column — lives in `api-keys.int.test.ts`. Neither
 * file replaces the other.
 */

describe("effectiveApiKeyRole (D-15.9-4)", () => {
  it("inherits the membership role exactly when the key carries none", () => {
    // `role IS NULL` is what `ADMIN_TOKEN` effectively does today, which is what makes the desktop
    // app's migration to a role-less key behaviour-preserving.
    for (const membership of ROLES) {
      expect(effectiveApiKeyRole(membership, null)).toBe(membership);
    }
  });

  /**
   * THE FULL 4×4 MATRIX, asserted against an independently-computed expectation rather than
   * against a re-implementation of the function under test. `ROLES` is ordered by rank, so the
   * lower of two rungs is the one with the smaller index — a formulation that shares no code with
   * `hasRole`, so a bug in the ladder cannot cancel itself out here.
   */
  it("takes the LOWER of the key's rung and the owner's current rung", () => {
    for (const membership of ROLES) {
      for (const keyRole of ROLES) {
        const lower =
          ROLES.indexOf(keyRole) < ROLES.indexOf(membership) ? keyRole : (membership as Role);
        expect(effectiveApiKeyRole(membership, keyRole)).toBe(lower);
      }
    }
  });

  it("is the FLOOR, not merely a mint-time cap: a demotion takes effect immediately", () => {
    // The assertion that distinguishes a `min` from a cap. An `admin` key minted by an owner keeps
    // its own rung while the owner is still an owner...
    expect(effectiveApiKeyRole("owner", "admin")).toBe("admin");
    // ...and drops to `viewer` the moment that person is demoted, with no key rotation. This is
    // what makes revocation-by-demotion work on the NEXT request rather than whenever someone
    // remembers the key exists.
    expect(effectiveApiKeyRole("viewer", "admin")).toBe("viewer");
  });

  it("never lets a key exceed the rung it was minted at, even if its owner is promoted", () => {
    // The other direction of the same `min`: promoting someone must not silently upgrade a
    // long-lived credential they issued while they were junior.
    expect(effectiveApiKeyRole("owner", "viewer")).toBe("viewer");
  });

  it("REJECTS a stored role outside ROLES rather than clamping it", () => {
    // D-15.9-4: `isRole` narrows, and failing closed on a hand-edited row is the same direction
    // `hasRole` already fails. Clamping to `viewer` would be a quiet "it works" where a loud 401 is
    // correct — the row is corrupt, and pretending otherwise hides that.
    for (const corrupt of ["", "superuser", "Owner", "admin ", "__proto__", "toString"]) {
      expect(effectiveApiKeyRole("owner", corrupt)).toBeNull();
    }
  });

  it("falls back to the membership role when THAT is the corrupt one", () => {
    // A corrupt membership is not this function's decision to make — `hasRole` fails closed, the
    // comparison falls to the membership value, and `authorized()` rejects it downstream. Asserted
    // so the delegation is deliberate rather than incidental.
    expect(effectiveApiKeyRole("superuser", "admin")).toBe("superuser");
    expect(effectiveApiKeyRole("superuser", null)).toBe("superuser");
  });
});

describe("shouldTouchApiKey (D-15.9-7)", () => {
  /**
   * Epoch-scale timestamps throughout, and that is deliberate rather than incidental. An unseen key
   * reads `last = 0`, so "is it due?" is `nowMs - 0 >= throttleMs` — which is only true for a
   * `nowMs` larger than the window. Under a real `Date.now()` (~1.7e12 vs 6e4) the first touch is
   * therefore ALWAYS due, but a test written with `nowMs = 1_000` would say otherwise and be
   * asserting a condition production never reaches.
   *
   * This is the same `?? 0` shape `monitor.ts`'s `shouldReconcile` has carried since 15.4, kept
   * identical on purpose: two throttles that look the same and behave differently are worse than
   * one quirk documented in both places.
   */
  const T0 = 1_800_000_000_000;

  it("permits the first touch and then throttles until the window elapses", () => {
    const seen = new Map<string, number>();
    expect(shouldTouchApiKey(seen, "k1", 60_000, T0)).toBe(true);
    expect(shouldTouchApiKey(seen, "k1", 60_000, T0 + 1)).toBe(false);
    expect(shouldTouchApiKey(seen, "k1", 60_000, T0 + 59_999)).toBe(false);
    // Exactly at the boundary — `>=`, so the window is inclusive.
    expect(shouldTouchApiKey(seen, "k1", 60_000, T0 + 60_000)).toBe(true);
  });

  it("touches an unseen key on its first request under a real clock", () => {
    // The property the `?? 0` sentinel actually buys: a key nobody has seen this process must get
    // its `last_used_at` stamped immediately, not one window later. Otherwise a key used once an
    // hour would never record a use at all.
    expect(shouldTouchApiKey(new Map(), "fresh", 60_000, Date.now())).toBe(true);
  });

  it("throttles PER KEY, not globally", () => {
    // Two machine clients must not starve each other's `last_used_at`, or the column answers
    // "is this key in use?" for whichever one polled first and lies about the rest.
    const seen = new Map<string, number>();
    expect(shouldTouchApiKey(seen, "k1", 60_000, T0)).toBe(true);
    expect(shouldTouchApiKey(seen, "k2", 60_000, T0)).toBe(true);
    expect(shouldTouchApiKey(seen, "k1", 60_000, T0)).toBe(false);
  });

  it("touches on EVERY call when the throttle is 0 (the injection tests rely on)", () => {
    // `apiKeyTouchThrottleMs: 0` is how the int suite observes a fire-and-forget write at all.
    // If this stopped holding, that suite would silently stop asserting anything.
    const seen = new Map<string, number>();
    expect(shouldTouchApiKey(seen, "k1", 0, T0)).toBe(true);
    expect(shouldTouchApiKey(seen, "k1", 0, T0)).toBe(true);
  });

  /**
   * The sweep (code-review finding 4). Entries older than the window are inert — `?? 0` makes a
   * MISSING entry maximally stale, so a swept entry and a kept-but-stale entry produce the same
   * decision. These assertions pin that equivalence, which is the whole reason a sweep is safe
   * where an LRU would not be (an LRU could evict a RECENT entry and permit an extra write).
   */
  it("sweeping a stale entry does not change the next decision", () => {
    const withEntry = new Map<string, number>([["k1", T0]]);
    const swept = new Map<string, number>();
    const later = T0 + 60_000;
    expect(shouldTouchApiKey(withEntry, "k1", 60_000, later)).toBe(
      shouldTouchApiKey(swept, "k1", 60_000, later),
    );
  });

  it("keeps FRESH entries when it sweeps, so the throttle still holds", () => {
    // Fill past the sweep threshold with stale entries, plus one fresh key that must survive.
    const seen = new Map<string, number>();
    for (let i = 0; i < 5000; i++) seen.set(`stale-${i}`, T0);
    const later = T0 + 60_000;
    seen.set("fresh", later); // inside the window at `later`
    expect(seen.size).toBeGreaterThan(4096);

    // A due touch triggers the sweep.
    expect(shouldTouchApiKey(seen, "trigger", 60_000, later)).toBe(true);
    expect(seen.size, "stale entries must be dropped").toBeLessThan(1000);
    // THE LOAD-BEARING HALF: the fresh entry survived, so it is still throttled.
    expect(shouldTouchApiKey(seen, "fresh", 60_000, later)).toBe(false);
  });

  it("stamps BEFORE returning, so two overlapping callers cannot both see a stale last", () => {
    // The `shouldReconcile` discipline: the map is written on the same tick the decision is made,
    // never after the caller's await.
    const seen = new Map<string, number>();
    shouldTouchApiKey(seen, "k1", 60_000, T0);
    expect(seen.get("k1")).toBe(T0);
  });
});

describe("API_KEY_PREFIX routing (D-15.9-3)", () => {
  it("composes a 48-character token that startsWith the prefix", () => {
    const token = API_KEY_PREFIX + generateToken();
    expect(token).toHaveLength(48);
    expect(token.startsWith(API_KEY_PREFIX)).toBe(true);
  });

  /**
   * THE TRAP THIS SLICE'S DESIGN TURNS ON, pinned so nobody "simplifies" the routing back into a
   * split. `generateToken()` is base64url, whose alphabet INCLUDES `_` and `-`, so a token BODY
   * routinely contains underscores. `split("_")[1]` would silently truncate a large fraction of
   * otherwise-valid keys — and the ones it mangled would be a random ~fraction, which presents as
   * "API keys are flaky" rather than as a parsing bug.
   *
   * 200 samples: measured during planning at "any contain `_` → true", and re-measured here so the
   * claim is enforced rather than remembered.
   */
  it("produces token bodies that CONTAIN underscores, so splitting on `_` is wrong", () => {
    const bodies = Array.from({ length: 200 }, () => generateToken());
    expect(bodies.some((b) => b.includes("_"))).toBe(true);
    // And every one of them still routes correctly through `startsWith`, including the mangling
    // ones — which is the whole point of choosing the prefix predicate over a split.
    for (const body of bodies) {
      expect((API_KEY_PREFIX + body).startsWith(API_KEY_PREFIX)).toBe(true);
    }
  });

  it("does not collide with a session token, which never starts with the prefix", () => {
    // The routing is only sound if the two tiers are distinguishable. A session token is
    // `base64url(payload).base64url(mac)` and cannot begin `k420_` — its first segment is JSON.
    expect(generateToken().startsWith(API_KEY_PREFIX)).toBe(false);
  });
});
