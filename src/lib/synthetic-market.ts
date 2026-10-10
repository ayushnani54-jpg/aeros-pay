import "server-only";
import { createHash } from "crypto";
import { db } from "@/db/client";
import {
  government,
  marketCandles,
  marketOrders,
  marketPositions,
  marketState,
  users,
  type MarketCandle,
  type MarketOrder,
  type MarketPosition,
  type MarketState,
} from "@/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { transferInTx } from "./payments";
import { governmentWallet, userWallet } from "./wallets";
import { canUserSend } from "./status";
import {
  CURRENCY_NAME,
  MARKET_METHODOLOGY_VERSION,
  type MarketTimeframe,
} from "./constants";

/**
 * AEROS MARKET — INTERNAL SYNTHETIC MARKET & TRADING ENGINE (V4, Spec §§6, 7)
 * ============================================================================
 *
 * 1. SYNTHETIC INSTRUMENT & WHOLE-NUMBER PRICING
 *    - Tracks the internal Aeros Market Index (AMI) in whole-number Aeros per
 *      1 Index Unit (`currentPrice`, integer within `[minPrice, maxPrice]`).
 *    - Never uses Ethereum, cryptocurrency prices, TradingView scraping, or
 *      any external price feed.
 *
 * 2. DETERMINISTIC PROGRESSION & CHART REFRESH IMMUTABILITY
 *    - Time is partitioned into aligned 5-minute (`5m`), 15-minute (`15m`),
 *      and 1-hour (`1h`) UTC buckets.
 *    - Reading chart data (`getMarketChartData`) is strictly READ-ONLY once
 *      initial candles exist: refreshing the chart 1,000 times never mutates
 *      `market_state`, never advances the price, and never creates events.
 *    - Market state advances deterministically when:
 *      (a) an eligible user executes a trade (`placeMarketOrder`),
 *      (b) the Government triggers a sync or updates configuration, or
 *      (c) the table is initialized on first use (`ensureMarketInitialized`).
 *
 * 3. BOUNDED DEMAND IMPACT & ANTI-MANIPULATION
 *    - Genuine aggregate BUY/SELL order flow (`netOrderFlowUnits`) applies a
 *      modest, bounded pressure (`demandSensitivityBp`), dampened by
 *      `sqrt(activeBucketTraders)` and clamped to at most 40% of
 *      `maxStepChangeBp`.
 *    - Combined with deterministic pseudo-random noise derived from
 *      `SHA-256(seedKey : bucketEpoch : methodologyVersion)`, two BUY orders
 *      create a small upward bias without ever guaranteeing an upward move or
 *      allowing one user to manipulate the price.
 *
 * 4. TRADING SETTLEMENT & SUPPLY INVARIANT
 *    - BUY: User pays `quantity * executionPrice` Aeros to the Government
 *      Treasury via `transferInTx` (`MARKET_TRADE_BUY`, `taxExempt: true`),
 *      and receives `+quantity` AMI units in `market_positions`.
 *    - SELL: User surrenders `quantity` AMI units from `market_positions`
 *      (locked `FOR UPDATE` with `unitsHeld >= quantity`) and receives
 *      `quantity * executionPrice` Aeros from the Government Treasury via
 *      `transferInTx` (`MARKET_TRADE_SELL`, `taxExempt: true`).
 *    - Because every trade settles between a user wallet and the Government
 *      Treasury, `SUPPLY_INVARIANT` (`treasury + userHeld + companyHeld == totalSupply`)
 *      holds 100% before and after every trade.
 */

export class MarketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const FIVE_MIN_MS = 5 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export function alignBucketStart(date: Date, timeframe: MarketTimeframe): Date {
  const ms = date.getTime();
  const step =
    timeframe === "5m"
      ? FIVE_MIN_MS
      : timeframe === "15m"
        ? FIFTEEN_MIN_MS
        : ONE_HOUR_MS;
  return new Date(Math.floor(ms / step) * step);
}

/**
 * Deterministic hash values in `[-1, 1]` and `[0, 1]` for a given 5m bucket.
 */
function deterministicBucketSignals(seedKey: string, bucket5mMs: number): {
  noiseSigned: number; // [-1, 1]
  wickUpRatio: number; // [0, 1]
  wickDownRatio: number; // [0, 1]
  isHighVolatility: boolean;
} {
  const digest = createHash("sha256")
    .update(`${seedKey}:${bucket5mMs}:${MARKET_METHODOLOGY_VERSION}`)
    .digest();

  const u1 = digest.readUInt32BE(0) / 0xffffffff;
  const u2 = digest.readUInt32BE(4) / 0xffffffff;
  const u3 = digest.readUInt32BE(8) / 0xffffffff;
  const u4 = digest.readUInt32BE(12) / 0xffffffff;

  // Approximate normal-like centered noise in [-1, 1] by averaging two uniforms
  const noiseSigned = u1 + u2 - 1;
  // ~12% of buckets enter a higher-volatility regime
  const isHighVolatility = u4 > 0.88;

  return {
    noiseSigned,
    wickUpRatio: u2,
    wickDownRatio: u3,
    isHighVolatility,
  };
}

