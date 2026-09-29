import { requireActingContext } from "@/lib/auth";
import {
  ExportError,
  companyScopeFor,
  exportHeaders,
  getDataset,
  parseExportFilters,
  parseFormat,
  streamExport,
  userScopeFor,
  type ExportScope,
} from "@/lib/exports";

/**
 * USER AND COMPANY EXPORTS (spec §§33, 44)
 *
 * THE SCOPE IS DERIVED, NEVER SUPPLIED.
 *
 * `getActingContext` re-reads the logged-in user from the session and the
 * company from the database, and returns a company only if the row still
 * exists, is still owned by this user, is approved and is not under Government
 * stewardship. `companyScopeFor` then asserts the ownership again, at the
 * export boundary.
 *
 * Note what this route does NOT do: it never reads a user id, company id or
 * username out of the URL. `?as=<other company>` is not "rejected" — there is
 * no such parameter to reject, which is a stronger position than validating
 * one. A caller who wants their company's records switches wallet in the app,
 * exactly as they would to do anything else as that company.
 *
 * `scope=company` selects WHICH of the caller's own two identities to export;
 * it can only ever narrow to something the session already proves.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ dataset: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return json({ error: "Please log in." }, 401);
  }

  const { dataset: key } = await context.params;
  const url = new URL(request.url);
  const wantsCompany = url.searchParams.get("scope")?.toLowerCase() === "company";

  let scope: ExportScope;
  try {
    scope = wantsCompany ? companyScopeFor(ctx.user, ctx.company) : userScopeFor(ctx.user);
  } catch (e) {
    return json({ error: e instanceof ExportError ? e.message : "Not allowed." }, 403);
  }

  let dataset;
  try {
    dataset = getDataset(key, scope.kind);
  } catch (e) {
    return json({ error: e instanceof ExportError ? e.message : "Unknown export." }, 404);
  }

  // Filters may narrow a personal export, but every identity-shaped filter is
  // ignored for a non-Government scope: the dataset's own scope branch decides
  // whose rows are readable, and it never consults `filters.user`/`.company`.
  const filters = parseExportFilters(url.searchParams);
  const format = parseFormat(url.searchParams.get("format"));

  const at = new Date();
  return new Response(streamExport(dataset, scope, filters, format, { generatedAt: at }), {
    headers: exportHeaders(`${scope.kind.toLowerCase()}-${dataset.key}`, format, at),
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
