import Link from "next/link";
import { getGovernmentSingleton, getAllUpdates } from "@/lib/queries";
import { formatTaxRateBp } from "@/lib/tax";
import { AerosLogo } from "@/components/logo";

/**
 * The Government's public profile (spec §31).
 *
 * Shows identity, the published rates, announcements and the ways to reach or
 * pay the Government. The treasury balance is deliberately NOT public.
 */
export default async function GovernmentProfilePage() {
  const [gov, updates] = await Promise.all([getGovernmentSingleton(), getAllUpdates(5)]);

  if (!gov) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">The Government account is not initialized yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="card p-6">
        <div className="flex items-center gap-3">
          <AerosLogo size={36} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Government</h1>
            <p className="font-mono text-sm text-muted">@{gov.username}</p>
          </div>
        </div>

        <p className="mt-4 text-sm text-muted">
          The Government issues registration codes, funds new accounts and companies, sets tax
          rates, and administers the Aeros economy.
        </p>

        <dl className="mt-5 space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Personal tax rate</dt>
            <dd>{formatTaxRateBp(gov.taxRateBp)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Default company tax rate</dt>
            <dd>{formatTaxRateBp(gov.companyTaxRateBp)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Company loan rate</dt>
            <dd>
              {gov.loansEnabled ? formatTaxRateBp(gov.loanInterestRateBp) : "Lending closed"}
            </dd>
          </div>
        </dl>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/pay" className="btn btn-primary text-sm">
            Pay the Government
          </Link>
          <Link href="/contact-government" className="btn btn-secondary text-sm">
            Contact Government
          </Link>
          <Link href="/updates" className="btn btn-secondary text-sm">
            All updates
          </Link>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Recent announcements</h2>
        {updates.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">No announcements yet.</p>
          </div>
        ) : (
          updates.map((update) => (
            <article key={update.id} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-medium">{update.title}</h3>
                <span className="shrink-0 text-xs text-muted">
                  {new Date(update.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="mt-2 whitespace-pre-line text-sm text-muted">{update.content}</p>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
