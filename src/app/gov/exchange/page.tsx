import Link from "next/link";
import { getCurrentGovernment } from "@/lib/auth";
import {
  getAllExchangePolicies,
  getGovExchangePurchases,
} from "@/lib/exchange";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import {
  GovExchangePolicyForm,
  GovReviewExchangePurchaseForm,
} from "@/components/v4/v4-forms";

export default async function GovExchangePage() {
  const gov = await getCurrentGovernment();
  if (!gov) return null;

  const [policies, purchases] = await Promise.all([
    getAllExchangePolicies(),
    getGovExchangePurchases(100),
  ]);

  const pendingPurchases = purchases.filter(
    (r) => r.purchase.status === "AWAITING_CONFIRMATION",
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Aeros Exchange — Policy &amp; Acquisitions
          </h1>
          <p className="mt-1 text-sm text-muted">
            Versioned INR/package policies and manual confirmation of user Exchange acquisition
            requests.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`badge ${
              gov.exchangeEnabled ? "badge-active" : "badge-suspended"
            }`}
          >
            Exchange: {gov.exchangeEnabled ? "ENABLED" : "DISABLED"}
          </span>
          <Link href="/gov/control-room" className="btn btn-secondary text-xs">
            Feature Controls
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-muted">Treasury balance</p>
          <p className="mt-1 text-xl font-semibold">
            {gov.balance.toLocaleString()} {CURRENCY_NAME}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Active package policies</p>
          <p className="mt-1 text-xl font-semibold">
            {policies.filter((p) => p.active).length}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Awaiting confirmation</p>
          <p className="mt-1 text-xl font-semibold">{pendingPurchases.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Credited acquisitions</p>
          <p className="mt-1 text-xl font-semibold">
            {purchases.filter((r) => r.purchase.status === "CREDITED").length}
          </p>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-medium">Create or version an Exchange package policy</h2>
        <p className="mt-1 mb-4 text-xs text-muted">
          Re-using an existing <span className="font-mono">policyCode</span> (e.g.{" "}
          <span className="font-mono">PKG-STARTER</span>) automatically supersedes the previous
          version and creates a new versioned policy row. Past purchases always retain their frozen
          policy snapshot.
        </p>
        <GovExchangePolicyForm />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">
          Pending acquisition requests ({pendingPurchases.length})
        </h2>
        {pendingPurchases.length === 0 ? (
          <p className="text-sm text-muted">
            No user Exchange requests are currently awaiting confirmation.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {pendingPurchases.map(({ purchase: p, username, displayName }) => (
              <div key={p.id} className="py-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{p.purchaseNumber}</span>
                      <Link
                        href={`/gov/users/${p.userId}`}
                        className="font-medium hover:underline"
                      >
                        {displayName} (@{username})
                      </Link>
                      <span className="badge badge-pending">{p.status}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      Package: <strong>{p.packageTitleSnapshot}</strong> (
                      <span className="font-mono">
                        {p.policyCodeSnapshot} v{p.policyVersionSnapshot}
                      </span>
                      ) · Tier: <strong>₹{p.inrPriceSnapshot.toLocaleString("en-IN")}</strong> →{" "}
                      <strong>
                        {p.totalAerosSnapshot.toLocaleString()} {CURRENCY_NAME}
                      </strong>{" "}
                      ({p.aerosAmountSnapshot.toLocaleString()} base +{" "}
                      {p.bonusAerosSnapshot.toLocaleString()} bonus)
                    </p>
                    {p.paymentReference && (
                      <p className="mt-0.5 text-xs text-muted">
                        User payment reference:{" "}
                        <span className="font-mono text-foreground">{p.paymentReference}</span>
                      </p>
                    )}
                    <p className="mt-0.5 text-[11px] text-muted">
                      Requested {formatDateTime(p.createdAt)} · Mode: {p.paymentMode}
                    </p>
                  </div>
                </div>

                <div className="mt-3">
                  <GovReviewExchangePurchaseForm purchaseId={p.id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Package policy version history</h2>
        <div className="divide-y divide-border text-sm">
          {policies.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold">
                    {p.policyCode} v{p.version}
                  </span>
                  <span className="font-medium">{p.title}</span>
                  <span
                    className={`badge ${
                      p.active ? "badge-active" : "badge-suspended"
                    }`}
                  >
                    {p.active ? "ACTIVE" : "SUPERSEDED / INACTIVE"}
                  </span>
                </div>
                {p.description && (
                  <p className="mt-0.5 text-xs text-muted">{p.description}</p>
                )}
                <p className="mt-0.5 text-[11px] text-muted">
                  Created {formatDateTime(p.createdAt)}
                  {p.supersededAt ? ` · Superseded ${formatDateTime(p.supersededAt)}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="font-semibold">
                  ₹{p.inrPrice.toLocaleString("en-IN")} →{" "}
                  {p.totalAeros.toLocaleString()} {CURRENCY_NAME}
                </p>
                <p className="text-xs text-muted">
                  {p.aerosAmount.toLocaleString()} base + {p.bonusAeros.toLocaleString()} bonus
                </p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">All Exchange purchase records</h2>
        {purchases.length === 0 ? (
          <p className="text-sm text-muted">No Exchange purchases recorded yet.</p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {purchases.map(({ purchase: p, username, displayName }) => (
              <div
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{p.purchaseNumber}</span>
                    <Link
                      href={`/gov/users/${p.userId}`}
                      className="font-medium hover:underline"
                    >
                      {displayName} (@{username})
                    </Link>
                    <span className="font-mono text-xs text-muted">
                      {p.policyCodeSnapshot} v{p.policyVersionSnapshot}
                    </span>
                    <span
                      className={`badge ${
                        p.status === "CREDITED"
                          ? "badge-active"
                          : p.status === "AWAITING_CONFIRMATION"
                            ? "badge-pending"
                            : "badge-suspended"
                      }`}
                    >
                      {p.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {formatDateTime(p.createdAt)}
                    {p.creditedTxRef ? ` · Ledger ref ${p.creditedTxRef}` : ""}
                    {p.reviewNote ? ` · Note: ${p.reviewNote}` : ""}
                  </p>
                </div>
                <div className="text-right font-semibold">
                  ₹{p.inrPriceSnapshot.toLocaleString("en-IN")} /{" "}
                  {p.totalAerosSnapshot.toLocaleString()} {CURRENCY_NAME}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
