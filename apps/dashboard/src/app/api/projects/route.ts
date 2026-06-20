import { proxyJson } from "@/lib/proxy";

/** List projects (M12 12.2a). GET `/v1/projects` → `{ projects: ProjectRow[] }`. (POST create is 12.2b.) */
export const dynamic = "force-dynamic";

export async function GET() {
  return proxyJson("/v1/projects");
}