/**
 * Computes the next whole-number candle from `openPrice`, the market config,
 * the deterministic bucket signals, and any genuine order flow in the bucket.
 */
export function computeDeterministicStep(params: {
  openPrice: number;
  minPrice: number;
  maxPrice: number;
  baseVolatilityBp: number;
  demandSensitivityBp: number;
  maxStepChangeBp: number;
  netOrderFlowUnits: number;
  activeBucketTraders: number;
  seedKey: string;
  bucket5mMs: number;
}): {
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  isHighVolatility: boolean;
} {
  const signals = deterministicBucketSignals(params.seedKey, params.bucket5mMs);
  const effectiveVolBp = signals.isHighVolatility
    ? Math.min(params.baseVolatilityBp * 2, params.maxStepChangeBp)
    : params.baseVolatilityBp;

  // Natural deterministic drift in basis points
  const naturalDriftBp = signals.noiseSigned * effectiveVolBp;

  // Mean-reverting gentle pull toward the midpoint if near extremes
  const midPrice = Math.round((params.minPrice + params.maxPrice) / 2);
  const reversionBp =
    params.openPrice > params.maxPrice * 0.85
      ? -Math.min(40, Math.round(effectiveVolBp * 0.25))
      : params.openPrice < params.minPrice * 1.3
        ? Math.min(40, Math.round(effectiveVolBp * 0.25))
        : 0;

  // Bounded demand pressure: requires real order flow, dampened by trader count
  // and capped at 40% of maxStepChangeBp so one user or two orders cannot force a move.
  const traderWeight = Math.min(3, Math.sqrt(Math.max(1, params.activeBucketTraders)));
  const normalizedFlow = Math.tanh(params.netOrderFlowUnits / 50);
  const maxDemandBp = Math.floor(params.maxStepChangeBp * 0.4);
  const demandBp = Math.max(
    -maxDemandBp,
    Math.min(
      maxDemandBp,
      Math.round(normalizedFlow * params.demandSensitivityBp * traderWeight),
    ),
  );

  const totalChangeBp = Math.max(
    -params.maxStepChangeBp,
    Math.min(
      params.maxStepChangeBp,
      Math.round(naturalDriftBp + reversionBp + demandBp),
    ),
  );

  // Convert basis points to whole-number Aeros delta (ensure at least ±1 Aeros
  // movement when |totalChangeBp| >= 45 bp so integer prices around 100 show realistic candles)
  let rawDelta = Math.round((params.openPrice * totalChangeBp) / 10000);
  if (rawDelta === 0 && Math.abs(totalChangeBp) >= 45) {
    rawDelta = totalChangeBp > 0 ? 1 : -1;
  }
  void midPrice;

  const closePrice = Math.max(
    params.minPrice,
    Math.min(params.maxPrice, params.openPrice + rawDelta),
  );

  const wickSpan = Math.max(
    1,
    Math.round((params.openPrice * effectiveVolBp) / 10000),
  );
  const extraHigh = Math.round(wickSpan * signals.wickUpRatio);
  const extraLow = Math.round(wickSpan * signals.wickDownRatio);

  const highPrice = Math.min(
    params.maxPrice,
    Math.max(params.openPrice, closePrice) + extraHigh,
  );
  const lowPrice = Math.max(
    params.minPrice,
    Math.min(params.openPrice, closePrice) - extraLow,
  );

  return {
    openPrice: params.openPrice,
    highPrice: Math.max(highPrice, params.openPrice, closePrice),
    lowPrice: Math.min(lowPrice, params.openPrice, closePrice),
    closePrice,
    isHighVolatility: signals.isHighVolatility,
  };
}

