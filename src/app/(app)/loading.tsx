import { SkeletonPage } from "@/components/skeleton";

/**
 * Instant loading state for every user-area route. Next.js paints this the
 * moment a link is clicked, so navigation feels immediate even though the
 * page itself still has to read live balances from the database.
 */
export default function Loading() {
  return <SkeletonPage />;
}
