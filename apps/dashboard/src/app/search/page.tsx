import { SearchView } from "@/components/search/search-view";

// No initial fetch — search is query-driven; the client view fetches the same-origin proxy on
// submit. force-dynamic keeps it out of static prerender (consistent with the other surfaces).
export const dynamic = "force-dynamic";

export default function SearchPage() {
  return <SearchView />;
}
