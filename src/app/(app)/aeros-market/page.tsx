import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getGovernmentFeatureFlags } from "@/lib/queries";
import {
  getMarketChartData,
  getUserMarketPortfolio,
} from "@/lib/synthetic-market";
import { CURRENCY_NAME, DEFAULT_MARKET_DISCLOSURE } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import { SyntheticMarketTerminal } from "@/components/v4/synthetic-market-chart";

export default async function AerosMarketPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user } = ctx;
  const [flags, chart15m, portfolio] = await Promise.all([
    getGovernmentFeatureFlags(),
    getMarketChartData("15m", 96),
    getUserMarketPortfolio(user.id),
  ]);

  const serializedCandles = chart15m.candles.map((c) => ({
    bucketStart: c.bucketStart.toISOString(),
    open: c.openPrice,
    high: c.highPrice,
    low: c.lowPrice,
    close: c.closePrice,
    volumeUnits: c.volumeUnits,
    volumeAeros: c.volumeAeros,
    tradeCount: c.tradeCount,
    isHighVolatility: c.isHighVolatility,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Aeros Market &amp; Synthetic Index
          </h1>
          <p className="mt-1 text-sm text-muted">
            Internal deterministic whole-number synthetic index (AMI) with Long &amp; Short
            Treasury-settled trading.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/exchange" className="btn btn-secondary text-xs">
            Aeros Exchange
          </Link>
          <Link href="/market" className="btn btn-secondary text-xs">
            Goods &amp; Services Market
          </Link>
        </div>
      </div>

      {!flags.marketEnabled ? (
        <section className="card p-6 text-center">
          <h2 className="font-medium">Aeros Market is currently offline</h2>
          <p className="mt-1 text-sm text-muted">
            The Government has temporarily disabled the synthetic market view. Your existing
            index holdings ({portfolio.position.unitsHeld.toLocaleString()} long units,{" "}
            {portfolio.position.shortUnitsHeld.toLocaleString()} short units) and wallet
            balances remain intact.
          </p>
        </section>
      ) : (
        <SyntheticMarketTerminal
          initialTimeframe="15m"
          methodologyVersion={chart15m.state.methodologyVersion}
          currentPrice={chart15m.state.currentPrice}
          previousPrice={chart15m.state.previousPrice}
          minPrice={chart15m.state.minPrice}
          maxPrice={chart15m.state.maxPrice}
          maxOrderUnits={chart15m.state.maxOrderUnits}
          shortSellingEnabled={chart15m.state.shortSellingEnabled}
          shortCollateralRatioBp={chart15m.state.shortCollateralRatioBp}
          maxShortUnitsPerUser={chart15m.state.maxShortUnitsPerUser}
          tradingEnabled={flags.tradingEnabled}
          userBalance={user.balance}
          portfolio={{
            unitsHeld: portfolio.position.unitsHeld,
            totalCostBasis: portfolio.position.totalCostBasis,
            realizedPnl: portfolio.position.realizedPnl,
            averageEntryPrice: portfolio.averageEntryPrice,
            marketValueAeros: portfolio.marketValueAeros,
            unrealizedPnlAeros: portfolio.unrealizedPnlAeros,
            shortUnitsHeld: portfolio.position.shortUnitsHeld,
            shortEntryNotional: portfolio.position.shortEntryNotional,
            shortCollateralLocked: portfolio.position.shortCollateralLocked,
            shortAverageEntryPrice: portfolio.shortAverageEntryPrice,
            shortLiabilityAeros: portfolio.shortLiabilityAeros,
            shortUnrealizedPnlAeros: portfolio.shortUnrealizedPnlAeros,
            shortNetEquityAeros: portfolio.shortNetEquityAeros,
            totalUnrealizedPnlAeros: portfolio.totalUnrealizedPnlAeros,
          }}
          stats24h={chart15m.stats24h}
          initialCandles={serializedCandles}
          initialHasOlderHistory={chart15m.hasOlderHistory}
        />
      )}

      <section className="card p-5">
        <h2 className="font-medium">How the Synthetic Market Works</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {DEFAULT_MARKET_DISCLOSURE}
        </p>
        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
          <div className="rounded-md bg-surface p-3">
            <p className="font-semibold">Whole-Number Pricing &amp; Zoom</p>
            <p className="mt-1 text-muted">
              Every candle (Open, High, Low, Close) and execution price is an exact whole number of{" "}
              {CURRENCY_NAME} bounded between {chart15m.state.minPrice.toLocaleString()} and{" "}
              {chart15m.state.maxPrice.toLocaleString()} {CURRENCY_NAME}. Zoom in/out or pan
              horizontally to inspect historical candles.
            </p>
          </div>
          <div className="rounded-md bg-surface p-3">
            <p className="font-semibold">Long (BUY / SELL) &amp; Short (SHORT / COVER)</p>
            <p className="mt-1 text-muted">
              <strong>BUY</strong> acquires long AMI units. <strong>SELL</strong> closes long units
              (or opens a short position if you hold 0 long units). <strong>SHORT</strong> opens a
              100% collateralized short position without owning units; <strong>COVER</strong> closes
              it and settles collateral +/- P&amp;L.
            </p>
          </div>
          <div className="rounded-md bg-surface p-3">
            <p className="font-semibold">Read-Only Chart Refresh</p>
            <p className="mt-1 text-muted">
              Refreshing this page, zooming, or switching between 5m, 15m, and 1h views is strictly
              read-only and never moves the price or fabricates trading volume.
            </p>
          </div>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Your recent synthetic market orders</h2>
        {portfolio.recentOrders.length === 0 ? (
          <p className="text-sm text-muted">
            You have not placed any synthetic market orders yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {portfolio.recentOrders.map((ord) => (
              <div
                key={ord.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{ord.orderNumber}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold ${
                        ord.side === "BUY"
                          ? "bg-[#e8f5ee] text-success"
                          : ord.side === "SHORT"
                            ? "bg-[#fff6e0] text-[#8a5a00]"
                            : ord.side === "COVER"
                              ? "bg-surface text-foreground"
                              : "bg-[#fdecea] text-danger"
                      }`}
                    >
                      {ord.side}
                    </span>
                    <span className="font-medium">
                      {ord.quantity.toLocaleString()} unit{ord.quantity === 1 ? "" : "s"} @{" "}
                      {ord.executionPrice.toLocaleString()} {CURRENCY_NAME}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {formatDateTime(ord.createdAt)}
                    {ord.txRef ? ` · Ledger ref ${ord.txRef}` : ""}
                    {(ord.side === "SELL" || ord.side === "COVER") && (
                      <>
                        {" "}
                        · Realized P/L:{" "}
                        <span
                          className={
                            ord.realizedPnlDelta >= 0 ? "text-success" : "text-danger"
                          }
                        >
                          {ord.realizedPnlDelta >= 0 ? "+" : ""}
                          {ord.realizedPnlDelta.toLocaleString()} {CURRENCY_NAME}
                        </span>
                      </>
                    )}
                    {ord.side === "SHORT" && (
                      <>
                        {" "}
                        · Collateral locked: {ord.costBasisDelta.toLocaleString()} {CURRENCY_NAME}
                      </>
                    )}
                  </p>
                </div>
                <div className="text-right font-semibold">
                  {ord.side === "BUY" || ord.side === "SHORT" ? "-" : "+"}
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
