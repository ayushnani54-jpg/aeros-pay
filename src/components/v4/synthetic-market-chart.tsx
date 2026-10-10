"use client";

import { useActionState, useState, useTransition } from "react";
import { placeMarketOrderAction } from "@/actions/v4";
import { CURRENCY_NAME, type MarketTimeframe } from "@/lib/constants";

export type SerializedCandle = {
  bucketStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUnits: number;
  volumeAeros: number;
  tradeCount: number;
  isHighVolatility: boolean;
};

type MarketChartProps = {
  initialTimeframe: MarketTimeframe;
  methodologyVersion: string;
  currentPrice: number;
  previousPrice: number;
  minPrice: number;
  maxPrice: number;
  maxOrderUnits: number;
  tradingEnabled: boolean;
  userBalance: number;
  portfolio: {
    unitsHeld: number;
    totalCostBasis: number;
    averageEntryPrice: number;
    marketValueAeros: number;
    unrealizedPnlAeros: number;
    realizedPnl: number;
  };
  stats24h: {
    changeAeros: number;
    changePercent: string;
    volumeUnits24h: number;
    volumeAeros24h: number;
    trades24h: number;
    high24h: number;
    low24h: number;
  };
  initialCandles: SerializedCandle[];
};

function formatShortIst(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function SyntheticMarketTerminal({
  initialTimeframe,
  methodologyVersion,
  currentPrice: initialPrice,
  minPrice,
  maxPrice,
  maxOrderUnits,
  tradingEnabled,
  userBalance,
  portfolio,
  stats24h: initialStats,
  initialCandles,
}: MarketChartProps) {
  const [timeframe, setTimeframe] = useState<MarketTimeframe>(initialTimeframe);
  const [candles, setCandles] = useState<SerializedCandle[]>(initialCandles);
  const [currentPrice, setCurrentPrice] = useState<number>(initialPrice);
  const [stats, setStats] = useState(initialStats);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [isLoadingTf, startTfTransition] = useTransition();

  // Order ticket state
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantityStr, setQuantityStr] = useState<string>("1");
  const [maxSlippageBp, setMaxSlippageBp] = useState<string>("200");
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `trd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  const [orderState, orderAction, isSubmittingOrder] = useActionState(
    async (prev: Awaited<ReturnType<typeof placeMarketOrderAction>> | null, formData: FormData) => {
      const res = await placeMarketOrderAction(prev, formData);
      if (res.ok) {
        setIdempotencyKey(
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `trd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        );
        // Refresh chart view after trade
        await fetchReadOnlyChart(timeframe);
      }
      return res;
    },
    null,
  );

  async function fetchReadOnlyChart(nextTf: MarketTimeframe) {
    try {
      const res = await fetch(`/api/market/candles?timeframe=${nextTf}&limit=48`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.candles)) {
        setCandles(data.candles);
        setCurrentPrice(data.currentPrice);
        setStats(data.stats24h);
        setHoveredIdx(null);
      }
    } catch {
      // Ignore transient network errors on read-only refresh
    }
  }

  function handleTimeframeChange(nextTf: MarketTimeframe) {
    setTimeframe(nextTf);
    startTfTransition(async () => {
      await fetchReadOnlyChart(nextTf);
    });
  }

  const activeCandle =
    hoveredIdx !== null && candles[hoveredIdx]
      ? candles[hoveredIdx]
      : candles[candles.length - 1] ?? null;

  const prices = candles.flatMap((c) => [c.high, c.low]);
  const chartMin = prices.length > 0 ? Math.max(1, Math.min(...prices) - 2) : Math.max(1, currentPrice - 10);
  const chartMax = prices.length > 0 ? Math.max(...prices) + 2 : currentPrice + 10;
  const priceSpan = Math.max(1, chartMax - chartMin);

  const maxVol = Math.max(1, ...candles.map((c) => c.volumeUnits));

  const parsedQty = Math.max(0, Math.floor(Number(quantityStr) || 0));
  const estimatedTotal = parsedQty * currentPrice;

  const svgWidth = 760;
  const svgHeight = 300;
  const priceTop = 18;
  const priceBottom = 220;
  const priceHeight = priceBottom - priceTop;
  const volTop = 236;
  const volBottom = 282;
  const volHeight = volBottom - volTop;

  function yForPrice(p: number): number {
    const ratio = (p - chartMin) / priceSpan;
    return Math.round(priceBottom - ratio * priceHeight);
  }

  const gridLevels = [
    chartMax,
    Math.round(chartMin + priceSpan * 0.75),
    Math.round(chartMin + priceSpan * 0.5),
    Math.round(chartMin + priceSpan * 0.25),
    chartMin,
  ];

  return (
    <div className="space-y-6">
      {/* Synthetic Simulation Disclosure Banner */}
      <div className="rounded-md border border-[#111111] bg-surface p-4 text-xs text-muted">
        <p className="font-semibold text-foreground">
          Synthetic Internal Index ({methodologyVersion}) — Private Virtual Economy Simulation
        </p>
        <p className="mt-1">
          The Aeros Market Index (AMI) is generated deterministically on the server using whole-number{" "}
          {CURRENCY_NAME} prices ({minPrice.toLocaleString()}–{maxPrice.toLocaleString()}{" "}
          {CURRENCY_NAME}). It is not a real-world security, commodity, or cryptocurrency feed.
          Displayed volume reflects only actual executed user orders. Refreshing the chart is
          strictly read-only and never moves the price.
        </p>
      </div>

      {/* Top Ticker Bar */}
      <section className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted">
              Aeros Market Index (1 AMI Unit)
            </p>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-mono text-3xl font-semibold tracking-tight">
                {currentPrice.toLocaleString()} {CURRENCY_NAME}
              </span>
              <span
                className={`font-mono text-sm font-medium ${
                  stats.changeAeros >= 0 ? "text-success" : "text-danger"
                }`}
              >
                {stats.changeAeros >= 0 ? `+${stats.changeAeros}` : stats.changeAeros}{" "}
                {CURRENCY_NAME} ({stats.changePercent})
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
            <div>
              <p className="text-muted">24h High / Low</p>
              <p className="mt-0.5 font-mono font-medium">
                {stats.high24h.toLocaleString()} / {stats.low24h.toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-muted">24h Executed Volume</p>
              <p className="mt-0.5 font-mono font-medium">
                {stats.volumeUnits24h.toLocaleString()} AMI ({stats.volumeAeros24h.toLocaleString()}{" "}
                {CURRENCY_NAME})
              </p>
            </div>
            <div>
              <p className="text-muted">24h Executed Trades</p>
              <p className="mt-0.5 font-mono font-medium">{stats.trades24h.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted">Price Bounds</p>
              <p className="mt-0.5 font-mono font-medium">
                {minPrice.toLocaleString()} – {maxPrice.toLocaleString()} {CURRENCY_NAME}
              </p>
            </div>
          </div>
        </div>

        {/* Timeframe Controls & Active Candle Inspector */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-1.5">
            {(["5m", "15m", "1h"] as const).map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => handleTimeframeChange(tf)}
                disabled={isLoadingTf}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  timeframe === tf
                    ? "bg-black text-white"
                    : "bg-surface text-muted hover:text-foreground"
                }`}
              >
                {tf === "15m" ? "15m (Default)" : tf}
              </button>
            ))}
            <button
              type="button"
              onClick={() => startTfTransition(() => fetchReadOnlyChart(timeframe))}
              disabled={isLoadingTf}
              className="btn btn-secondary ml-2 px-2.5 py-1 text-xs"
            >
              {isLoadingTf ? "Loading…" : "Refresh view"}
            </button>
          </div>

          {activeCandle && (
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
              <span className="text-muted">{formatShortIst(activeCandle.bucketStart)} IST</span>
              <span>O: {activeCandle.open}</span>
              <span>H: {activeCandle.high}</span>
              <span>L: {activeCandle.low}</span>
              <span className="font-semibold">C: {activeCandle.close}</span>
              <span className="text-muted">Vol: {activeCandle.volumeUnits} AMI</span>
              {activeCandle.isHighVolatility && (
                <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold">
                  HIGH VOL
                </span>
              )}
            </div>
          )}
        </div>

        {/* Responsive SVG Candlestick + Volume Chart */}
        <div className="mt-3 overflow-x-auto">
          {candles.length === 0 ? (
            <div className="flex h-64 items-center justify-center rounded border border-border bg-surface text-sm text-muted">
              No candles available for this timeframe yet.
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="h-72 w-full min-w-[540px] select-none rounded border border-border bg-background"
              onMouseLeave={() => setHoveredIdx(null)}
            >
              {/* Horizontal price grid lines */}
              {gridLevels.map((lvl, idx) => {
                const y = yForPrice(lvl);
                return (
                  <g key={idx}>
                    <line
                      x1={48}
                      y1={y}
                      x2={svgWidth - 12}
                      y2={y}
                      stroke="#e5e5e5"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={42}
                      y={y + 3}
                      textAnchor="end"
                      fontSize="10"
                      fill="#777777"
                      fontFamily="monospace"
                    >
                      {lvl}
                    </text>
                  </g>
                );
              })}

              {/* Divider between price pane and volume pane */}
              <line
                x1={48}
                y1={volTop - 8}
                x2={svgWidth - 12}
                y2={volTop - 8}
                stroke="#d4d4d4"
              />
              <text x={42} y={volTop + 8} textAnchor="end" fontSize="9" fill="#777777">
                VOL
              </text>

              {/* Candles */}
              {candles.map((c, idx) => {
                const plotWidth = svgWidth - 72;
                const stepX = plotWidth / Math.max(1, candles.length);
                const cx = Math.round(56 + idx * stepX + stepX / 2);
                const bodyWidth = Math.max(4, Math.min(12, Math.floor(stepX * 0.65)));

                const yOpen = yForPrice(c.open);
                const yClose = yForPrice(c.close);
                const yHigh = yForPrice(c.high);
                const yLow = yForPrice(c.low);

                const bullish = c.close >= c.open;
                const color = bullish ? "#157347" : "#b3261e";
                const bodyTop = Math.min(yOpen, yClose);
                const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));

                const vBarHeight =
                  c.volumeUnits > 0
                    ? Math.max(3, Math.round((c.volumeUnits / maxVol) * volHeight))
                    : 1;
                const vBarTop = volBottom - vBarHeight;

                const isHovered = hoveredIdx === idx;

                return (
                  <g
                    key={c.bucketStart}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onClick={() => setHoveredIdx(idx)}
                    className="cursor-crosshair"
                  >
                    {isHovered && (
                      <line
                        x1={cx}
                        y1={priceTop}
                        x2={cx}
                        y2={volBottom}
                        stroke="#111111"
                        strokeDasharray="2 2"
                      />
                    )}
                    {/* High-Low Wick */}
                    <line
                      x1={cx}
                      y1={yHigh}
                      x2={cx}
                      y2={yLow}
                      stroke={color}
                      strokeWidth={1.5}
                    />
                    {/* Open-Close Body */}
                    <rect
                      x={cx - Math.floor(bodyWidth / 2)}
                      y={bodyTop}
                      width={bodyWidth}
                      height={bodyHeight}
                      fill={color}
                      rx={1}
                    />
                    {/* Executed Volume Bar */}
                    <rect
                      x={cx - Math.floor(bodyWidth / 2)}
                      y={vBarTop}
                      width={bodyWidth}
                      height={vBarHeight}
                      fill={c.volumeUnits > 0 ? color : "#d4d4d4"}
                      opacity={0.65}
                    />
                    {/* Invisible wider hit target */}
                    <rect
                      x={cx - Math.ceil(stepX / 2)}
                      y={priceTop}
                      width={Math.ceil(stepX)}
                      height={volBottom - priceTop}
                      fill="transparent"
                    />
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </section>

      {/* Trading & Portfolio Grid */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Order Ticket */}
        <section className="card p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Trade Aeros Market Index (AMI)</h2>
            <span className="font-mono text-xs text-muted">
              Wallet: {userBalance.toLocaleString()} {CURRENCY_NAME}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            BUY acquires whole AMI units using your personal {CURRENCY_NAME} balance. SELL returns
            held AMI units for whole {CURRENCY_NAME} at the server-authoritative price.
          </p>

          {!tradingEnabled ? (
            <div className="mt-4 rounded border border-border bg-surface p-4 text-sm text-muted">
              Trading is currently disabled by the Government. You may still view the chart and
              your existing holdings.
            </div>
          ) : (
            <form action={orderAction} className="mt-4 space-y-4">
              <input type="hidden" name="side" value={side} />
              <input type="hidden" name="expectedPrice" value={currentPrice} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSide("BUY")}
                  className={`rounded-md py-2 text-sm font-semibold ${
                    side === "BUY"
                      ? "bg-[#157347] text-white"
                      : "bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  BUY AMI
                </button>
                <button
                  type="button"
                  onClick={() => setSide("SELL")}
                  className={`rounded-md py-2 text-sm font-semibold ${
                    side === "SELL"
                      ? "bg-[#b3261e] text-white"
                      : "bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  SELL AMI
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">
                    Quantity (1 – {maxOrderUnits.toLocaleString()} AMI)
                  </label>
                  <input
                    name="quantity"
                    type="number"
                    min={1}
                    max={maxOrderUnits}
                    step={1}
                    required
                    value={quantityStr}
                    onChange={(e) => setQuantityStr(e.target.value)}
                    className="input font-mono"
                  />
                </div>
                <div>
                  <label className="label">Slippage protection</label>
                  <select
                    name="maxSlippageBp"
                    value={maxSlippageBp}
                    onChange={(e) => setMaxSlippageBp(e.target.value)}
                    className="input"
                  >
                    <option value="50">0.50% (Strict)</option>
                    <option value="100">1.00%</option>
                    <option value="200">2.00% (Default)</option>
                    <option value="500">5.00%</option>
                  </select>
                </div>
              </div>

              <div className="rounded border border-border bg-surface p-3 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted">Indicative execution price</span>
                  <span className="font-mono font-medium">
                    {currentPrice.toLocaleString()} {CURRENCY_NAME} / AMI
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">
                    Estimated {side === "BUY" ? "total cost" : "total proceeds"}
                  </span>
                  <span className="font-mono font-semibold">
                    {estimatedTotal.toLocaleString()} {CURRENCY_NAME}
                  </span>
                </div>
                {side === "SELL" && (
                  <div className="flex justify-between">
                    <span className="text-muted">Available to sell</span>
                    <span className="font-mono">{portfolio.unitsHeld.toLocaleString()} AMI</span>
                  </div>
                )}
              </div>

              {orderState && !orderState.ok && (
                <p className="text-xs text-danger">{orderState.error}</p>
              )}
              {orderState && orderState.ok && (
                <p className="text-xs text-success">
                  Order {orderState.data.orderNumber} executed at{" "}
                  {orderState.data.executionPrice.toLocaleString()} {CURRENCY_NAME} (total{" "}
                  {orderState.data.totalAeros.toLocaleString()} {CURRENCY_NAME}, ref{" "}
                  {orderState.data.txRef}).
                </p>
              )}

              <button
                type="submit"
                disabled={
                  isSubmittingOrder ||
                  parsedQty < 1 ||
                  (side === "BUY" && estimatedTotal > userBalance) ||
                  (side === "SELL" && parsedQty > portfolio.unitsHeld)
                }
                className="btn btn-primary w-full"
              >
                {isSubmittingOrder
                  ? "Executing order…"
                  : `${side} ${parsedQty > 0 ? parsedQty.toLocaleString() : 0} AMI for ~${estimatedTotal.toLocaleString()} ${CURRENCY_NAME}`}
              </button>
            </form>
          )}
        </section>

        {/* User Holdings & P/L Summary */}
        <section className="card p-5">
          <h2 className="font-medium">Your Index Holdings &amp; P/L</h2>
          <p className="mt-1 text-xs text-muted">
            Accounting is exact whole-number {CURRENCY_NAME}. Cost basis updates proportionally on
            every BUY and SELL.
          </p>

          <dl className="mt-4 space-y-2.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">AMI Units Held</dt>
              <dd className="font-mono font-semibold">{portfolio.unitsHeld.toLocaleString()} AMI</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Average Entry Price</dt>
              <dd className="font-mono">
                {portfolio.unitsHeld > 0
                  ? `${portfolio.averageEntryPrice.toLocaleString()} ${CURRENCY_NAME}`
                  : "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Total Cost Basis</dt>
              <dd className="font-mono">
                {portfolio.totalCostBasis.toLocaleString()} {CURRENCY_NAME}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Current Market Valuation</dt>
              <dd className="font-mono font-medium">
                {portfolio.marketValueAeros.toLocaleString()} {CURRENCY_NAME}
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-2">
              <dt className="text-muted">Unrealized P/L</dt>
              <dd
                className={`font-mono font-medium ${
                  portfolio.unrealizedPnlAeros > 0
                    ? "text-success"
                    : portfolio.unrealizedPnlAeros < 0
                      ? "text-danger"
                      : ""
                }`}
              >
                {portfolio.unrealizedPnlAeros > 0
                  ? `+${portfolio.unrealizedPnlAeros.toLocaleString()}`
                  : portfolio.unrealizedPnlAeros.toLocaleString()}{" "}
                {CURRENCY_NAME}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Cumulative Realized P/L</dt>
              <dd
                className={`font-mono font-medium ${
                  portfolio.realizedPnl > 0
                    ? "text-success"
                    : portfolio.realizedPnl < 0
                      ? "text-danger"
                      : ""
                }`}
              >
                {portfolio.realizedPnl > 0
                  ? `+${portfolio.realizedPnl.toLocaleString()}`
                  : portfolio.realizedPnl.toLocaleString()}{" "}
                {CURRENCY_NAME}
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
