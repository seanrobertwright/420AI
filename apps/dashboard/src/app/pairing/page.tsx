import { PairingView } from "@/components/pairing/pairing-view";

// No initial fetch — pairing is generate-only (there is no list endpoint); the client view POSTs
// the same-origin proxy on demand. force-dynamic keeps it out of static prerender.
export const dynamic = "force-dynamic";

export default function PairingPage() {
  return <PairingView />;
}
