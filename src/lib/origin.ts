import "server-only";
import { headers } from "next/headers";

/**
 * The site origin of the CURRENT request, e.g. "http://localhost:3000" or
 * "https://aeros.example".
 *
 * A QR code has to contain an absolute URL, and the app has no configured
 * public hostname — it is whatever the deployment is served from. So the origin
 * is read from the request itself rather than an environment variable, which
 * means a code generated on a staging host links to staging and one generated
 * on production links to production, with nothing to keep in sync.
 *
 * Host headers are client-controlled, so the value is validated to look like a
 * host before it is used, and it only ever ends up inside a link the viewer
 * themselves is looking at — never in a redirect, an email or anything stored.
 */
export async function getRequestOrigin(): Promise<string> {
  const h = await headers();
  const forwardedHost = h.get("x-forwarded-host");
  const host = (forwardedHost ?? h.get("host") ?? "").trim();

  // Hostname[:port], nothing else. Anything odd falls back to a relative-safe
  // localhost origin rather than being echoed into a link.
  if (!/^[a-zA-Z0-9.-]+(:\d{1,5})?$/.test(host)) {
    return "http://localhost:3000";
  }

  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim();
  const scheme =
    proto === "https" || proto === "http"
      ? proto
      : host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https";

  return `${scheme}://${host}`;
}
