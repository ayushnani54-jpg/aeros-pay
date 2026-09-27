/**
 * Loading placeholders.
 *
 * Every page in Aeros Pay is dynamically server-rendered because it reads live
 * balances, so a navigation always costs one database round trip. Without an
 * instant loading state the browser simply sits on the old page for that whole
 * trip, which is what made navigation feel sluggish.
 *
 * Pairing these with a `loading.tsx` lets Next.js paint the new screen
 * immediately and stream the real content in behind it. No animation library
 * and no client-side state — just the built-in pulse on the existing surface
 * colour, so the look is unchanged.
 */

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface ${className}`} />;
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card p-5">
      <SkeletonBlock className="h-4 w-1/3" />
      <div className="mt-4 space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonBlock key={i} className="h-3 w-full" />
        ))}
      </div>
    </div>
  );
}

export function SkeletonPage() {
  return (
    <div className="space-y-6">
      <SkeletonBlock className="h-8 w-48" />
      <div className="card p-6">
        <SkeletonBlock className="h-3 w-24" />
        <SkeletonBlock className="mt-3 h-10 w-40" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-4">
            <SkeletonBlock className="h-3 w-16" />
            <SkeletonBlock className="mt-2 h-5 w-20" />
          </div>
        ))}
      </div>
      <SkeletonCard lines={4} />
    </div>
  );
}
