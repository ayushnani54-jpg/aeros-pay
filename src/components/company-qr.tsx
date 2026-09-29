import { companyQrSvg } from "@/lib/qr";
import { COMPANY_QR_PIXEL_SIZE } from "@/lib/constants";

/**
 * A company's public-profile QR code (V3 Phase F, spec §21).
 *
 * A plain server component: the SVG is computed during the render that produced
 * the page, embedded inline, and never written anywhere. There is no image
 * route, no redirect hop and therefore nothing that could count a scan — the
 * code contains the public profile URL and nothing else, and the app stores no
 * scan history of any kind.
 *
 * `dangerouslySetInnerHTML` is used because the SVG is a string. Every byte of
 * it comes from this app's own encoder (src/lib/qr.ts) given a validated
 * username and origin — no user input reaches the markup unescaped.
 */
export function CompanyQr({
  origin,
  username,
  pixelSize = COMPANY_QR_PIXEL_SIZE,
}: {
  origin: string;
  username: string;
  pixelSize?: number;
}) {
  let rendered: { svg: string; url: string };
  try {
    rendered = companyQrSvg(origin, username, { pixelSize });
  } catch {
    // A QR code is a convenience. If it cannot be produced, the page renders
    // without it rather than failing.
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-4" data-testid="company-qr">
      <div
        className="shrink-0 rounded-md border border-border bg-white p-2"
        style={{ lineHeight: 0 }}
        dangerouslySetInnerHTML={{ __html: rendered.svg }}
      />
      <div className="min-w-0 text-sm">
        <p className="font-medium">Scan to open this profile</p>
        <p className="mt-1 break-all font-mono text-xs text-muted" data-testid="company-qr-url">
          {rendered.url}
        </p>
        <p className="mt-2 text-xs text-muted">
          The code holds this link and nothing else — no balance, no orders, no payment history.
          Nothing about a scan is recorded.
        </p>
      </div>
    </div>
  );
}
