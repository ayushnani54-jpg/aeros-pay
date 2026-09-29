/**
 * Star display. Pure presentation, no state, safe in a server component.
 *
 * Uses the existing type scale and the muted/foreground colours — no new
 * palette entry and no icon font. A filled star is the foreground colour, an
 * empty one the muted colour, exactly like the rest of the app's iconography.
 */
export function RatingStars({
  stars,
  size = 14,
}: {
  stars: number;
  size?: number;
}) {
  // FLOOR, not round: an average of 4.5 shows four filled stars beside the
  // printed "4.5" rather than five, so the picture never flatters the number.
  // Individual ratings are whole numbers, so this changes nothing for them.
  const filled = Math.max(0, Math.min(5, Math.floor(stars)));
  const label = Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
  return (
    <span
      className="inline-flex items-center gap-0.5 align-middle"
      role="img"
      aria-label={`${label} out of 5 stars`}
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <svg
          key={n}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill={n <= filled ? "#111111" : "none"}
          stroke={n <= filled ? "#111111" : "#9a9a9a"}
          strokeWidth="1.8"
        >
          <path
            d="M12 3.5l2.6 5.6 6.1.8-4.4 4.2 1.1 6.1L12 17.4l-5.4 2.8 1.1-6.1L3.3 9.9l6.1-.8z"
            strokeLinejoin="round"
          />
        </svg>
      ))}
    </span>
  );
}

/** "4.6 · 12 ratings", or a plain note when there are none yet. */
export function RatingSummaryLine({
  average,
  count,
}: {
  average: number | null;
  count: number;
}) {
  if (count === 0 || average === null) {
    return <span className="text-sm text-muted">No ratings yet</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm" data-testid="rating-summary">
      <RatingStars stars={average} />
      <span className="font-medium">{average.toFixed(1)}</span>
      <span className="text-muted">
        · {count} {count === 1 ? "rating" : "ratings"}
      </span>
    </span>
  );
}
