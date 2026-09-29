import { db } from "@/db/client";
import { recordAudit } from "@/lib/audit";
import { requireGovernment } from "@/lib/auth";
import {
  ExportError,
  describeFilters,
  exportHeaders,
  getDataset,
  parseExportFilters,
  parseFormat,
  streamExport,
} from "@/lib/exports";

/**
 * GOVERNMENT EXPORTS (spec §§32, 44)
 *
 * Authorization is the FIRST statement and it is the Government session —
 * `requireGovernment` reads the signed Government cookie and the `government`
 * row, exactly as every Government page does. There is no token parameter, no
 * bypass for a badge, and no "internal" header that skips it.
 *
 * The audit row is written BEFORE the stream starts, so an export that the
 * client abandons halfway is still recorded as having been requested. It
 * records who asked, for what, with which filters — never the contents.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ dataset: string }> },
): Promise<Response> {
  let gov;
  try {
    gov = await requireGovernment();
  } catch {
    return new Response(JSON.stringify({ error: "Government authorization required." }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const { dataset: key } = await context.params;
  const url = new URL(request.url);
  const filters = parseExportFilters(url.searchParams);
  const format = parseFormat(url.searchParams.get("format"));

  let dataset;
  try {
    dataset = getDataset(key, "GOVERNMENT");
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof ExportError ? e.message : "Unknown export." }),
      {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      },
    );
  }

  await recordAudit(db, {
    action: "DATA_EXPORTED",
    actorType: "GOVERNMENT",
    actorId: gov.id,
    actorLabel: gov.username,
    targetType: "EXPORT",
    targetId: dataset.key,
    metadata: { format, filters: describeFilters(filters) },
  });

  const at = new Date();
  return new Response(streamExport(dataset, { kind: "GOVERNMENT" }, filters, format, { generatedAt: at }), {
    headers: exportHeaders(dataset.key, format, at),
  });
}
