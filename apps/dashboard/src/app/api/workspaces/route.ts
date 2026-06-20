import { proxyJson } from "@/lib/proxy";

/** List workspaces (M12 12.2a). GET `/v1/workspaces` → `{ workspaces: WorkspaceRow[] }`. (Remap is 12.2b.) */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/workspaces");
}
