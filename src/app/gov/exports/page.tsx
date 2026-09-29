import { datasetsForScope, type ExportFilterName } from "@/lib/exports";
import { ExportPanel } from "@/components/forms/export-forms";

/**
 * Government data export (spec §§32, 34, 44).
 *
 * Every dataset is generated on demand — there is no stored file, no export
 * history table and no job queue. The links below are plain GETs to a route
 * handler that streams the rows straight out of the database, so a big export
 * costs the same memory as a small one.
 */
export default async function GovExportsPage() {
  const datasets = datasetsForScope("GOVERNMENT").map((d) => ({
    key: d.key,
    label: d.label,
    description: d.description,
    supports: [...d.supports] as ExportFilterName[],
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Exports</h1>
        <p className="mt-1 text-sm text-muted">
          Download any record set as CSV or JSON. Files are generated when you ask for them and
          never stored anywhere.
        </p>
      </div>

      <section className="card border-[#111111] p-5 text-sm">
        <h2 className="font-medium">About these files</h2>
        <ul className="mt-2 space-y-1 text-muted">
          <li>
            • CSV opens in Excel, Numbers and Google Sheets. Text typed by users is written so a
            spreadsheet always treats it as text, never as a formula.
          </li>
          <li>• JSON keeps every value exactly as the database holds it.</li>
          <li>• No password or security code is present in any export.</li>
          <li>• Every download you make is recorded in the audit log.</li>
          <li>• Support messages already removed by retention cannot appear here.</li>
        </ul>
      </section>

      <ExportPanel datasets={datasets} basePath="/api/gov/export" />
    </div>
  );
}
