import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * M12 12.3 logout. Clears the httpOnly session cookie; the next navigation hits the middleware
 * gate with no session → redirect to /login. POST (a mutation) so a prefetch can't log the admin out.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
