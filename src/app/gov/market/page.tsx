import Link from "next/link";
import { getCurrentGovernment } from "@/lib/auth";
import {
  getMarketChartData,
  getRecentMarketOrdersForGov,
} from "@/lib/synthetic-market";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import { GovMarketConfigForm } from "@/components/v4/v4-forms";

export default async function GovMarketPage() {
  const gov = await getCurrentGovernment();
  if (!gov) return null;

  const [chart15m, recentOrders] = await Promise.all([
    getMarketChartData("15m", 48),
    getRecentMarketOrdersForGov(80),
  ]);

  const { state, stats24h } = chart15m;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Synthetic Market Index &amp; Trading Controls
          </h1>
          <p className="mt-1 text-sm text-muted">
            Deterministic whole-number synthetic market parameters, price bounds, volatility, and
            executed order ledger.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`badge ${
              gov.marketEnabled ? "badge-active" : "badge-suspended"
            }`}
          >
            Market: {gov.marketEnabled ? "ONLINE" : "OFFLINE"}
          </span>
          <span
            className={`badge ${
              gov.tradingEnabled ? "badge-active" : "badge-suspended"
            }`}
          >
            Trading: {gov.tradingEnabled ? "ENABLED" : "PAUSED"}
          </span>
          <Link href="/gov/control-room" className="btn btn-secondary text-xs">
            Feature Controls
          </Link>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-muted">Current AMI Price</p>
          <p className="mt-1 text-xl font-semibold">
            {state.currentPrice.toLocaleString()} {CURRENCY_NAME}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Prev: {state.previousPrice.toLocaleString()} · {stats24h.changePercent}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">24h High / Low</p>
          <p className="mt-1 text-xl font-semibold">
            {stats24h.high24h.toLocaleString()} / {stats24h.low24h.toLocaleString()}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Bounds: [{state.minPrice}, {state.maxPrice}]
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">24h Executed Volume</p>
          <p className="mt-1 text-xl font-semibold">
            {stats24h.volumeUnits24h.toLocaleString()} units
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {stats24h.volumeAeros24h.toLocaleString()} {CURRENCY_NAME} ({stats24h.trades24h} trades)
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted">Active 5m Bucket Flow</p>
          <p className="mt-1 text-xl font-semibold">
            {state.netOrderFlowUnits >= 0 ? "+" : ""}
            {state.netOrderFlowUnits} units
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {state.activeBucketTraders} trader(s) · {state.methodologyVersion}
          </p>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-medium">Configure Synthetic Market Parameters</h2>
        <p className="mt-1 mb-4 text-xs text-muted">
          Adjusting bounds or volatility updates <span className="font-mono">market_state</span>{" "}
          immediately and writes an administrative audit record. Whole-number prices are strictly
          clamped within <span className="font-mono">[minPrice, maxPrice]</span>.
        </p>
        <GovMarketConfigForm
          config={{
            minPrice: state.minPrice,
            maxPrice: state.maxPrice,
            baseVolatilityBp: state.baseVolatilityBp,
            demandSensitivityBp: state.demandSensitivityBp,
            maxStepChangeBp: state.maxStepChangeBp,
            maxOrderUnits: state.maxOrderUnits,
            userCooldownSeconds: state.userCooldownSeconds,
          }}
        />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">
          Recent executed synthetic market orders ({recentOrders.length})
        </h2>
        {recentOrders.length === 0 ? (
          <p className="text-sm text-muted">
            No synthetic market orders have been executed yet.
          </p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {recentOrders.map(({ order: ord, username, displayName }) => (
              <div
                key={ord.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-medium">{ord.orderNumber}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        ord.side === "BUY"
                          ? "bg-[#e8f5ee] text-success"
                          : "bg-[#fdecea] text-danger"
                      }`}
                    >
                      {ord.side}
                    </span>
                    <Link
                      href={`/gov/users/${ord.userId}`}
                      className="font-medium hover:underline"
                    >
                      {displayName} (@{username})
                    </Link>
                    <span>
                      {ord.quantity.toLocaleString()} units @{" "}
                      {ord.executionPrice.toLocaleString()} {CURRENCY_NAME}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {formatDateTime(ord.createdAt)}
                    {ord.txRef ? ` · Ledger ref ${ord.txRef}` : ""}
                    {ord.side === "SELL"
                      ? ` · Realized P/L: ${ord.realizedPnlDelta >= 0 ? "+" : ""}${ord.realizedPnlDelta.toLocaleString()} ${CURRENCY_NAME}`
                      : ""}
                  </p>
                </div>
                <div className="text-right font-semibold">
                  {ord.totalAeros.toLocaleString()} {CURRENCY_NAME}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
