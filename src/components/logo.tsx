type AerosLogoProps = {
  className?: string;
  size?: number;
  title?: string;
};

/**
 * The Aeros Pay wordmark icon: a bold, geometric black "A" with two thin
 * parallel "air line" cut-throughs — the Air/AR motif referenced in the
 * brand spec. Pure inline SVG, no external assets, crisp at any size from
 * a 16px favicon up to a large hero mark.
 */
export function AerosLogo({ className, size = 32, title = "Aeros Pay" }: AerosLogoProps) {
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
      {/* The "A" — three bold monoline strokes */}
      <path
        d="M50 14 L14 88"
        stroke="#0a0a0a"
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M50 14 L86 88"
        stroke="#0a0a0a"
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M27.5 60 L72.5 60"
        stroke="#0a0a0a"
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />
      {/* Air / AR double-line cut-through */}
      <path
        d="M6 65 L94 53"
        stroke="var(--logo-cut, #ffffff)"
        strokeWidth="5.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 80 L94 68"
        stroke="var(--logo-cut, #ffffff)"
        strokeWidth="5.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