async function upsertCandleRollupsInTx(
  tx: Tx,
  params: {
    bucket5m: Date;
    openPrice: number;
    highPrice: number;
    lowPrice: number;
    closePrice: number;
    volumeUnitsDelta: number;
    volumeAerosDelta: number;
    tradeCountDelta: number;
    buyUnitsDelta: number;
    sellUnitsDelta: number;
    isHighVolatility: boolean;
    methodologyVersion: string;
  },
): Promise<void> {
  const timeframes: MarketTimeframe[] = ["5m", "15m", "1h"];
  for (const tf of timeframes) {
    const bucketStart = alignBucketStart(params.bucket5m, tf);
    const [existing] = await tx
      .select()
      .from(marketCandles)
      .where(
        and(
          eq(marketCandles.timeframe, tf),
          eq(marketCandles.bucketStart, bucketStart),
        ),
      )
      .limit(1);

    if (!existing) {
      await tx.insert(marketCandles).values({
        timeframe: tf,
        bucketStart,
        openPrice: params.openPrice,
        highPrice: params.highPrice,
        lowPrice: params.lowPrice,
        closePrice: params.closePrice,
        volumeUnits: params.volumeUnitsDelta,
        volumeAeros: params.volumeAerosDelta,
        tradeCount: params.tradeCountDelta,
        buyUnits: params.buyUnitsDelta,
        sellUnits: params.sellUnitsDelta,
        isHighVolatility: params.isHighVolatility,
        methodologyVersion: params.methodologyVersion,
      });
    } else {
      const nextHigh = Math.max(existing.highPrice, params.highPrice, params.closePrice);
      const nextLow = Math.min(existing.lowPrice, params.lowPrice, params.closePrice);
      await tx
        .update(marketCandles)
        .set({
          highPrice: nextHigh,
          lowPrice: nextLow,
          closePrice: params.closePrice,
          volumeUnits: existing.volumeUnits + params.volumeUnitsDelta,
          volumeAeros: existing.volumeAeros + params.volumeAerosDelta,
          tradeCount: existing.tradeCount + params.tradeCountDelta,
          buyUnits: existing.buyUnits + params.buyUnitsDelta,
          sellUnits: existing.sellUnits + params.sellUnitsDelta,
          isHighVolatility: existing.isHighVolatility || params.isHighVolatility,
        })
        .where(eq(marketCandles.id, existing.id));
    }
  }
}

/**
 * Ensures the singleton `market_state` row and initial historical candles exist.
 * Once initialized, reading the chart does NOT advance or mutate state.
 */
export async function ensureMarketInitialized(): Promise<MarketState> {
  const [existingState] = await db.select().from(marketState).where(eq(marketState.id, 1)).limit(1);
  const [anyCandle] = await db
    .select({ id: marketCandles.id })
    .from(marketCandles)
    .limit(1);

  if (existingState && anyCandle) {
    return existingState;
  }

  return db.transaction(async (tx) => {
    const now5m = alignBucketStart(new Date(), "5m");
    // Start 48 5-minute buckets (4 hours) ago so 5m, 15m, and 1h charts have
    // immediate deterministic candles on first boot without fabricating volume.
    const bootstrapBuckets = 48;
    const startBucketMs = now5m.getTime() - bootstrapBuckets * FIVE_MIN_MS;

    await tx
      .insert(marketState)
      .values({
        id: 1,
        methodologyVersion: MARKET_METHODOLOGY_VERSION,
        currentPrice: 100,
        previousPrice: 100,
        open24hPrice: 100,
        high24hPrice: 100,
        low24hPrice: 100,
        minPrice: 10,
        maxPrice: 10000,
        baseVolatilityBp: 150,
        demandSensitivityBp: 50,
        maxStepChangeBp: 500,
        maxOrderUnits: 500,
        userCooldownSeconds: 10,
        activeBucket5m: new Date(startBucketMs),
      })
      .onConflictDoNothing();

    const [state] = await tx
      .select()
      .from(marketState)
      .where(eq(marketState.id, 1))
      .for("update");

    const [candleCheck] = await tx
      .select({ id: marketCandles.id })
      .from(marketCandles)
      .limit(1);

    if (candleCheck) {
      return state;
    }

    let runningPrice = state.currentPrice;
    let prevPrice = state.previousPrice;
    let high24 = runningPrice;
    let low24 = runningPrice;
    const open24 = runningPrice;

    for (let i = 0; i <= bootstrapBuckets; i++) {
      const bucketMs = startBucketMs + i * FIVE_MIN_MS;
      const step = computeDeterministicStep({
        openPrice: runningPrice,
        minPrice: state.minPrice,
        maxPrice: state.maxPrice,
        baseVolatilityBp: state.baseVolatilityBp,
        demandSensitivityBp: state.demandSensitivityBp,
        maxStepChangeBp: state.maxStepChangeBp,
        netOrderFlowUnits: 0,
        activeBucketTraders: 0,
        seedKey: state.seedKey,
        bucket5mMs: bucketMs,
      });

      prevPrice = runningPrice;
      runningPrice = step.closePrice;
      high24 = Math.max(high24, step.highPrice);
      low24 = Math.min(low24, step.lowPrice);

      await upsertCandleRollupsInTx(tx, {
        bucket5m: new Date(bucketMs),
        openPrice: step.openPrice,
        highPrice: step.highPrice,
        lowPrice: step.lowPrice,
        closePrice: step.closePrice,
        volumeUnitsDelta: 0,
        volumeAerosDelta: 0,
        tradeCountDelta: 0,
        buyUnitsDelta: 0,
        sellUnitsDelta: 0,
        isHighVolatility: step.isHighVolatility,
        methodologyVersion: state.methodologyVersion,
      });
    }

    const [updated] = await tx
      .update(marketState)
      .set({
        currentPrice: runningPrice,
        previousPrice: prevPrice,
        open24hPrice: open24,
        high24hPrice: high24,
        low24hPrice: low24,
        activeBucket5m: now5m,
        netOrderFlowUnits: 0,
        activeBucketTraders: 0,
        updatedAt: new Date(),
      })
      .where(eq(marketState.id, 1))
      .returning();

    return updated;
  });
}

