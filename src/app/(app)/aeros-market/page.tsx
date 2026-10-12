import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getGovernmentFeatureFlags } from "@/lib/queries";
import {
  calculateHedgePositionPnl,
  getMarketChartData,
  getUserHedgePositions,
  getUserMarketPortfolio,
} from "@/lib/synthetic-market";
import { CURRENCY_NAME, DEFAULT_MARKET_DISCLOSURE } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import { SyntheticMarketTerminal } from "@/components/v4/synthetic-market-chart";
import {
  HedgeTradingPanel,
  type SerializedHedgePosition,
  type SerializedLeverageRequest,
} from "@/components/v5/hedge-trading-panel";
import { db } from "@/db/client";
import { government } from "@/db/schema";

export default async function AerosMarketPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user } = ctx;
  const [flags, chart15m, portfolio, hedgeData, govRows] = await Promise.all([
    getGovernmentFeatureFlags(),
    getMarketChartData("15m", 96),
    getUserMarketPortfolio(user.id),
    getUserHedgePositions(user.id).catch(() => ({
      openPositions: [],
      closedPositions: [],
      leverageRequests: [],
    })),
    db.select({ interval: government.marketUpdateIntervalMinutes }).from(government).limit(1),
  ]);

  const marketUpdateIntervalMinutes = govRows[0]?.interval === 5 ? 5 : 1;
  const currentPrice = chart15m.state.currentPrice;

  const serializePos = (
    p: (typeof hedgeData.openPositions)[number],
  ): SerializedHedgePosition => {
    const pnl = calculateHedgePositionPnl({
      direction: p.direction,
      entryPrice: p.entryPrice,
      currentPrice: p.closePrice ?? currentPrice,
      quantity: p.quantity,
      marginLocked: p.marginLocked,
    });
    const liqPrice =
      p.direction === "LONG"
        ? Math.max(1, p.entryPrice - Math.floor(p.marginLocked / p.quantity))
        : p.entryPrice + Math.floor(p.marginLocked / p.quantity);

    return {
      id: p.id,
      positionNumber: p.positionNumber,
      direction: p.direction,
      sideLabel: p.direction === "LONG" ? "BUY" : "SELL",
      quantity: p.quantity,
      leverage: p.leverage,
      entryPrice: p.entryPrice,
      notionalValueAeros: p.costBasis,
      marginLocked: p.marginLocked,
      liquidationPrice: liqPrice,
      status: p.status,
      closePrice: p.closePrice,
      realizedPnl: p.realizedPnl,
      unrealizedPnl: pnl.unrealizedPnl,
      effectiveEquity: pnl.estimatedPayout,
      wouldLiquidate: pnl.estimatedPayout <= 0,
      openTxRef: p.openTxRef,
      closeTxRef: p.closeTxRef,
      openedAt: p.openedAt.toISOString(),
      closedAt: p.closedAt ? p.closedAt.toISOString() : null,
    };
  };

  const serializedOpenPositions = hedgeData.openPositions.map(serializePos);
  const serializedClosedPositions = hedgeData.closedPositions.map(serializePos);

  const serializedLeverageRequests: SerializedLeverageRequest[] =
    hedgeData.leverageRequests.map((r) => ({
      id: r.id,
      requestNumber: `LEV-${r.id.slice(0, 6).toUpperCase()}`,
      currentLeverage: r.currentLeverage,
      requestedLeverage: r.requestedLeverage,
      reason: `Requesting upgrade from ${r.currentLeverage}x to ${r.requestedLeverage}x`,
      status: r.status,
      reviewNote: r.rejectionReason || r.adminNotes || null,
      createdAt: r.createdAt.toISOString(),
    }));

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            Aeros Market Index &amp; Hedge Trading Terminal
          </h1>
          <p className="mt-1 text-xs text-muted sm:text-sm">
            Deterministic whole-number synthetic index (AMI) with independent{" "}
            <strong>BUY (Long)</strong> &amp; <strong>SELL (Short)</strong> positions, structured
            leverage (2x → 4x → 8x → 10x), and {marketUpdateIntervalMinutes}-minute market updates.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/exchange" className="btn btn-secondary text-xs">
            Aeros Exchange
          </Link>
          <Link href="/market" className="btn btn-secondary text-xs">
            Marketplace &amp; Jobs
          </Link>
        </div>
      </div>

      {!flags.marketEnabled ? (
        <section className="card p-6 text-center">
          <h2 className="font-medium">Aeros Market is currently offline</h2>
          <p className="mt-1 text-sm text-muted">
            The Government has temporarily disabled the synthetic market view. Your existing
            positions ({serializedOpenPositions.length} hedge positions,{" "}
            {portfolio.position.unitsHeld.toLocaleString()} spot long units) and wallet balances
            remain intact.
          </p>
        </section>
      ) : (
        <>
          {/* V5 Independent Hedge Trading & Leverage Progression Panel */}
          <HedgeTradingPanel
            currentPrice={currentPrice}
            marketUpdateIntervalMinutes={marketUpdateIntervalMinutes}
            tradingEnabled={flags.tradingEnabled}
            userBalance={user.balance}
            maxOrderUnits={chart15m.state.maxOrderUnits}
            userMaxLeverage={user.maxLeverage ?? 2}
            openPositions={serializedOpenPositions}
            closedPositions={serializedClosedPositions}
            leverageRequests={serializedLeverageRequests}
          />

          {/* Interactive Candlestick Chart & Spot/Collateralized Terminal */}
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
        </>
      )}

      <section className="card p-4 sm:p-5">
        <h2 className="font-medium">How the Synthetic Market Works</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {DEFAULT_MARKET_DISCLOSURE}
        </p>
        <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
          <div className="rounded-md bg-surface p-3">
            <p className="font-semibold">Whole-Number Pricing &amp; 5m Candle Fix</p>
            <p className="mt-1 text-muted">
              Every candle (Open, High, Low, Close) and execution price is an exact whole number of{" "}
              {CURRENCY_NAME} bounded between {chart15m.state.minPrice.toLocaleString()} and{" "}
              {chart15m.state.maxPrice.toLocaleString()} {CURRENCY_NAME}. 5m, 15m, and 1h candles
              aggregate deterministically from the {marketUpdateIntervalMinutes}-minute market clock.
            </p>
          </div>
          <div className="rounded-md bg-surface p-3">
            <p className="font-semibold">Independent BUY (Long) &amp; SELL (Short)</p>
            <p className="mt-1 text-muted">
              <strong>BUY (Long)</strong> opens an independent long position that profits when the
              index rises. <strong>SELL (Short)</strong> opens an independent short position that
              profits when the index falls. Opposing positions never auto-cancel each other.
            </p>
          </div>
          <div className="rounded-md bg-surface p-3">
            <p className="font-semibold">Structured Leverage (2x → 4x → 8x → 10x)</p>
            <p className="mt-1 text-muted">
              Citizens begin with 2x leverage and can request 4x, 8x, and up to the hard 10x cap
              via Government review. All settlements preserve the total monetary supply invariant.
            </p>
          </div>
        </div>
      </section>

      <section className="card p-4 sm:p-5">
        <h2 className="mb-3 font-medium">Your recent spot &amp; synthetic market orders</h2>
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
