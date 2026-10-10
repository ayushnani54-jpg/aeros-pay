import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getGovernmentFeatureFlags } from "@/lib/queries";
import {
  getActiveExchangePolicies,
  getUserExchangePurchases,
} from "@/lib/exchange";
import {
  CURRENCY_NAME,
  DEFAULT_EXCHANGE_DISCLOSURE,
} from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import {
  CancelExchangePurchaseButton,
  ExchangePurchaseForm,
} from "@/components/v4/v4-forms";

export default async function AerosExchangePage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user } = ctx;
  const [flags, policies, purchases] = await Promise.all([
    getGovernmentFeatureFlags(),
    getActiveExchangePolicies(),
    getUserExchangePurchases(user.id, 40),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Aeros Exchange</h1>
          <p className="mt-1 text-sm text-muted">
            Government-controlled INR package policies for acquiring virtual {CURRENCY_NAME} from the Treasury.
          </p>
        </div>
        <div className="rounded-md border border-border bg-surface px-3 py-2 text-right">
          <p className="text-[11px] text-muted">Personal wallet balance</p>
          <p className="text-sm font-semibold">
            {user.balance.toLocaleString()} {CURRENCY_NAME}
          </p>
        </div>
      </div>

      <section className="card border-[#111111] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Private Virtual Economy &amp; Policy Separation Notice
          </h2>
          <span className="rounded bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
            {flags.exchangeLivePaymentsEnabled
              ? "Verified Payment Integration"
              : "Safe Manual / Dev Confirmation Mode"}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {DEFAULT_EXCHANGE_DISCLOSURE}
        </p>
        <p className="mt-2 text-xs text-muted">
          <strong>Strict separation from Aeros Market:</strong> Package contents and INR reference
          tiers below are set exclusively by versioned Government policy and never change
          automatically when the synthetic{" "}
          <Link href="/aeros-market" className="underline">
            Aeros Market index
          </Link>{" "}
          moves. Clicking a package records an uncredited acquisition request with an immutable
          policy snapshot; virtual {CURRENCY_NAME} are transferred from the Government Treasury only
          after explicit Government verification.
        </p>
      </section>

      {!flags.exchangeEnabled ? (
        <section className="card p-6 text-center">
          <h2 className="font-medium">Aeros Exchange is currently paused</h2>
          <p className="mt-1 text-sm text-muted">
            The Government has temporarily disabled new Exchange package requests. Your existing
            purchase records and wallet balances remain intact.
          </p>
        </section>
      ) : policies.length === 0 ? (
        <section className="card p-6 text-center">
          <p className="text-sm text-muted">
            No active Exchange packages are published right now.
          </p>
        </section>
      ) : (
        <section className="space-y-3">
          <h2 className="font-medium">Available Government packages</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {policies.map((pkg) => (
              <div
                key={pkg.id}
                className="card flex flex-col justify-between p-5"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted">
                      {pkg.policyCode} · v{pkg.version}
                    </span>
                    {pkg.bonusAeros > 0 && (
                      <span className="rounded bg-surface px-2 py-0.5 text-[11px] font-medium text-success">
                        +{pkg.bonusAeros.toLocaleString()} bonus
                      </span>
                    )}
                  </div>
                  <h3 className="mt-1.5 text-base font-semibold">{pkg.title}</h3>
                  {pkg.description && (
                    <p className="mt-1 text-xs text-muted">{pkg.description}</p>
                  )}

                  <div className="mt-4 rounded-md bg-surface p-3">
                    <p className="text-xs text-muted">Policy reference tier</p>
                    <p className="text-xl font-semibold">
                      ₹{pkg.inrPrice.toLocaleString("en-IN")}
                    </p>
                    <div className="mt-2 border-t border-border pt-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted">Base allocation</span>
                        <span>
                          {pkg.aerosAmount.toLocaleString()} {CURRENCY_NAME}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">Bonus allocation</span>
                        <span>
                          +{pkg.bonusAeros.toLocaleString()} {CURRENCY_NAME}
                        </span>
                      </div>
                      <div className="mt-1 flex justify-between font-semibold">
                        <span>Total credited on approval</span>
                        <span>
                          {pkg.totalAeros.toLocaleString()} {CURRENCY_NAME}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <ExchangePurchaseForm policy={pkg} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-medium">Your Exchange acquisition requests</h2>
            <p className="text-xs text-muted">
              Every request retains the exact package policy version and snapshot that applied when
              you submitted it.
            </p>
          </div>
          <Link href="/refunds" className="btn btn-secondary text-xs">
            Refund Center
          </Link>
        </div>

        {purchases.length === 0 ? (
          <p className="text-sm text-muted">
            You have not submitted any Aeros Exchange package requests yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {purchases.map((p) => (
              <div
                key={p.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3.5 text-sm"
              >
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{p.purchaseNumber}</span>
                    <span className="font-medium">{p.packageTitleSnapshot}</span>
                    <span className="font-mono text-xs text-muted">
                      ({p.policyCodeSnapshot} v{p.policyVersionSnapshot})
                    </span>
                    <ExchangeStatusPill status={p.status} />
                  </div>
                  <p className="text-xs text-muted">
                    Snapshot: ₹{p.inrPriceSnapshot.toLocaleString("en-IN")} →{" "}
                    <strong>
                      {p.totalAerosSnapshot.toLocaleString()} {CURRENCY_NAME}
                    </strong>{" "}
                    ({p.aerosAmountSnapshot.toLocaleString()} base +{" "}
                    {p.bonusAerosSnapshot.toLocaleString()} bonus) · Mode:{" "}
                    <span className="font-mono">{p.paymentMode}</span>
                  </p>
                  {p.paymentReference && (
                    <p className="text-xs text-muted">
                      Reference note: <span className="font-mono">{p.paymentReference}</span>
                    </p>
                  )}
                  {p.reviewNote && (
                    <p className="text-xs text-muted">Government note: {p.reviewNote}</p>
                  )}
                  <p className="text-[11px] text-muted">
                    Requested {formatDateTime(p.createdAt)}
                    {p.creditedAt ? ` · Credited ${formatDateTime(p.creditedAt)}` : ""}
                    {p.creditedTxRef ? ` · Ledger ref ${p.creditedTxRef}` : ""}
                  </p>
                </div>

                {p.status === "AWAITING_CONFIRMATION" && (
                  <CancelExchangePurchaseButton purchaseId={p.id} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ExchangeStatusPill({ status }: { status: string }) {
  const styles =
    status === "CREDITED"
      ? "badge badge-active"
      : status === "AWAITING_CONFIRMATION"
        ? "badge badge-pending"
        : status === "REFUNDED"
          ? "badge badge-suspended"
          : "badge badge-banned";
  return <span className={styles}>{status.replaceAll("_", " ")}</span>;
}
