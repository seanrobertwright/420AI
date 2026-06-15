import { redirect } from "next/navigation";

/** The dashboard ships ONLY the Live Monitor page in M9 — send the root straight there. */
export default function Home() {
  redirect("/monitor");
}
