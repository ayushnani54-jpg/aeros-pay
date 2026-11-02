type AerosLogoProps = {
  className?: string;
  size?: number;
  title?: string;
};

/**
 * The Aeros Pay wordmark icon: a bold, geometric "A" with two thin
 * parallel "air line" cut-throughs — the Air/AR sovereign economy motif.
 *
 * Adaptive Theme Architecture:
 * - Uses `currentColor` for the "A" geometry strokes so it dynamically inherits
 *   the appropriate text color (crisp dark in light mode, clean white/zinc in dark mode).
 * - Uses `var(--background, #ffffff)` for the cut-through strokes so they always
 *   match the active surface background cleanly without visual artifacts.
 */
export function AerosLogo({ className = "text-foreground", size = 32, title = "Aeros Pay" }: AerosLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {/* The "A" — three bold monoline strokes adapting to current text theme */}
      <path
        d="M50 14 L14 88"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M50 14 L86 88"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M27.5 60 L72.5 60"
        stroke="currentColor"
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />
      {/* Air / AR double-line cut-through matching the active background */}
      <path
        d="M6 65 L94 53"
        stroke="var(--background, #ffffff)"
        strokeWidth="5.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 80 L94 68"
        stroke="var(--background, #ffffff)"
        strokeWidth="5.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