/**
 * Advances the locked `market_state` up to the current 5-minute bucket inside
 * an active transaction (called during order execution or explicit Government
 * market sync — NEVER during a passive chart refresh).
 *
 * When the application has been idle for many hours, caps catch-up to the most
 * recent 72 buckets (6 hours) so a single transaction stays fast on Neon.
 */
async function advanceLockedMarketStateInTx(
  tx: Tx,
  state: MarketState,
  now: Date = new Date(),
): Promise<MarketState> {
  const targetBucket5m = alignBucketStart(now, "5m");
  const currentBucketMs = alignBucketStart(state.activeBucket5m, "5m").getTime();
  const targetBucketMs = targetBucket5m.getTime();

  if (targetBucketMs <= currentBucketMs) {
    return state;
  }

  const maxCatchupBuckets = 72; // 6 hours of 5m buckets max per sync
  const startMs = Math.max(
    currentBucketMs + FIVE_MIN_MS,
    targetBucketMs - (maxCatchupBuckets - 1) * FIVE_MIN_MS,
  );

  let runningPrice = state.currentPrice;
  let prevPrice = state.previousPrice;
  let high24 = state.high24hPrice;
  let low24 = state.low24hPrice;
  let pendingFlow = state.netOrderFlowUnits;
  let pendingTraders = state.activeBucketTraders;

  for (let ms = startMs; ms <= targetBucketMs; ms += FIVE_MIN_MS) {
    const step = computeDeterministicStep({
      openPrice: runningPrice,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice,
      baseVolatilityBp: state.baseVolatilityBp,
      demandSensitivityBp: state.demandSensitivityBp,
      maxStepChangeBp: state.maxStepChangeBp,
      netOrderFlowUnits: pendingFlow,
      activeBucketTraders: pendingTraders,
      seedKey: state.seedKey,
      bucket5mMs: ms,
    });

    prevPrice = runningPrice;
    runningPrice = step.closePrice;
    high24 = Math.max(high24, step.highPrice);
    low24 = Math.min(low24, step.lowPrice);
    // Order flow from the completed bucket has now been incorporated
    pendingFlow = 0;
    pendingTraders = 0;

    await upsertCandleRollupsInTx(tx, {
      bucket5m: new Date(ms),
      openPrice: step.openPrice,
      highPrice: step.highPrice,
      lowPrice: step.lowPrice,
      closePrice: step.closePrice,
      volumeUnitsDelta: 0,
      volumeAerosDelta: 0,
      tradeCountDelta: 0,
      buyUnitsDelta: 0,
      sellUnitsDelta: 0,
      isHighVolatility: step.isHighVolatility,
      methodologyVersion: state.methodologyVersion,
    });
  }

  const [updated] = await tx
    .update(marketState)
    .set({
      currentPrice: runningPrice,
      previousPrice: prevPrice,
      high24hPrice: high24,
      low24hPrice: low24,
      activeBucket5m: targetBucket5m,
      netOrderFlowUnits: 0,
      activeBucketTraders: 0,
      updatedAt: now,
    })
    .where(eq(marketState.id, 1))
    .returning();

  return updated;
}

/**
 * Explicit server-side market time sync (used by Government panel or scheduled
 * maintenance, never by passive chart refresh).
 */
export async function syncMarketClock(): Promise<MarketState> {
  await ensureMarketInitialized();
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(marketState)
      .where(eq(marketState.id, 1))
      .for("update");
    return advanceLockedMarketStateInTx(tx, state, new Date());
  });
}

