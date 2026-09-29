import Link from "next/link";
import { getAllCompaniesForGovernment, getGovernmentSingleton, getRecentAuditLogs } from "@/lib/queries";
import { TaxRateForm } from "@/components/forms/tax-rate-form";
import {
  CompanyDefaultTaxForm,
  EconomyPolicyForm,
  OfflinePolicyForm,
} from "@/components/forms/gov-forms";
import { formatTaxRateBp } from "@/lib/tax";
import { formatDateTime } from "@/lib/datetime";
import { CURRENCY_NAME } from "@/lib/constants";

export default async function GovTaxPage() {
  const [gov, companies, auditLogs] = await Promise.all([
    getGovernmentSingleton(),
    getAllCompaniesForGovernment(),
    getRecentAuditLogs(200),
  ]);

  if (!gov) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">The Government account is not initialized.</p>
      </div>
    );
  }

  const taxHistory = auditLogs.filter((log) =>
    [
      "TAX_RATE_CHANGED",
      "COMPANY_TAX_DEFAULT_CHANGED",
      "COMPANY_TAX_RATE_CHANGED",
      "ECONOMY_POLICY_CHANGED",
    ].includes(log.action),
  );

  const withOverride = companies.filter((c) => c.company.taxRateBp !== null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Taxes</h1>
        <p className="mt-1 text-sm text-muted">
          Changing a rate only affects future transactions. Every past transaction permanently
          keeps the rate that applied when it happened.
        </p>
      </div>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="card p-5">
          <h2 className="mb-1 font-medium">Personal tax</h2>
          <p className="mb-4 text-sm text-muted">
            Applies to user-to-user payments. A payment of exactly 1 {CURRENCY_NAME} is always
            tax-free.
          </p>
          <TaxRateForm currentPercent={gov.taxRateBp / 100} />
        </div>

        <div className="card p-5">
          <h2 className="mb-1 font-medium">Default company tax</h2>
          <p className="mb-4 text-sm text-muted">
            Used for any company that has no rate of its own.
          </p>
          <CompanyDefaultTaxForm currentPercent={gov.companyTaxRateBp / 100} />
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-1 font-medium">Economy policy</h2>
        <p className="mb-4 text-sm text-muted">
          Company approval funding, the per-execution issuance cap, and the issuance cooldown.
          These used to be fixed constants — now live and editable here.
        </p>
        <EconomyPolicyForm
          companyApprovalFundingAmount={gov.companyApprovalFundingAmount}
          maxIssuanceAmount={gov.maxIssuanceAmount}
          issuanceCooldownDays={gov.issuanceCooldownDays}
        />
      </section>

      <section className="card p-5">
        <h2 className="mb-1 font-medium">Offline payments (PWA)</h2>
        <p className="mb-4 text-sm text-muted">
          Controls whether a personal wallet may fetch a short offline authorization while online
          and spend against it while disconnected. A synced offline payment uses the exact same
          tax and balance rules as any other payment.
        </p>
        <OfflinePolicyForm
          policy={{
            enabled: gov.offlineTransactionsEnabled,
            totalAllowance: gov.offlineTotalAllowance,
            maxPerTransaction: gov.offlineMaxPerTransaction,
            authExpiryMinutes: gov.offlineAuthExpiryMinutes,
          }}
        />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">How tax is applied</h2>
        <dl className="space-y-1 text-sm">
          <Rule rule="User → User" value={`${formatTaxRateBp(gov.taxRateBp)} (personal rate)`} />
          <Rule rule="User → Company" value="The receiving company's rate" />
          <Rule rule="Company → User" value="The sending company's rate" />
          <Rule rule="Company → Company" value="The sending company's rate" />
          <Rule rule="Government → anyone" value="Tax-free" />
          <Rule rule="Anyone → Government" value="Tax-free" />
          <Rule rule="Invoices" value="Company rate, added on top of the quoted price" />
        </dl>
      </section>

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Per-company rates</h2>
          <Link
            href="/gov/companies"
            className="text-sm font-medium text-muted hover:text-foreground"
          >
            All companies
          </Link>
        </div>
        {withOverride.length === 0 ? (
          <p className="text-sm text-muted">
            No company has a custom rate — all use the {formatTaxRateBp(gov.companyTaxRateBp)}{" "}
            default.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {withOverride.map(({ company }) => (
              <Link
                key={company.id}
                href={`/gov/companies/${company.id}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <div>
                  <p className="font-medium">{company.name}</p>
                  <p className="text-xs text-muted">@{company.username}</p>
                </div>
                <span className="font-mono">{formatTaxRateBp(company.taxRateBp ?? 0)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Change history</h2>
        {taxHistory.length === 0 ? (
          <p className="text-sm text-muted">No tax changes recorded yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {taxHistory.map((log) => (
              <div key={log.id} className="py-3 text-sm">
                <p className="font-medium">{log.action.replace(/_/g, " ")}</p>
                <p className="text-xs text-muted">
                  {log.previousValue ?? "—"} → {log.newValue ?? "—"} · {log.actorLabel} ·{" "}
                  {formatDateTime(log.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Rule({ rule, value }: { rule: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{rule}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
