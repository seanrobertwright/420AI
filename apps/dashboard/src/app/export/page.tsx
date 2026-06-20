import { ExportView } from "@/components/export/export-view";

// No initial fetch — exports are download triggers; the client view builds same-origin proxy
// URLs the browser downloads. force-dynamic keeps it out of static prerender.
export const dynamic = "force-dynamic";

export default function ExportPage() {
  return <ExportView />;
}