/**
 * Pure read-only chart query once initialized. Refreshing the page or switching
 * timeframes (`5m`, `15m`, `1h`) never advances or mutates the market!
 */
export async function getMarketChartData(
  timeframe: MarketTimeframe = "15m",
  limit = 48,
): Promise<{
  state: MarketState;
  candles: MarketCandle[];
  stats24h: {
    changeAeros: number;
    changePercent: string;
    volumeUnits24h: number;
    volumeAeros24h: number;
    trades24h: number;
    high24h: number;
    low24h: number;
  };
}> {
  const state = await ensureMarketInitialized();

  const descCandles = await db
    .select()
    .from(marketCandles)
    .where(eq(marketCandles.timeframe, timeframe))
    .orderBy(desc(marketCandles.bucketStart))
    .limit(limit);

  const candles = [...descCandles].reverse();

  const since24h = new Date(Date.now() - 24 * ONE_HOUR_MS);
  const [rollup24h] = await db
    .select({
      volUnits: sql<number>`coalesce(sum(${marketCandles.volumeUnits}), 0)::int`,
      volAeros: sql<number>`coalesce(sum(${marketCandles.volumeAeros}), 0)::int`,
      trades: sql<number>`coalesce(sum(${marketCandles.tradeCount}), 0)::int`,
      high: sql<number>`coalesce(max(${marketCandles.highPrice}), ${state.currentPrice})::int`,
      low: sql<number>`coalesce(min(${marketCandles.lowPrice}), ${state.currentPrice})::int`,
    })
    .from(marketCandles)
    .where(
      and(
        eq(marketCandles.timeframe, "5m"),
        gte(marketCandles.bucketStart, since24h),
      ),
    );

  const firstCandleOpen = candles[0]?.openPrice ?? state.open24hPrice;
  const changeAeros = state.currentPrice - firstCandleOpen;
  const changePctNum =
    firstCandleOpen > 0 ? (changeAeros / firstCandleOpen) * 100 : 0;

  return {
    state,
    candles,
    stats24h: {
      changeAeros,
      changePercent: `${changePctNum >= 0 ? "+" : ""}${changePctNum.toFixed(2)}%`,
      volumeUnits24h: rollup24h?.volUnits ?? 0,
      volumeAeros24h: rollup24h?.volAeros ?? 0,
      trades24h: rollup24h?.trades ?? 0,
      high24h: rollup24h?.high ?? state.high24hPrice,
      low24h: rollup24h?.low ?? state.low24hPrice,
    },
  };
}

export async function getUserMarketPortfolio(userId: string): Promise<{
  position: MarketPosition;
  averageEntryPrice: number;
  marketValueAeros: number;
  unrealizedPnlAeros: number;
  recentOrders: MarketOrder[];
}> {
  const state = await ensureMarketInitialized();
  const [[pos], recentOrders] = await Promise.all([
    db.select().from(marketPositions).where(eq(marketPositions.userId, userId)).limit(1),
    db
      .select()
      .from(marketOrders)
      .where(eq(marketOrders.userId, userId))
      .orderBy(desc(marketOrders.createdAt))
      .limit(30),
  ]);

  const position: MarketPosition = pos ?? {
    userId,
    unitsHeld: 0,
    totalCostBasis: 0,
    realizedPnl: 0,
    totalBoughtUnits: 0,
    totalSoldUnits: 0,
    lastTradeAt: null,
    updatedAt: new Date(),
  };

  const averageEntryPrice =
    position.unitsHeld > 0
      ? Math.round(position.totalCostBasis / position.unitsHeld)
      : 0;
  const marketValueAeros = position.unitsHeld * state.currentPrice;
  const unrealizedPnlAeros =
    position.unitsHeld > 0 ? marketValueAeros - position.totalCostBasis : 0;

  return {
    position,
    averageEntryPrice,
    marketValueAeros,
    unrealizedPnlAeros,
    recentOrders,
  };
}

