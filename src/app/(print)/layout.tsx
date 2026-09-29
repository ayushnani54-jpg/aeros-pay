/**
 * PRINT LAYOUT (spec §9)
 *
 * A route group with no app chrome: no navbar, no bottom tab bar, no context
 * banner — just the document. The browser's own "Print… → Save as PDF" then
 * produces a clean one-page invoice, which is why this phase adds no PDF
 * dependency of any kind.
 *
 * The rules below are the whole print stylesheet. They keep the existing design
 * tokens (same card border, same type scale) and only do what a screen layout
 * cannot: force light colours, drop the shadows and margins the paper does not
 * need, and hide anything marked `no-print`.
 */
export default function PrintLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <style>{`
        .print-sheet { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
        @media print {
          @page { margin: 14mm; }
          html, body {
            background: #ffffff !important;
            color: #111111 !important;
          }
          .no-print { display: none !important; }
          .print-sheet { padding: 0; max-width: none; }
          .print-sheet .card {
            border: none !important;
            border-radius: 0 !important;
            padding: 0 !important;
          }
          a[href]::after { content: ""; }
        }
      `}</style>
      <div className="print-sheet">{children}</div>
    </>
  );
}
