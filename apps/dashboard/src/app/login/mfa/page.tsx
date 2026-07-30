import { Suspense } from "react";
import { MfaForm } from "@/components/auth/mfa-form";

/**
 * M15 15.8 — the second step of a login. A Server Component shell around the client <MfaForm/>,
 * mirroring `/login/page.tsx` exactly.
 *
 * NOT GATED, and it must be listed EXPLICITLY in the middleware's `PUBLIC` array: that check is exact
 * equality, so `/login` does not cover `/login/mfa`, and without the entry this page redirects to
 * `/login?next=/login/mfa` forever.
 *
 * The `Suspense` boundary is required, not decorative: `MfaForm` calls `useSearchParams()`, which
 * makes the build's prerender fail without one.
 */
export default function MfaPage() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      <Suspense fallback={null}>
        <MfaForm />
      </Suspense>
    </main>
  );
}
