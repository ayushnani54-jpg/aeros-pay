// Pure client/server utilities for Aeros Market chart zoom, pan, visible-slice
// windowing, and dynamic Y-axis auto-scaling (V4.1 Defect 6.A fix).

export interface ChartCandlePoint {
  bucketStart: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUnits: number;
  volumeAeros: number;
  tradeCount: number;
  isHighVolatility: boolean;
}

export interface VisibleWindowRange {
  /** Inclusive start index into `candles` (`0 <= startIndex < candles.length`). */
  startIndex: number;
  /** Exclusive end index into `candles` (`startIndex < endIndex <= candles.length`). */
  endIndex: number;
  /** Number of visible candles (`endIndex - startIndex`). */
  visibleCount: number;
}

export const MIN_VISIBLE_CANDLES = 8;
export const MAX_VISIBLE_CANDLES = 240;

/**
 * Clamps a `[startIndex, endIndex)` window against a total candle array length
 * while enforcing `[MIN_VISIBLE_CANDLES, MAX_VISIBLE_CANDLES]`.
 */
export function clampCandleWindow(
  totalCandles: number,
  startIndex: number,
  endIndex: number,
): VisibleWindowRange {
  if (totalCandles <= 0) {
    return { startIndex: 0, endIndex: 0, visibleCount: 0 };
  }
  const minCount = Math.min(totalCandles, MIN_VISIBLE_CANDLES);
  const maxCount = Math.min(totalCandles, MAX_VISIBLE_CANDLES);
  const requestedCount = Math.max(minCount, Math.min(maxCount, endIndex - startIndex));

  let start = Math.max(0, Math.min(totalCandles - requestedCount, Math.trunc(startIndex)));
  let end = start + requestedCount;
  if (end > totalCandles) {
    end = totalCandles;
    start = Math.max(0, end - requestedCount);
  }
  return {
    startIndex: start,
    endIndex: end,
    visibleCount: end - start,
  };
}

/**
 * Zooms the current visible window in (`direction = "in"`) or out (`direction = "out"`),
 * anchored around `anchorRatio` (`0.0` = left edge, `0.5` = center, `1.0` = right edge / latest candle).
 */
export function zoomCandleWindow(
  totalCandles: number,
  current: VisibleWindowRange,
  direction: "in" | "out",
  anchorRatio = 1.0,
): VisibleWindowRange {
  if (totalCandles <= MIN_VISIBLE_CANDLES) {
    return clampCandleWindow(totalCandles, 0, totalCandles);
  }

  const clampedAnchor = Math.max(0, Math.min(1, anchorRatio));
  const currentCount = Math.max(1, current.endIndex - current.startIndex);
  const factor = direction === "in" ? 0.72 : 1.38;
  const rawNextCount = Math.round(currentCount * factor);
  const nextCount =
    direction === "in"
      ? Math.min(currentCount - 2, rawNextCount)
      : Math.max(currentCount + 2, rawNextCount);

  const boundedCount = Math.max(
    Math.min(totalCandles, MIN_VISIBLE_CANDLES),
    Math.min(Math.min(totalCandles, MAX_VISIBLE_CANDLES), nextCount),
  );

  const anchorIndex = current.startIndex + currentCount * clampedAnchor;
  const nextStart = Math.round(anchorIndex - boundedCount * clampedAnchor);
  return clampCandleWindow(totalCandles, nextStart, nextStart + boundedCount);
}

/**
 * Pans the current visible window left (older candles, `deltaCandles < 0`) or
 * right (newer candles, `deltaCandles > 0`) while keeping `visibleCount` constant.
 */
export function panCandleWindow(
  totalCandles: number,
  current: VisibleWindowRange,
  deltaCandles: number,
): VisibleWindowRange {
  if (totalCandles <= 0) {
    return { startIndex: 0, endIndex: 0, visibleCount: 0 };
  }
  const count = Math.max(
    Math.min(totalCandles, MIN_VISIBLE_CANDLES),
    current.endIndex - current.startIndex,
  );
  const nextStart = current.startIndex + Math.trunc(deltaCandles);
  return clampCandleWindow(totalCandles, nextStart, nextStart + count);
}

/**
 * Computes dynamic Y-axis bounds and whole-number price grid ticks strictly for
 * the visible candle slice so zooming in expands vertical price resolution.
 */
export function computeVisibleYScale(
  visibleCandles: ChartCandlePoint[],
  fallbackPrice = 100,
): {
  yMin: number;
  yMax: number;
  ySpan: number;
  yTicks: number[];
  maxVolume: number;
} {
  const lows = visibleCandles.map((c) => c.low);
  const highs = visibleCandles.map((c) => c.high);
  const rawLow = lows.length > 0 ? Math.min(...lows) : Math.max(1, fallbackPrice - 5);
  const rawHigh = highs.length > 0 ? Math.max(...highs) : fallbackPrice + 5;
  const pad = Math.max(2, Math.ceil((rawHigh - rawLow) * 0.12));

  const yMin = Math.max(1, rawLow - pad);
  const yMax = Math.max(yMin + 4, rawHigh + pad);
  const ySpan = Math.max(1, yMax - yMin);

  const yTicks = [
    yMax,
    Math.round(yMin + ySpan * 0.75),
    Math.round(yMin + ySpan * 0.5),
    Math.round(yMin + ySpan * 0.25),
    yMin,
  ];

  const maxVolume = Math.max(1, ...visibleCandles.map((c) => c.volumeUnits));
  return {
    yMin,
    yMax,
    ySpan,
    yTicks,
    maxVolume,
  };
}
