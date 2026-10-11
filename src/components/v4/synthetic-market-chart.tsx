"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { placeMarketOrderAction } from "@/actions/v4";
import { CURRENCY_NAME, type MarketTimeframe } from "@/lib/constants";
import {
  clampCandleWindow,
  computeVisibleYScale,
  MIN_VISIBLE_CANDLES,
  panCandleWindow,
  zoomCandleWindow,
  type ChartCandlePoint,
  type VisibleWindowRange,
} from "@/lib/market-chart-utils";

interface MarketStats24h {
  changeAeros: number;
  changePercent: string;
  volumeUnits24h: number;
  volumeAeros24h: number;
  trades24h: number;
  high24h: number;
  low24h: number;
}

interface PortfolioSummary {
  unitsHeld: number;
  totalCostBasis: number;
  realizedPnl: number;
  averageEntryPrice: number;
  marketValueAeros: number;
  unrealizedPnlAeros: number;
  shortUnitsHeld?: number;
  shortEntryNotional?: number;
  shortCollateralLocked?: number;
  shortAverageEntryPrice?: number;
  shortLiabilityAeros?: number;
  shortUnrealizedPnlAeros?: number;
  shortNetEquityAeros?: number;
  totalUnrealizedPnlAeros?: number;
}

type OrderSideMode = "BUY" | "SELL" | "SHORT" | "COVER";