async function nextMarketOrderNumber(tx: Pick<typeof db, "execute">): Promise<string> {
  const res = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('market_order_number_seq') AS nextval`,
  );
  const seq = String(res.rows[0]?.nextval ?? "1").padStart(6, "0");
  return `TRD-${seq}`;
}

/**
 * Executes a BUY or SELL order on the Aeros Market.
 *
 * SECURITY & FAIRNESS GUARANTEES (Spec §7):
 * - Server-enforced feature checks (`marketEnabled` AND `tradingEnabled`).
 * - Client never chooses the execution price; `expectedPrice` is only used to
 *   protect the user against stale prices beyond `maxSlippageBp`.
 * - Locks `market_state` and `market_positions` `FOR UPDATE` inside the same
 *   database transaction as `transferInTx`.
 * - Enforces per-order size cap (`maxOrderUnits`) and per-user cooldown
 *   (`userCooldownSeconds`).
 * - Updates real executed volume on `market_candles` and applies a modest,
 *   bounded order-flow impact.
 */
export async function placeMarketOrder(params: {
  userId: string;
  side: "BUY" | "SELL";
  quantity: number;
  expectedPrice: number;
  maxSlippageBp?: number;
  idempotencyKey?: string | null;
}): Promise<MarketOrder> {
  if (!Number.isInteger(params.quantity) || params.quantity < 1) {
    throw new MarketError("Order quantity must be a positive whole number of units.");
  }

  await ensureMarketInitialized();

  return db.transaction(async (tx: Tx) => {
    const [gov] = await tx.select().from(government).limit(1);
    if (!gov) {
      throw new MarketError("Government account is not initialized.");
    }
    if (!gov.marketEnabled || !gov.tradingEnabled) {
      throw new MarketError(
        "Aeros Market trading is currently disabled by the Government.",
      );
    }

    if (params.idempotencyKey) {
      const [existingOrder] = await tx
        .select()
        .from(marketOrders)
        .where(eq(marketOrders.idempotencyKey, params.idempotencyKey))
        .limit(1);
      if (existingOrder) {
        if (existingOrder.userId !== params.userId) {
          throw new MarketError("Idempotency key conflict.");
        }
        return existingOrder;
      }
    }

    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, params.userId))
      .for("update");
    if (!user) throw new MarketError("User account not found.");
    if (!canUserSend(user)) {
      throw new MarketError(
        user.status === "BANNED"
          ? "Banned accounts cannot place synthetic market orders."
          : "Suspended accounts cannot place synthetic market orders right now.",
      );
    }

    // Lock market_state singleton row
    const [rawState] = await tx
      .select()
      .from(marketState)
      .where(eq(marketState.id, 1))
      .for("update");
    const now = new Date();
    const state = await advanceLockedMarketStateInTx(tx, rawState, now);

    if (params.quantity > state.maxOrderUnits) {
      throw new MarketError(
        `Maximum order size is ${state.maxOrderUnits.toLocaleString()} units per trade.`,
      );
    }

    // Ensure user position row exists and lock it FOR UPDATE
    await tx
      .insert(marketPositions)
      .values({ userId: user.id })
      .onConflictDoNothing();

    const [position] = await tx
      .select()
      .from(marketPositions)
      .where(eq(marketPositions.userId, user.id))
      .for("update");

    // Per-user cooldown check (anti-manipulation)
    if (
      state.userCooldownSeconds > 0 &&
      position.lastTradeAt &&
      now.getTime() - position.lastTradeAt.getTime() < state.userCooldownSeconds * 1000
    ) {
      const waitSec = Math.ceil(
        (state.userCooldownSeconds * 1000 - (now.getTime() - position.lastTradeAt.getTime())) /
          1000,
      );
      throw new MarketError(
        `Please wait ${waitSec}s before placing another market order.`,
      );
    }

    // Authoritative server execution price
    const executionPrice = state.currentPrice;
    const slippageBp = Math.max(0, Math.min(2000, params.maxSlippageBp ?? 200));

    // Staleness / slippage check
    if (params.side === "BUY") {
      const maxAcceptablePrice = Math.ceil(
        (params.expectedPrice * (10000 + slippageBp)) / 10000,
      );
      if (executionPrice > maxAcceptablePrice) {
        throw new MarketError(
          `Market price moved to ${executionPrice} ${CURRENCY_NAME} (above your ${maxAcceptablePrice} ${CURRENCY_NAME} slippage limit). Please review and submit again.`,
        );
      }
    } else {
      const minAcceptablePrice = Math.floor(
        (params.expectedPrice * (10000 - slippageBp)) / 10000,
      );
      if (executionPrice < minAcceptablePrice) {
        throw new MarketError(
          `Market price moved to ${executionPrice} ${CURRENCY_NAME} (below your ${minAcceptablePrice} ${CURRENCY_NAME} slippage limit). Please review and submit again.`,
        );
      }
    }

    const totalAeros = params.quantity * executionPrice;
    const orderNumber = await nextMarketOrderNumber(tx);

    let txRef: string;
    let costBasisDelta = 0;
    let realizedPnlDelta = 0;

    if (params.side === "BUY") {
      const transfer = await transferInTx(tx, {
        from: userWallet(user.id),
        to: governmentWallet(gov.id),
        amount: totalAeros,
        type: "MARKET_TRADE_BUY",
        reason: `Market BUY ${orderNumber}: ${params.quantity} AMI @ ${executionPrice} ${CURRENCY_NAME}`,
        forcedTaxRateBp: 0,
      });
      txRef = transfer.txRef;
      costBasisDelta = totalAeros;

      await tx
        .update(marketPositions)
        .set({
          unitsHeld: position.unitsHeld + params.quantity,
          totalCostBasis: position.totalCostBasis + totalAeros,
          totalBoughtUnits: position.totalBoughtUnits + params.quantity,
          lastTradeAt: now,
          updatedAt: now,
        })
        .where(eq(marketPositions.userId, user.id));
    } else {
      if (position.unitsHeld < params.quantity) {
        throw new MarketError(
          `Insufficient index holdings: you hold ${position.unitsHeld} units and cannot sell ${params.quantity} units.`,
        );
      }

      // Proportional cost basis removed for the sold units
      const removedCostBasis =
        position.unitsHeld === params.quantity
          ? position.totalCostBasis
          : Math.round((position.totalCostBasis * params.quantity) / position.unitsHeld);

      costBasisDelta = -removedCostBasis;
      realizedPnlDelta = totalAeros - removedCostBasis;

      const transfer = await transferInTx(tx, {
        from: governmentWallet(gov.id),
        to: userWallet(user.id),
        amount: totalAeros,
        type: "MARKET_TRADE_SELL",
        reason: `Market SELL ${orderNumber}: ${params.quantity} AMI @ ${executionPrice} ${CURRENCY_NAME}`,
        forcedTaxRateBp: 0,
      });
      txRef = transfer.txRef;

      const nextUnits = position.unitsHeld - params.quantity;
      const nextCostBasis = nextUnits === 0 ? 0 : Math.max(0, position.totalCostBasis - removedCostBasis);

      await tx
        .update(marketPositions)
        .set({
          unitsHeld: nextUnits,
          totalCostBasis: nextCostBasis,
          realizedPnl: position.realizedPnl + realizedPnlDelta,
          totalSoldUnits: position.totalSoldUnits + params.quantity,
          lastTradeAt: now,
          updatedAt: now,
        })
        .where(eq(marketPositions.userId, user.id));
    }

    // Modest bounded immediate demand impact:
    // Small orders nudge netOrderFlowUnits; only when accumulated order flow
    // crosses a meaningful threshold does currentPrice move by ±1..maxStep within bounds.
    const signedUnits = params.side === "BUY" ? params.quantity : -params.quantity;
    const nextNetFlow = state.netOrderFlowUnits + signedUnits;
    const nextTraders = state.activeBucketTraders + 1;

    const flowRatio = Math.tanh(nextNetFlow / Math.max(25, state.maxOrderUnits * 0.25));
    const maxImmediateBp = Math.min(120, Math.floor(state.maxStepChangeBp * 0.25));
    const impactBp = Math.max(
      -maxImmediateBp,
      Math.min(maxImmediateBp, Math.round(flowRatio * state.demandSensitivityBp)),
    );

    let priceDelta = Math.round((executionPrice * impactBp) / 10000);
    if (priceDelta === 0 && Math.abs(nextNetFlow) >= 15 && state.demandSensitivityBp > 0) {
      // Deterministic tie-breaker so two BUY orders can create a small +1 Aeros
      // nudge without guaranteeing it on every single order
      const tieDigest = createHash("sha256")
        .update(`${state.seedKey}:${orderNumber}:${nextNetFlow}`)
        .digest();
      if (tieDigest[0] >= 96) {
        priceDelta = nextNetFlow > 0 ? 1 : -1;
      }
    }

    const postTradePrice = Math.max(
      state.minPrice,
      Math.min(state.maxPrice, executionPrice + priceDelta),
    );

    const bucket5m = alignBucketStart(now, "5m");
    await upsertCandleRollupsInTx(tx, {
      bucket5m,
      openPrice: executionPrice,
      highPrice: Math.max(executionPrice, postTradePrice),
      lowPrice: Math.min(executionPrice, postTradePrice),
      closePrice: postTradePrice,
      volumeUnitsDelta: params.quantity,
      volumeAerosDelta: totalAeros,
      tradeCountDelta: 1,
      buyUnitsDelta: params.side === "BUY" ? params.quantity : 0,
      sellUnitsDelta: params.side === "SELL" ? params.quantity : 0,
      isHighVolatility: false,
      methodologyVersion: state.methodologyVersion,
    });

    await tx
      .update(marketState)
      .set({
        previousPrice: executionPrice,
        currentPrice: postTradePrice,
        high24hPrice: Math.max(state.high24hPrice, postTradePrice),
        low24hPrice: Math.min(state.low24hPrice, postTradePrice),
        netOrderFlowUnits: nextNetFlow,
        activeBucketTraders: nextTraders,
        updatedAt: now,
      })
      .where(eq(marketState.id, 1));

    const [createdOrder] = await tx
      .insert(marketOrders)
      .values({
        orderNumber,
        userId: user.id,
        side: params.side,
        quantity: params.quantity,
        expectedPrice: params.expectedPrice,
        maxSlippageBp: slippageBp,
        executionPrice,
        totalAeros,
        costBasisDelta,
        realizedPnlDelta,
        status: "EXECUTED",
        txRef,
        idempotencyKey: params.idempotencyKey || null,
        methodologyVersion: state.methodologyVersion,
      })
      .returning();

    await recordAudit(tx, {
      action: params.side === "BUY" ? "MARKET_ORDER_BUY" : "MARKET_ORDER_SELL",
      actorType: "USER",
      actorId: user.id,
      actorLabel: user.username,
      targetType: "MARKET_ORDER",
      targetId: createdOrder.id,
      previousValue: `${executionPrice} ${CURRENCY_NAME}`,
      newValue: `${orderNumber}: ${params.side} ${params.quantity} AMI @ ${executionPrice} ${CURRENCY_NAME} (${totalAeros} ${CURRENCY_NAME}, post=${postTradePrice})`,
      metadata: {
        orderNumber,
        side: params.side,
        quantity: params.quantity,
        executionPrice,
        totalAeros,
        postTradePrice,
        txRef,
      },
    });

    return createdOrder;
  });
}

/**
 * Updates the synthetic market parameters from the Government panel.
 */
export async function updateMarketConfig(params: {
  govId: string;
  govUsername: string;
  minPrice: number;
  maxPrice: number;
  baseVolatilityBp: number;
  demandSensitivityBp: number;
  maxStepChangeBp: number;
  maxOrderUnits: number;
  userCooldownSeconds: number;
}): Promise<MarketState> {
  await ensureMarketInitialized();

  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(marketState)
      .where(eq(marketState.id, 1))
      .for("update");

    const clampedCurrentPrice = Math.max(
      params.minPrice,
      Math.min(params.maxPrice, state.currentPrice),
    );

    const [updated] = await tx
      .update(marketState)
      .set({
        minPrice: params.minPrice,
        maxPrice: params.maxPrice,
        currentPrice: clampedCurrentPrice,
        high24hPrice: Math.max(params.minPrice, Math.min(params.maxPrice, state.high24hPrice)),
        low24hPrice: Math.max(params.minPrice, Math.min(params.maxPrice, state.low24hPrice)),
        baseVolatilityBp: params.baseVolatilityBp,
        demandSensitivityBp: params.demandSensitivityBp,
        maxStepChangeBp: params.maxStepChangeBp,
        maxOrderUnits: params.maxOrderUnits,
        userCooldownSeconds: params.userCooldownSeconds,
        updatedAt: new Date(),
      })
      .where(eq(marketState.id, 1))
      .returning();

    await recordAudit(tx, {
      action: "MARKET_CONFIG_UPDATED",
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "MARKET_STATE",
      targetId: "1",
      previousValue: `bounds=[${state.minPrice},${state.maxPrice}], vol=${state.baseVolatilityBp}bp, demand=${state.demandSensitivityBp}bp, maxStep=${state.maxStepChangeBp}bp`,
      newValue: `bounds=[${updated.minPrice},${updated.maxPrice}], vol=${updated.baseVolatilityBp}bp, demand=${updated.demandSensitivityBp}bp, maxStep=${updated.maxStepChangeBp}bp`,
      metadata: {
        minPrice: updated.minPrice,
        maxPrice: updated.maxPrice,
        baseVolatilityBp: updated.baseVolatilityBp,
        demandSensitivityBp: updated.demandSensitivityBp,
        maxStepChangeBp: updated.maxStepChangeBp,
        maxOrderUnits: updated.maxOrderUnits,
        userCooldownSeconds: updated.userCooldownSeconds,
      },
    });

    return updated;
  });
}

export async function getRecentMarketOrdersForGov(limit = 100): Promise<
  Array<{
    order: MarketOrder;
    username: string;
    displayName: string;
  }>
> {
  return db
    .select({
      order: marketOrders,
      username: users.username,
      displayName: users.displayName,
    })
    .from(marketOrders)
    .innerJoin(users, eq(users.id, marketOrders.userId))
    .orderBy(desc(marketOrders.createdAt))
    .limit(limit);
}
