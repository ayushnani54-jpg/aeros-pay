import { NextResponse } from "next/server";
import { getCurrentGovernment, getCurrentUser } from "@/lib/auth";
import { getGovernmentSingleton } from "@/lib/queries";
import { getMarketChartData } from "@/lib/synthetic-market";
import { DEFAULT_MARKET_TIMEFRAME, MARKET_TIMEFRAMES, type MarketTimeframe } from "@/lib/constants";

export const dynamic = "force-dynamic";

/**
 * Strictly READ-ONLY market chart endpoint (Spec §6):
 * - A chart refresh NEVER independently moves the market or creates market events.
 * - Enforces authentication and `government.marketEnabled` for non-Government callers.
 */
export async function GET(req: Request) {
  const [user, govSession, govRow] = await Promise.all([
    getCurrentUser(),
    getCurrentGovernment(),
    getGovernmentSingleton(),
  ]);

  if (!user && !govSession) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  if (!govSession && (!govRow || !govRow.marketEnabled)) {
    return NextResponse.json(
      { error: "Aeros Market is currently disabled by the Government." },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const rawTf = url.searchParams.get("timeframe") ?? DEFAULT_MARKET_TIMEFRAME;
  const timeframe: MarketTimeframe = (MARKET_TIMEFRAMES as readonly string[]).includes(rawTf)
    ? (rawTf as MarketTimeframe)
    : DEFAULT_MARKET_TIMEFRAME;

  const rawLimit = Number(url.searchParams.get("limit") ?? "48");
  const limit = Number.isInteger(rawLimit) ? Math.max(12, Math.min(96, rawLimit)) : 48;

  const chart = await getMarketChartData(timeframe, limit);

  return NextResponse.json(
    {
      timeframe,
      methodologyVersion: chart.state.methodologyVersion,
      currentPrice: chart.state.currentPrice,
      previousPrice: chart.state.previousPrice,
      minPrice: chart.state.minPrice,
      maxPrice: chart.state.maxPrice,
      stats24h: chart.stats24h,
      candles: chart.candles.map((c) => ({
        bucketStart: c.bucketStart.toISOString(),
        open: c.openPrice,
        high: c.highPrice,
        low: c.lowPrice,
        close: c.closePrice,
        volumeUnits: c.volumeUnits,
        volumeAeros: c.volumeAeros,
        tradeCount: c.tradeCount,
        isHighVolatility: c.isHighVolatility,
      })),
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