export function SyntheticMarketTerminal({
  initialTimeframe,
  methodologyVersion,
  currentPrice: initialPrice,
  previousPrice: initialPrevPrice,
  minPrice,
  maxPrice,
  maxOrderUnits,
  shortSellingEnabled = true,
  shortCollateralRatioBp = 10000,
  maxShortUnitsPerUser = 1000,
  tradingEnabled,
  userBalance,
  portfolio,
  stats24h: initialStats,
  initialCandles,
  initialHasOlderHistory = false,
}: {
  initialTimeframe: MarketTimeframe;
  methodologyVersion: string;
  currentPrice: number;
  previousPrice: number;
  minPrice: number;
  maxPrice: number;
  maxOrderUnits: number;
  shortSellingEnabled?: boolean;
  shortCollateralRatioBp?: number;
  maxShortUnitsPerUser?: number;
  tradingEnabled: boolean;
  userBalance: number;
  portfolio: PortfolioSummary;
  stats24h: MarketStats24h;
  initialCandles: ChartCandlePoint[];
  initialHasOlderHistory?: boolean;
}) {
  const [timeframe, setTimeframe] = useState<MarketTimeframe>(initialTimeframe);
  const [clientOverride, setClientOverride] = useState<{
    candles: ChartCandlePoint[];
    currentPrice: number;
    previousPrice: number;
    stats24h: MarketStats24h;
    hasOlderHistory: boolean;
  } | null>(null);
  const [loadingTf, setLoadingTf] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const candles = clientOverride ? clientOverride.candles : initialCandles;
  const currentPrice = clientOverride ? clientOverride.currentPrice : initialPrice;
  const previousPrice = clientOverride ? clientOverride.previousPrice : initialPrevPrice;
  const stats24h = clientOverride ? clientOverride.stats24h : initialStats;
  const hasOlderHistory = clientOverride
    ? clientOverride.hasOlderHistory
    : initialHasOlderHistory;

  // V4.1 Defect 6.A Fix: Visible window state `[startIndex, endIndex)` for zoom & pan
  const [rawWindowRange, setWindowRange] = useState<VisibleWindowRange>(() =>
    clampCandleWindow(
      initialCandles.length,
      Math.max(0, initialCandles.length - 48),
      initialCandles.length,
    ),
  );

  const windowRange = useMemo<VisibleWindowRange>(() => {
    if (candles.length === 0) return { startIndex: 0, endIndex: 0, visibleCount: 0 };
    return clampCandleWindow(
      candles.length,
      rawWindowRange.startIndex,
      rawWindowRange.endIndex,
    );
  }, [candles.length, rawWindowRange]);

  // Drag-to-pan state
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragStateRef = useRef<{
    active: boolean;
    startX: number;
    initialWindow: VisibleWindowRange;
  } | null>(null);

  // Order form state (V4.1 Defect 6.B Fix: BUY, SELL, SHORT, COVER)
  const [side, setSide] = useState<OrderSideMode>("BUY");
  const [quantity, setQuantity] = useState<number>(1);
  const [maxSlippageBp, setMaxSlippageBp] = useState<number>(200);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `mkt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  const [orderState, orderAction, orderPending] = useActionState(
    async (
      prev: Awaited<ReturnType<typeof placeMarketOrderAction>> | null,
      formData: FormData,
    ) => {
      const res = await placeMarketOrderAction(prev, formData);
      if (res?.ok) {
        setIdempotencyKey(
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `mkt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        );
        if (timeframe === initialTimeframe) {
          setClientOverride(null);
        }
      }
      return res;
    },
    null,
  );

  async function selectTimeframe(nextTf: MarketTimeframe) {
    setTimeframe(nextTf);
    setLoadingTf(true);
    try {
      const res = await fetch(`/api/market/candles?timeframe=${nextTf}&limit=96`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        const nextCandles: ChartCandlePoint[] = data.candles ?? [];
        setClientOverride({
          candles: nextCandles,
          currentPrice: data.currentPrice ?? currentPrice,
          previousPrice: data.previousPrice ?? previousPrice,
          stats24h: data.stats24h ?? stats24h,
          hasOlderHistory: Boolean(data.hasOlderHistory),
        });
        setWindowRange(
          clampCandleWindow(
            nextCandles.length,
            Math.max(0, nextCandles.length - Math.min(48, nextCandles.length)),
            nextCandles.length,
          ),
        );
      }
    } catch {
      // Keep existing candles on transient offline error
    } finally {
      setLoadingTf(false);
    }
  }

  async function loadOlderCandles() {
    if (loadingOlder || candles.length === 0) return;
    const oldestBucket = candles[0]?.bucketStart;
    if (!oldestBucket) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/market/candles?timeframe=${timeframe}&limit=96&before=${encodeURIComponent(oldestBucket)}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const data = await res.json();
        const older: ChartCandlePoint[] = data.candles ?? [];
        const nextHasOlder = Boolean(data.hasOlderHistory);
        if (older.length > 0) {
          const existingSet = new Set(candles.map((c) => c.bucketStart));
          const uniqueOlder = older.filter((c) => !existingSet.has(c.bucketStart));
          if (uniqueOlder.length > 0) {
            const combined = [...uniqueOlder, ...candles];
            setClientOverride({
              candles: combined,
              currentPrice,
              previousPrice,
              stats24h,
              hasOlderHistory: nextHasOlder,
            });
            // Shift window indices so view jumps cleanly to the newly loaded history
            setWindowRange(
              clampCandleWindow(
                combined.length,
                0,
                Math.min(combined.length, Math.max(24, windowRange.visibleCount)),
              ),
            );
            return;
          }
        }
        setClientOverride({
          candles,
          currentPrice,
          previousPrice,
          stats24h,
          hasOlderHistory: nextHasOlder,
        });
      }
    } catch {
      // Ignore network errors
    } finally {
      setLoadingOlder(false);
    }
  }

  function handleZoomIn() {
    setHoveredIdx(null);
    setWindowRange((prev) => zoomCandleWindow(candles.length, prev, "in", 1.0));
  }

  function handleZoomOut() {
    setHoveredIdx(null);
    setWindowRange((prev) => zoomCandleWindow(candles.length, prev, "out", 1.0));
  }

  function handlePanLeft() {
    setHoveredIdx(null);
    const step = Math.max(4, Math.round(windowRange.visibleCount * 0.25));
    setWindowRange((prev) => panCandleWindow(candles.length, prev, -step));
  }

  function handlePanRight() {
    setHoveredIdx(null);
    const step = Math.max(4, Math.round(windowRange.visibleCount * 0.25));
    setWindowRange((prev) => panCandleWindow(candles.length, prev, step));
  }

  function handleResetFit() {
    setHoveredIdx(null);
    setWindowRange(
      clampCandleWindow(
        candles.length,
        Math.max(0, candles.length - Math.min(48, candles.length)),
        candles.length,
      ),
    );
  }

  function applyWindowPreset(count: number | "ALL") {
    setHoveredIdx(null);
    if (count === "ALL") {
      setWindowRange(clampCandleWindow(candles.length, 0, candles.length));
      return;
    }
    const clampedCount = Math.min(candles.length, Math.max(MIN_VISIBLE_CANDLES, count));
    setWindowRange(
      clampCandleWindow(candles.length, Math.max(0, candles.length - clampedCount), candles.length),
    );
  }

  // Visible slice of candles for rendering and Y-axis dynamic scaling
  const visibleCandles = useMemo(() => {
    if (candles.length === 0) return [];
    const safe = clampCandleWindow(candles.length, windowRange.startIndex, windowRange.endIndex);
    return candles.slice(safe.startIndex, safe.endIndex);
  }, [candles, windowRange]);

  const chartGeometry = useMemo(() => {
    const width = 760;
    const height = 280;
    const padLeft = 52;
    const padRight = 16;
    const padTop = 18;
    const padBottom = 56;
    const plotW = width - padLeft - padRight;
    const priceH = height - padTop - padBottom;

    const { yMin, yMax, ySpan, yTicks, maxVolume } = computeVisibleYScale(
      visibleCandles,
      currentPrice,
    );

    const priceToY = (p: number) =>
      padTop + priceH - ((p - yMin) / ySpan) * priceH;

    return {
      width,
      height,
      padLeft,
      padRight,
      padTop,
      padBottom,
      plotW,
      priceH,
      yMin,
      yMax,
      yTicks,
      maxVolume,
      priceToY,
    };
  }, [visibleCandles, currentPrice]);

  const activeCandle =
    hoveredIdx !== null && visibleCandles[hoveredIdx]
      ? visibleCandles[hoveredIdx]
      : visibleCandles[visibleCandles.length - 1] ?? null;

  // Portfolio & Short position metrics
  const shortUnitsHeld = portfolio.shortUnitsHeld ?? 0;
  const shortCollateralLocked = portfolio.shortCollateralLocked ?? 0;
  const shortAverageEntryPrice = portfolio.shortAverageEntryPrice ?? 0;
  const shortUnrealizedPnlAeros =
    portfolio.shortUnrealizedPnlAeros ??
    (shortUnitsHeld > 0 ? (portfolio.shortEntryNotional ?? 0) - shortUnitsHeld * currentPrice : 0);

  // Note: If user selects SELL while holding 0 long units and shortSellingEnabled is true,
  // server automatically executes as SHORT! Let's show that clearly in the order ticket.
  const willAutoShortOnSell =
    side === "SELL" && portfolio.unitsHeld === 0 && shortSellingEnabled;
  const effectiveSide: OrderSideMode = willAutoShortOnSell ? "SHORT" : side;

  const safeQty = Number.isFinite(quantity) && quantity >= 1 ? Math.trunc(quantity) : 1;
  const estNotional = safeQty * currentPrice;
  const estShortCollateral = Math.max(
    1,
    Math.round((estNotional * shortCollateralRatioBp) / 10000),
  );

  const canAffordBuy = userBalance >= estNotional;
  const canSellHoldings = portfolio.unitsHeld >= safeQty;
  const canOpenShort =
    shortSellingEnabled &&
    userBalance >= estShortCollateral &&
    shortUnitsHeld + safeQty <= maxShortUnitsPerUser;
  const canCoverShort = shortUnitsHeld >= safeQty;

  const isOrderActionable =
    effectiveSide === "BUY"
      ? canAffordBuy
      : effectiveSide === "SELL"
        ? canSellHoldings
        : effectiveSide === "SHORT"
          ? canOpenShort
          : canCoverShort;

  const maxActionableUnits = useMemo(() => {
    if (effectiveSide === "BUY") {
      return Math.max(1, Math.min(maxOrderUnits, Math.floor(userBalance / Math.max(1, currentPrice))));
    }
    if (effectiveSide === "SELL") {
      return Math.max(1, Math.min(maxOrderUnits, portfolio.unitsHeld));
    }
    if (effectiveSide === "SHORT") {
      const unitCollateral = Math.max(
        1,
        Math.round((currentPrice * shortCollateralRatioBp) / 10000),
      );
      const byBalance = Math.floor(userBalance / unitCollateral);
      const byCap = Math.max(0, maxShortUnitsPerUser - shortUnitsHeld);
      return Math.max(1, Math.min(maxOrderUnits, byBalance, byCap));
    }
    // COVER
    return Math.max(1, Math.min(maxOrderUnits, shortUnitsHeld));
  }, [
    effectiveSide,
    maxOrderUnits,
    userBalance,
    currentPrice,
    portfolio.unitsHeld,
    shortCollateralRatioBp,
    maxShortUnitsPerUser,
    shortUnitsHeld,
  ]);

  const isPositive24h = stats24h.changeAeros >= 0;

  return (
    <div className="space-y-5">
      {/* Top KPI Strip */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-[#111111] px-2 py-0.5 font-mono text-xs font-medium text-white">
                AMI / {CURRENCY_NAME.toUpperCase()}
              </span>
              <span className="text-xs text-muted">
                Synthetic Index · {methodologyVersion}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <p className="text-3xl font-semibold tracking-tight">
                {currentPrice.toLocaleString()}{" "}
                <span className="text-base font-medium text-muted">{CURRENCY_NAME}</span>
              </p>
              <span
                className={`text-sm font-medium ${
                  isPositive24h ? "text-success" : "text-danger"
                }`}
              >
                {isPositive24h ? "+" : ""}
                {stats24h.changeAeros.toLocaleString()} {CURRENCY_NAME} ({stats24h.changePercent})
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">
              Previous bucket: {previousPrice.toLocaleString()} {CURRENCY_NAME} · Bounds:{" "}
              {minPrice.toLocaleString()} – {maxPrice.toLocaleString()} {CURRENCY_NAME}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
            <div>
              <p className="text-muted">24h High</p>
              <p className="mt-0.5 font-mono text-sm font-medium">
                {stats24h.high24h.toLocaleString()} {CURRENCY_NAME}
              </p>
            </div>
            <div>
              <p className="text-muted">24h Low</p>
              <p className="mt-0.5 font-mono text-sm font-medium">
                {stats24h.low24h.toLocaleString()} {CURRENCY_NAME}
              </p>
            </div>
            <div>
              <p className="text-muted">24h Real Volume</p>
              <p className="mt-0.5 font-mono text-sm font-medium">
                {stats24h.volumeUnits24h.toLocaleString()} units
              </p>
              <p className="text-[11px] text-muted">
                {stats24h.volumeAeros24h.toLocaleString()} {CURRENCY_NAME}
              </p>
            </div>
            <div>
              <p className="text-muted">24h Executed Trades</p>
              <p className="mt-0.5 font-mono text-sm font-medium">
                {stats24h.trades24h.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Candlestick & Volume Chart (2 cols on desktop) */}
        <section className="card flex flex-col justify-between p-5 lg:col-span-2">
          <div>
            {/* Row 1: Timeframe + Zoom & Pan Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {(["5m", "15m", "1h"] as const).map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => selectTimeframe(tf)}
                    disabled={loadingTf}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                      timeframe === tf
                        ? "bg-[#111111] text-white"
                        : "bg-surface text-muted hover:text-foreground"
                    }`}
                  >
                    {tf}
                  </button>
                ))}
                <span className="mx-1 text-border">|</span>
                {/* Window size presets */}
                {([16, 32, 48, 96] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => applyWindowPreset(preset)}
                    disabled={candles.length < preset}
                    title={`Show ${preset} candles`}
                    className={`rounded px-2 py-0.5 font-mono text-[11px] transition ${
                      windowRange.visibleCount === preset
                        ? "bg-[#111111] text-white"
                        : "bg-surface text-muted hover:text-foreground disabled:opacity-40"
                    }`}
                  >
                    {preset}c
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => applyWindowPreset("ALL")}
                  className={`rounded px-2 py-0.5 font-mono text-[11px] transition ${
                    windowRange.visibleCount === candles.length
                      ? "bg-[#111111] text-white"
                      : "bg-surface text-muted hover:text-foreground"
                  }`}
                >
                  All ({candles.length})
                </button>
              </div>

              {/* Explicit Zoom / Pan / Reset / Load History toolbar */}
              <div className="flex flex-wrap items-center gap-1">
                {hasOlderHistory && (
                  <button
                    type="button"
                    onClick={loadOlderCandles}
                    disabled={loadingOlder}
                    className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium hover:bg-border/40"
                    title="Load older historical candles from database / archive"
                  >
                    {loadingOlder ? "Loading…" : "⇤ Load Older"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handlePanLeft}
                  disabled={windowRange.startIndex <= 0}
                  data-testid="chart-pan-left"
                  title="Pan left (older candles)"
                  className="rounded border border-border bg-surface px-2 py-1 font-mono text-xs hover:bg-border/40 disabled:opacity-40"
                >
                  ←
                </button>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={windowRange.visibleCount <= MIN_VISIBLE_CANDLES}
                  data-testid="chart-zoom-in"
                  title="Zoom In (+)"
                  className="rounded border border-border bg-surface px-2.5 py-1 font-mono text-xs font-bold hover:bg-border/40 disabled:opacity-40"
                >
                  + Zoom In
                </button>
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={windowRange.visibleCount >= candles.length}
                  data-testid="chart-zoom-out"
                  title="Zoom Out (-)"
                  className="rounded border border-border bg-surface px-2.5 py-1 font-mono text-xs font-bold hover:bg-border/40 disabled:opacity-40"
                >
                  − Zoom Out
                </button>
                <button
                  type="button"
                  onClick={handlePanRight}
                  disabled={windowRange.endIndex >= candles.length}
                  data-testid="chart-pan-right"
                  title="Pan right (newer candles)"
                  className="rounded border border-border bg-surface px-2 py-1 font-mono text-xs hover:bg-border/40 disabled:opacity-40"
                >
                  →
                </button>
                <button
                  type="button"
                  onClick={handleResetFit}
                  data-testid="chart-reset-fit"
                  title="Reset zoom and fit latest candles"
                  className="rounded border border-border bg-surface px-2 py-1 text-[11px] font-medium hover:bg-border/40"
                >
                  Reset / Fit
                </button>
              </div>
            </div>

            {/* Active candle crosshair readout */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
              {activeCandle ? (
                <div className="flex flex-wrap items-center gap-2 font-mono">
                  <span className="font-sans text-[11px] text-muted">
                    {new Date(activeCandle.bucketStart).toLocaleString("en-IN", {
                      timeZone: "Asia/Kolkata",
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}{" "}
                    IST
                  </span>
                  <span>O: {activeCandle.open}</span>
                  <span>H: {activeCandle.high}</span>
                  <span>L: {activeCandle.low}</span>
                  <span>C: {activeCandle.close}</span>
                  <span>Vol: {activeCandle.volumeUnits}u</span>
                  {activeCandle.isHighVolatility && (
                    <span className="rounded bg-[#fff6e0] px-1.5 py-0.5 font-sans text-[10px] font-semibold text-[#8a5a00]">
                      High Volatility
                    </span>
                  )}
                </div>
              ) : (
                <span>No candle selected</span>
              )}
              <span className="font-mono text-[11px]">
                Showing {visibleCandles.length} of {candles.length} candles · Y: [
                {chartGeometry.yMin}, {chartGeometry.yMax}] {CURRENCY_NAME}
              </span>
            </div>

            {/* SVG Candlestick + Volume Chart with Wheel Zoom & Drag Pan */}
            <div className="mt-2 overflow-x-auto select-none">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${chartGeometry.width} ${chartGeometry.height}`}
                className="h-72 w-full min-w-[520px] cursor-grab active:cursor-grabbing"
                role="img"
                aria-label="Aeros Market Synthetic Candlestick Chart"
                onMouseLeave={() => {
                  setHoveredIdx(null);
                  dragStateRef.current = null;
                }}
                onWheel={(e) => {
                  if (candles.length <= MIN_VISIBLE_CANDLES) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = Math.max(
                    0,
                    Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)),
                  );
                  if (e.deltaY < 0) {
                    setWindowRange((prev) => zoomCandleWindow(candles.length, prev, "in", relX));
                  } else if (e.deltaY > 0) {
                    setWindowRange((prev) => zoomCandleWindow(candles.length, prev, "out", relX));
                  }
                }}
                onPointerDown={(e) => {
                  dragStateRef.current = {
                    active: true,
                    startX: e.clientX,
                    initialWindow: windowRange,
                  };
                }}
                onPointerMove={(e) => {
                  const drag = dragStateRef.current;
                  if (!drag || !drag.active) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const pxPerCandle =
                    Math.max(1, rect.width) / Math.max(1, drag.initialWindow.visibleCount);
                  const deltaPx = e.clientX - drag.startX;
                  const deltaCandles = -Math.round(deltaPx / pxPerCandle);
                  if (deltaCandles !== 0) {
                    setHoveredIdx(null);
                    setWindowRange(
                      panCandleWindow(candles.length, drag.initialWindow, deltaCandles),
                    );
                  }
                }}
                onPointerUp={() => {
                  dragStateRef.current = null;
                }}
              >
                {/* Horizontal grid lines & whole-number price labels */}
                {chartGeometry.yTicks.map((tick, idx) => {
                  const y = chartGeometry.priceToY(tick);
                  return (
                    <g key={idx}>
                      <line
                        x1={chartGeometry.padLeft}
                        y1={y}
                        x2={chartGeometry.width - chartGeometry.padRight}
                        y2={y}
                        stroke="#e5e5e0"
                        strokeDasharray="3 3"
                      />
                      <text
                        x={chartGeometry.padLeft - 8}
                        y={y + 4}
                        textAnchor="end"
                        className="fill-[#6b6b66] font-mono text-[10px]"
                      >
                        {tick}
                      </text>
                    </g>
                  );
                })}

                {/* Separator between price pane and volume pane */}
                <line
                  x1={chartGeometry.padLeft}
                  y1={chartGeometry.padTop + chartGeometry.priceH + 6}
                  x2={chartGeometry.width - chartGeometry.padRight}
                  y2={chartGeometry.padTop + chartGeometry.priceH + 6}
                  stroke="#d5d5d0"
                />

                {/* Candles + Volume bars for the visible window */}
                {visibleCandles.map((c, idx) => {
                  const count = Math.max(1, visibleCandles.length);
                  const slotW = chartGeometry.plotW / count;
                  const cx = chartGeometry.padLeft + slotW * (idx + 0.5);
                  const bodyW = Math.max(3, Math.min(18, slotW * 0.66));

                  const isUp = c.close >= c.open;
                  const color = isUp ? "#137333" : "#b3261e";

                  const yHigh = chartGeometry.priceToY(c.high);
                  const yLow = chartGeometry.priceToY(c.low);
                  const yOpen = chartGeometry.priceToY(c.open);
                  const yClose = chartGeometry.priceToY(c.close);

                  const bodyTop = Math.min(yOpen, yClose);
                  const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));

                  // Volume bar in bottom strip (height up to 34px)
                  const volMaxH = 34;
                  const volBaseY = chartGeometry.height - 14;
                  const volH =
                    c.volumeUnits > 0
                      ? Math.max(3, (c.volumeUnits / chartGeometry.maxVolume) * volMaxH)
                      : 1;

                  const isHovered = hoveredIdx === idx;

                  return (
                    <g
                      key={c.bucketStart}
                      onMouseEnter={() => setHoveredIdx(idx)}
                      className="cursor-crosshair"
                    >
                      {isHovered && (
                        <line
                          x1={cx}
                          y1={chartGeometry.padTop}
                          x2={cx}
                          y2={volBaseY}
                          stroke="#999994"
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
                        strokeWidth={1.4}
                      />
                      {/* Open-Close Body */}
                      <rect
                        x={cx - bodyW / 2}
                        y={bodyTop}
                        width={bodyW}
                        height={bodyHeight}
                        fill={color}
                        rx={1}
                      />
                      {/* Real Executed Volume Bar */}
                      <rect
                        x={cx - bodyW / 2}
                        y={volBaseY - volH}
                        width={bodyW}
                        height={volH}
                        fill={c.volumeUnits > 0 ? color : "#d5d5d0"}
                        opacity={0.45}
                      />
                      {/* Invisible wider hit target for smooth hover */}
                      <rect
                        x={chartGeometry.padLeft + slotW * idx}
                        y={chartGeometry.padTop}
                        width={slotW}
                        height={chartGeometry.height - chartGeometry.padTop}
                        fill="transparent"
                      />
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted">
            <span>
              Tip: Use <strong>+ Zoom In / − Zoom Out</strong>, mouse wheel, or drag horizontally to
              inspect candles. Y-axis auto-scales to visible candles.
            </span>
            <span>
              Window: #{windowRange.startIndex + 1}–#{windowRange.endIndex} of {candles.length}
            </span>
          </div>
        </section>

        {/* Order Execution & Portfolio Panel (Long + Short) */}
        <section className="card flex flex-col justify-between p-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Trade AMI Index</h2>
              <span
                className={`badge ${
                  tradingEnabled ? "badge-active" : "badge-suspended"
                }`}
              >
                {tradingEnabled ? "TRADING LIVE" : "TRADING PAUSED"}
              </span>
            </div>

            {/* User Portfolio Box (Long + Short Positions) */}
            <div className="space-y-2 rounded-md bg-surface p-3.5 text-xs">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <div>
                  <p className="text-muted">Long Holdings</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold">
                    {portfolio.unitsHeld.toLocaleString()} units
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-muted">Long Avg Entry / Value</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold">
                    {portfolio.averageEntryPrice.toLocaleString()} /{" "}
                    {portfolio.marketValueAeros.toLocaleString()} {CURRENCY_NAME}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between border-b border-border pb-2">
                <div>
                  <p className="text-muted">Open Short Position</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold">
                    {shortUnitsHeld.toLocaleString()} units
                  </p>
                  {shortUnitsHeld > 0 && (
                    <p className="text-[11px] text-muted">
                      Avg Short Entry: {shortAverageEntryPrice.toLocaleString()} {CURRENCY_NAME}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-muted">Short Collateral / P&amp;L</p>
                  <p className="mt-0.5 font-mono text-sm font-semibold">
                    {shortCollateralLocked.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  {shortUnitsHeld > 0 && (
                    <p
                      className={`font-mono text-[11px] font-medium ${
                        shortUnrealizedPnlAeros >= 0 ? "text-success" : "text-danger"
                      }`}
                    >
                      Unrealized: {shortUnrealizedPnlAeros >= 0 ? "+" : ""}
                      {shortUnrealizedPnlAeros.toLocaleString()} {CURRENCY_NAME}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-0.5">
                <div>
                  <p className="text-muted">Long Unrealized P/L</p>
                  <p
                    className={`mt-0.5 font-mono font-medium ${
                      portfolio.unrealizedPnlAeros >= 0 ? "text-success" : "text-danger"
                    }`}
                  >
                    {portfolio.unrealizedPnlAeros >= 0 ? "+" : ""}
                    {portfolio.unrealizedPnlAeros.toLocaleString()} {CURRENCY_NAME}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-muted">Cumulative Realized P/L</p>
                  <p
                    className={`mt-0.5 font-mono font-medium ${
                      portfolio.realizedPnl >= 0 ? "text-success" : "text-danger"
                    }`}
                  >
                    {portfolio.realizedPnl >= 0 ? "+" : ""}
                    {portfolio.realizedPnl.toLocaleString()} {CURRENCY_NAME}
                  </p>
                </div>
              </div>
            </div>

            {/* 4-Mode Order Side Selector: BUY | SELL | SHORT | COVER */}
            <div className="grid grid-cols-2 gap-1.5 rounded-md bg-surface p-1">
              <button
                type="button"
                onClick={() => setSide("BUY")}
                className={`rounded py-1.5 text-xs font-semibold transition ${
                  side === "BUY"
                    ? "bg-[#137333] text-white"
                    : "text-muted hover:text-foreground"
                }`}
              >
                BUY (Long)
              </button>
              <button
                type="button"
                onClick={() => setSide("SELL")}
                className={`rounded py-1.5 text-xs font-semibold transition ${
                  side === "SELL"
                    ? "bg-[#b3261e] text-white"
                    : "text-muted hover:text-foreground"
                }`}
              >
                {portfolio.unitsHeld === 0 && shortSellingEnabled
                  ? "SELL (Opens Short)"
                  : "SELL (Close Long)"}
              </button>
              <button
                type="button"
                onClick={() => setSide("SHORT")}
                disabled={!shortSellingEnabled}
                className={`rounded py-1.5 text-xs font-semibold transition ${
                  side === "SHORT"
                    ? "bg-[#8a5a00] text-white"
                    : "text-muted hover:text-foreground disabled:opacity-40"
                }`}
              >
                SHORT (Open Short)
              </button>
              <button
                type="button"
                onClick={() => setSide("COVER")}
                disabled={shortUnitsHeld === 0}
                className={`rounded py-1.5 text-xs font-semibold transition ${
                  side === "COVER"
                    ? "bg-[#111111] text-white"
                    : "text-muted hover:text-foreground disabled:opacity-40"
                }`}
              >
                COVER (Close Short)
              </button>
            </div>

            {willAutoShortOnSell && (
              <div className="rounded border border-[#e5c98b] bg-[#fff6e0] p-2.5 text-[11px] text-[#8a5a00]">
                You hold <strong>0 long units</strong>. Submitting <strong>SELL</strong> will
                automatically open a <strong>100% collateralized Short position</strong> (profit when
                AMI price falls, loss when AMI price rises).
              </div>
            )}

            <form action={orderAction} className="space-y-3">
              <input type="hidden" name="side" value={side} />
              <input type="hidden" name="expectedPrice" value={currentPrice} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

              <div>
                <div className="flex items-center justify-between">
                  <label className="label">
                    Quantity (1 – {maxOrderUnits.toLocaleString()} units)
                  </label>
                  <button
                    type="button"
                    onClick={() => setQuantity(maxActionableUnits)}
                    className="text-[11px] font-medium text-muted underline hover:text-foreground"
                  >
                    Max ({maxActionableUnits})
                  </button>
                </div>
                <input
                  name="quantity"
                  type="number"
                  min={1}
                  max={maxOrderUnits}
                  step={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                  disabled={!tradingEnabled || orderPending}
                  className="input font-mono"
                />
              </div>

              <div>
                <label className="label text-xs">Slippage Protection</label>
                <select
                  name="maxSlippageBp"
                  value={maxSlippageBp}
                  onChange={(e) => setMaxSlippageBp(Number(e.target.value))}
                  disabled={!tradingEnabled || orderPending}
                  className="input text-xs"
                >
                  <option value={100}>1.00% max slippage</option>
                  <option value={200}>2.00% max slippage (Recommended)</option>
                  <option value={500}>5.00% max slippage</option>
                </select>
              </div>

              <div className="space-y-1 rounded-md border border-border p-3 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted">Execution Price (Server):</span>
                  <span className="font-mono font-medium">
                    {currentPrice.toLocaleString()} {CURRENCY_NAME} / unit
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">
                    {effectiveSide === "BUY"
                      ? "Total Cost:"
                      : effectiveSide === "SELL"
                        ? "Gross Proceeds:"
                        : effectiveSide === "SHORT"
                          ? `Collateral Locked (${(shortCollateralRatioBp / 100).toFixed(0)}%):`
                          : "Cover Notional:"}
                  </span>
                  <span className="font-mono font-semibold">
                    {(effectiveSide === "SHORT" ? estShortCollateral : estNotional).toLocaleString()}{" "}
                    {CURRENCY_NAME}
                  </span>
                </div>
                <div className="flex justify-between text-[11px] text-muted">
                  <span>Personal Wallet Balance:</span>
                  <span className="font-mono">
                    {userBalance.toLocaleString()} {CURRENCY_NAME}
                  </span>
                </div>
              </div>

              {orderState && !orderState.ok && (
                <p className="rounded bg-[#fdecea] p-2.5 text-xs text-danger">
                  {orderState.error}
                </p>
              )}

              {orderState && orderState.ok && (
                <p className="rounded bg-[#e8f5ee] p-2.5 text-xs text-success">
                  Executed {orderState.data.orderNumber} at{" "}
                  {orderState.data.executionPrice.toLocaleString()} {CURRENCY_NAME} (
                  {orderState.data.totalAeros.toLocaleString()} {CURRENCY_NAME} notional).
                </p>
              )}

              <button
                type="submit"
                disabled={!tradingEnabled || orderPending || !isOrderActionable}
                className={`btn w-full ${
                  effectiveSide === "BUY"
                    ? "bg-[#137333] text-white hover:opacity-95"
                    : effectiveSide === "SHORT"
                      ? "bg-[#8a5a00] text-white hover:opacity-95"
                      : effectiveSide === "COVER"
                        ? "bg-[#111111] text-white hover:opacity-95"
                        : "bg-[#b3261e] text-white hover:opacity-95"
                } disabled:opacity-50`}
              >
                {!tradingEnabled
                  ? "Trading Paused by Government"
                  : orderPending
                    ? "Executing Order…"
                    : effectiveSide === "BUY"
                      ? canAffordBuy
                        ? `Buy ${safeQty} AMI for ${estNotional.toLocaleString()} ${CURRENCY_NAME}`
                        : `Insufficient ${CURRENCY_NAME} Balance`
                      : effectiveSide === "SELL"
                        ? canSellHoldings
                          ? `Sell ${safeQty} Long AMI for ${estNotional.toLocaleString()} ${CURRENCY_NAME}`
                          : `Insufficient Long Holdings (${portfolio.unitsHeld} held)`
                        : effectiveSide === "SHORT"
                          ? canOpenShort
                            ? `Short ${safeQty} AMI (Lock ${estShortCollateral.toLocaleString()} ${CURRENCY_NAME})`
                            : userBalance < estShortCollateral
                              ? `Insufficient Collateral (${estShortCollateral.toLocaleString()} ${CURRENCY_NAME} needed)`
                              : `Exceeds Max Short Cap (${maxShortUnitsPerUser} units)`
                          : canCoverShort
                            ? `Cover ${safeQty} Short AMI @ ${currentPrice.toLocaleString()} ${CURRENCY_NAME}`
                            : `No Open Short Units to Cover (${shortUnitsHeld} held)`}
              </button>
            </form>
          </div>

          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            Long orders settle directly against the Government Treasury. Short orders lock 100%{" "}
            {CURRENCY_NAME} collateral in the Treasury and release collateral +/- realized P/L when
            covered, preserving the total economy supply invariant at all times.
          </p>
        </section>
      </div>
    </div>
  );
}
