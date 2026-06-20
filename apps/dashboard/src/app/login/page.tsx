import { Suspense } from "react";
import { LoginForm } from "@/components/auth/login-form";

/**
 * M12 12.3 login page — a Server Component shell (so metadata/layout compose normally) that renders
 * the client <LoginForm/>. NOT gated (it's in the middleware PUBLIC list). The form uses
 * useSearchParams(), which must sit under a Suspense boundary for the build to prerender cleanly.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-[70vh] items-center justify-center px-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
