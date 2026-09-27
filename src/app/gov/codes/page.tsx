import { getAllRegistrationCodes } from "@/lib/queries";
import { CodeStatusBadge } from "@/components/status-badge";
import { GenerateCodeButton, RevokeCodeButton } from "@/components/forms/registration-code-actions";

export default async function GovCodesPage() {
  const codes = await getAllRegistrationCodes();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Registration Codes</h1>
      </div>

      <section className="card p-5">
        <GenerateCodeButton />
      </section>

      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Used at</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {codes.map((c) => (
              <tr key={c.id} className="hover:bg-surface">
                <td className="px-4 py-3 font-mono text-base font-semibold">{c.code}</td>
                <td className="px-4 py-3">
                  <CodeStatusBadge status={c.status} />
                </td>
                <td className="px-4 py-3 text-muted">{new Date(c.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-muted">
                  {c.usedAt ? new Date(c.usedAt).toLocaleString() : "—"}
                </td>
                <td className="px-4 py-3">
                  {c.status === "UNUSED" && <RevokeCodeButton codeId={c.id} />}
                </td>
              </tr>
            ))}
            {codes.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted">
                  No registration codes yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
