import { getGovernmentSingleton, getRecentAuditLogs } from "@/lib/queries";
import { TaxRateForm } from "@/components/forms/tax-rate-form";
import { formatTaxRateBp } from "@/lib/tax";

export default async function GovTaxPage() {
  const [gov, auditLogs] = await Promise.all([
    getGovernmentSingleton(),
    getRecentAuditLogs(500),
  ]);
  const taxChanges = auditLogs.filter((a) => a.action === "TAX_RATE_CHANGED");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Tax Configuration</h1>

      <section className="card p-5">
        <p className="text-sm text-muted">Current rate</p>
        <p className="mt-1 text-2xl font-semibold">{gov ? formatTaxRateBp(gov.taxRateBp) : "—"}</p>
        <p className="mt-1 text-xs text-muted">
          A payment of exactly 1 Aeros is always tax-free, regardless of this rate.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Change tax rate</h2>
        <TaxRateForm currentPercent={gov ? gov.taxRateBp / 100 : 0} />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Tax rate change history</h2>
        {taxChanges.length === 0 ? (
          <p className="text-sm text-muted">No changes recorded yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {taxChanges.map((a) => {
              const meta = a.metadata as { previousRateBp?: number; newRateBp?: number } | null;
              return (
                <li key={a.id} className="flex items-center justify-between">
                  <span>
                    {meta?.previousRateBp !== undefined
                      ? formatTaxRateBp(meta.previousRateBp)
                      : "—"}{" "}
                    → {meta?.newRateBp !== undefined ? formatTaxRateBp(meta.newRateBp) : "—"}
                  </span>
                  <span className="text-muted">{new Date(a.createdAt).toLocaleString()}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
