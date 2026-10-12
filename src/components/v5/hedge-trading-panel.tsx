"use client";

import React, { useState } from "react";
import {
  openHedgePositionAction,
  closeHedgePositionAction,
  requestLeverageUpgradeAction,
} from "@/actions/v5";
import { V5ActionForm } from "./action-feedback";
import { CURRENCY_NAME, LEVERAGE_LEVELS } from "@/lib/constants";

export interface SerializedHedgePosition {
  id: string;
  positionNumber: string;
  direction: "LONG" | "SHORT";
  sideLabel: "BUY" | "SELL";
  quantity: number;
  leverage: number;
  entryPrice: number;
  notionalValueAeros: number;
  marginLocked: number;
  liquidationPrice: number;
  status: "OPEN" | "CLOSED" | "LIQUIDATED";
  closePrice: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number;
  effectiveEquity: number;
  wouldLiquidate: boolean;
  openTxRef: string | null;
  closeTxRef: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface SerializedLeverageRequest {
  id: string;
  requestNumber: string;
  currentLeverage: number;
  requestedLeverage: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewNote: string | null;
  createdAt: string;
}

export function HedgeTradingPanel({
  currentPrice,
  marketUpdateIntervalMinutes,
  tradingEnabled,
  userBalance,
  maxOrderUnits,
  userMaxLeverage,
  openPositions,
  closedPositions,
  leverageRequests,
}: {
  currentPrice: number;
  marketUpdateIntervalMinutes: number;
  tradingEnabled: boolean;
  userBalance: number;
  maxOrderUnits: number;
  userMaxLeverage: number;
  openPositions: SerializedHedgePosition[];
  closedPositions: SerializedHedgePosition[];
  leverageRequests: SerializedLeverageRequest[];
}) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [quantity, setQuantity] = useState<string>("5");
  const [leverage, setLeverage] = useState<number>(2);
  const [activeTab, setActiveTab] = useState<"OPEN" | "HISTORY" | "LEVERAGE" | "GUIDE">("OPEN");

  const parsedQty = Math.max(0, Math.floor(Number(quantity) || 0));
  const notionalAeros = parsedQty * currentPrice;
  const requiredMargin = parsedQty > 0 ? Math.max(1, Math.ceil(notionalAeros / leverage)) : 0;

  // Liquidation price preview
  const estLiquidationPrice =
    parsedQty > 0
      ? side === "BUY"
        ? Math.max(1, currentPrice - Math.floor(requiredMargin / parsedQty))
        : currentPrice + Math.floor(requiredMargin / parsedQty)
      : 0;

  const availableLeverageOptions = LEVERAGE_LEVELS.filter((lvl) => lvl <= userMaxLeverage);

  // Determine next progression step (2 -> 4 -> 8 -> 10)
  const nextLeverageStep =
    userMaxLeverage <= 2
      ? 4
      : userMaxLeverage === 4
        ? 8
        : userMaxLeverage === 8
          ? 10
          : null;

  const totalMarginLocked = openPositions.reduce((sum, p) => sum + p.marginLocked, 0);
  const totalUnrealizedPnl = openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const longPositionsCount = openPositions.filter((p) => p.direction === "LONG").length;
  const shortPositionsCount = openPositions.filter((p) => p.direction === "SHORT").length;

  return (
    <div className="space-y-6">
      {/* V5 Hedge Trading Header Banner */}
      <div className="theme-market-banner rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-emerald-400/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-emerald-200">
                Hedge-Style Execution
              </span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/90">
                Market Clock: Every {marketUpdateIntervalMinutes}m
              </span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/90">
                Approved Max Leverage: {userMaxLeverage}x (Cap 10x)
              </span>
            </div>
            <h2 className="mt-1.5 text-lg font-semibold sm:text-xl">
              Independent BUY (Long) &amp; SELL (Short) Position Terminal
            </h2>
            <p className="mt-0.5 text-xs text-emerald-100/85">
              Each trade opens an independent position. Opposing trades never auto-cancel each
              other — hold Long and Short simultaneously and close any individual position on
              demand.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-black/25 p-2.5 text-center text-xs sm:min-w-[280px]">
            <div>
              <p className="text-[10px] uppercase text-emerald-200/75">Open Positions</p>
              <p className="font-mono text-sm font-bold">
                {openPositions.length} ({longPositionsCount}L / {shortPositionsCount}S)
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-emerald-200/75">Margin Locked</p>
              <p className="font-mono text-sm font-bold">
                {totalMarginLocked.toLocaleString("en-IN")} A
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-emerald-200/75">Unrealized P&amp;L</p>
              <p
                className={`font-mono text-sm font-bold ${
                  totalUnrealizedPnl >= 0 ? "text-emerald-300" : "text-red-300"
                }`}
              >
                {totalUnrealizedPnl >= 0 ? "+" : ""}
                {totalUnrealizedPnl.toLocaleString("en-IN")} A
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main Grid: Left = Open New Hedge Position, Right = Positions & Beginner Guide */}
      <div className="grid gap-5 lg:grid-cols-12">
        {/* Left Column: Simplified BUY (Long) / SELL (Short) Order Ticket */}
        <div className="card p-4 sm:p-5 lg:col-span-5">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">Open New Hedge Position</h3>
            <span className="font-mono text-xs text-muted">
              Index: <strong>{currentPrice.toLocaleString("en-IN")} A</strong>
            </span>
          </div>

          {/* Two-Button BUY (Long) vs SELL (Short) Selector */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setSide("BUY")}
              className={`rounded-lg border px-3 py-2.5 text-center transition-all ${
                side === "BUY"
                  ? "border-[#146c2e] bg-[#146c2e] text-white shadow-xs"
                  : "border-border bg-surface text-foreground hover:bg-emerald-50"
              }`}
            >
              <div className="text-sm font-bold">BUY (LONG)</div>
              <div className="text-[11px] opacity-85">Profit when index rises ↑</div>
            </button>
            <button
              type="button"
              onClick={() => setSide("SELL")}
              className={`rounded-lg border px-3 py-2.5 text-center transition-all ${
                side === "SELL"
                  ? "border-[#b3261e] bg-[#b3261e] text-white shadow-xs"
                  : "border-border bg-surface text-foreground hover:bg-red-50"
              }`}
            >
              <div className="text-sm font-bold">SELL (SHORT)</div>
              <div className="text-[11px] opacity-85">Profit when index falls ↓</div>
            </button>
          </div>

          <V5ActionForm
            action={openHedgePositionAction}
            operationKey={`hedge-open-${side}`}
            operationTitle={`Opening ${side === "BUY" ? "LONG (BUY)" : "SHORT (SELL)"} Position`}
            processingDetail="Locking margin and recording independent hedge position on Neon..."
            className="mt-4 space-y-3.5"
          >
            {(pending) => (
              <>
                <input type="hidden" name="side" value={side} />
                <input type="hidden" name="leverage" value={String(leverage)} />
                <input type="hidden" name="expectedPrice" value={String(currentPrice)} />
                <input type="hidden" name="maxSlippageBp" value="500" />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={`hdg-${side}-${parsedQty}-${leverage}-${currentPrice}`}
                />

                <div>
                  <div className="flex items-center justify-between text-xs">
                    <label htmlFor="hedge-qty" className="font-medium">
                      Position Size (Units, 1–{maxOrderUnits})
                    </label>
                    <span className="text-muted">
                      Wallet: <strong>{userBalance.toLocaleString("en-IN")} A</strong>
                    </span>
                  </div>
                  <div className="mt-1 flex gap-1.5">
                    <input
                      id="hedge-qty"
                      name="quantity"
                      type="number"
                      min={1}
                      max={maxOrderUnits}
                      step={1}
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      className="input font-mono"
                      required
                    />
                    {[1, 5, 10, 25].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setQuantity(String(preset))}
                        className="rounded-lg border border-border bg-surface px-2.5 text-xs font-semibold hover:bg-black hover:text-white"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Leverage Selector */}
                <div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium">Leverage Multiplier (Max 10x)</span>
                    <button
                      type="button"
                      onClick={() => setActiveTab("LEVERAGE")}
                      className="font-medium text-emerald-700 underline"
                    >
                      {userMaxLeverage < 10
                        ? `Unlock up to 10x (Currently ${userMaxLeverage}x)`
                        : "Max 10x Unlocked"}
                    </button>
                  </div>
                  <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                    {LEVERAGE_LEVELS.map((lvl) => {
                      const unlocked = availableLeverageOptions.includes(lvl);
                      const active = leverage === lvl;
                      return (
                        <button
                          key={lvl}
                          type="button"
                          disabled={!unlocked}
                          onClick={() => unlocked && setLeverage(lvl)}
                          className={`rounded-lg border py-1.5 text-xs font-bold transition-colors ${
                            active
                              ? "border-black bg-black text-white"
                              : unlocked
                                ? "border-border bg-surface text-foreground hover:border-black"
                                : "cursor-not-allowed border-border bg-surface/50 text-muted opacity-50"
                          }`}
                          title={
                            unlocked
                              ? `Use ${lvl}x leverage`
                              : `Request ${lvl}x leverage approval from Government`
                          }
                        >
                          {lvl}x {!unlocked && "🔒"}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Live Position Summary Box */}
                <div className="space-y-1.5 rounded-lg border border-border bg-surface p-3 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted">Position Direction:</span>
                    <span
                      className={`font-bold ${
                        side === "BUY" ? "text-[#146c2e]" : "text-[#b3261e]"
                      }`}
                    >
                      {side === "BUY" ? "LONG (BUY)" : "SHORT (SELL)"} · Independent Position
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Notional Exposure:</span>
                    <span className="font-mono font-semibold">
                      {notionalAeros.toLocaleString("en-IN")} {CURRENCY_NAME}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Required Margin ({leverage}x):</span>
                    <span className="font-mono font-bold">
                      {requiredMargin.toLocaleString("en-IN")} {CURRENCY_NAME}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Est. Liquidation Price:</span>
                    <span className="font-mono font-medium text-amber-800">
                      {estLiquidationPrice.toLocaleString("en-IN")} {CURRENCY_NAME}
                    </span>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={
                    !tradingEnabled ||
                    pending ||
                    parsedQty <= 0 ||
                    requiredMargin > userBalance
                  }
                  className={`btn w-full font-semibold text-white ${
                    side === "BUY"
                      ? "bg-[#146c2e] hover:bg-[#0f5323]"
                      : "bg-[#b3261e] hover:bg-[#8f1e17]"
                  } disabled:opacity-50`}
                >
                  {pending
                    ? "Executing on Server..."
                    : requiredMargin > userBalance
                      ? `Insufficient Balance (Need ${requiredMargin.toLocaleString("en-IN")} A)`
                      : `Open ${side === "BUY" ? "BUY (Long)" : "SELL (Short)"} Position (${requiredMargin.toLocaleString("en-IN")} A Margin)`}
                </button>
              </>
            )}
          </V5ActionForm>
        </div>

        {/* Right Column: Tabs for Open Positions, Closed History, Leverage Upgrade & Beginner Guide */}
        <div className="card p-4 sm:p-5 lg:col-span-7">
          <div className="flex flex-wrap gap-1.5 border-b border-border pb-3">
            <button
              type="button"
              onClick={() => setActiveTab("OPEN")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                activeTab === "OPEN"
                  ? "bg-black text-white"
                  : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              Open Positions ({openPositions.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("HISTORY")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                activeTab === "HISTORY"
                  ? "bg-black text-white"
                  : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              Closed Positions ({closedPositions.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("LEVERAGE")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                activeTab === "LEVERAGE"
                  ? "bg-black text-white"
                  : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              Leverage Progression ({userMaxLeverage}x / 10x)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("GUIDE")}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                activeTab === "GUIDE"
                  ? "bg-emerald-800 text-white"
                  : "bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
              }`}
            >
              Beginner&apos;s Trading Guide
            </button>
          </div>

          {/* TAB 1: OPEN POSITIONS WITH INDIVIDUAL CLOSE BUTTONS */}
          {activeTab === "OPEN" && (
            <div className="mt-4 space-y-3">
              {openPositions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
                  You have no open hedge positions. Use <strong>BUY (Long)</strong> or{" "}
                  <strong>SELL (Short)</strong> on the left to open an independent position.
                </div>
              ) : (
                <div className="space-y-3">
                  {openPositions.map((pos) => (
                    <div
                      key={pos.id}
                      className="rounded-xl border border-border bg-surface/60 p-3.5 transition-all hover:border-black/30"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-bold">
                            {pos.positionNumber}
                          </span>
                          <span
                            className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                              pos.direction === "LONG"
                                ? "bg-[#eaf7ee] text-[#146c2e]"
                                : "bg-[#fdecea] text-[#b3261e]"
                            }`}
                          >
                            {pos.direction === "LONG" ? "BUY · LONG" : "SELL · SHORT"}
                          </span>
                          <span className="rounded bg-black px-1.5 py-0.5 font-mono text-[11px] font-bold text-white">
                            {pos.leverage}x
                          </span>
                          <span className="text-xs font-semibold">
                            {pos.quantity.toLocaleString("en-IN")} units
                          </span>
                        </div>

                        <V5ActionForm
                          action={closeHedgePositionAction}
                          operationKey={`close-pos-${pos.id}`}
                          operationTitle={`Closing ${pos.positionNumber} (${pos.direction})`}
                          processingDetail="Settling position P&L and releasing margin..."
                          className="inline-block"
                        >
                          {(pending) => (
                            <>
                              <input type="hidden" name="positionId" value={pos.id} />
                              <input
                                type="hidden"
                                name="expectedPrice"
                                value={String(currentPrice)}
                              />
                              <input type="hidden" name="maxSlippageBp" value="500" />
                              <input
                                type="hidden"
                                name="idempotencyKey"
                                value={`close-${pos.id}-${currentPrice}`}
                              />
                              <button
                                type="submit"
                                disabled={pending || !tradingEnabled}
                                className="btn btn-primary px-3 py-1 text-xs"
                              >
                                {pending ? "Closing..." : "Close Position"}
                              </button>
                            </>
                          )}
                        </V5ActionForm>
                      </div>

                      <div className="mt-2.5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                        <div>
                          <span className="text-[11px] text-muted">Entry Price</span>
                          <p className="font-mono font-semibold">
                            {pos.entryPrice.toLocaleString("en-IN")} A
                          </p>
                        </div>
                        <div>
                          <span className="text-[11px] text-muted">Current Price</span>
                          <p className="font-mono font-semibold">
                            {currentPrice.toLocaleString("en-IN")} A
                          </p>
                        </div>
                        <div>
                          <span className="text-[11px] text-muted">Margin Locked</span>
                          <p className="font-mono font-semibold">
                            {pos.marginLocked.toLocaleString("en-IN")} A
                          </p>
                        </div>
                        <div>
                          <span className="text-[11px] text-muted">Liq. Price</span>
                          <p className="font-mono font-semibold text-amber-800">
                            {pos.liquidationPrice.toLocaleString("en-IN")} A
                          </p>
                        </div>
                        <div>
                          <span className="text-[11px] text-muted">Unrealized P&amp;L</span>
                          <p
                            className={`font-mono font-bold ${
                              pos.unrealizedPnl >= 0 ? "text-[#146c2e]" : "text-[#b3261e]"
                            }`}
                          >
                            {pos.unrealizedPnl >= 0 ? "+" : ""}
                            {pos.unrealizedPnl.toLocaleString("en-IN")} A
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: CLOSED POSITIONS HISTORY */}
          {activeTab === "HISTORY" && (
            <div className="mt-4 space-y-2.5">
              {closedPositions.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">
                  No closed hedge positions yet.
                </p>
              ) : (
                closedPositions.map((pos) => (
                  <div
                    key={pos.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold">{pos.positionNumber}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            pos.direction === "LONG"
                              ? "bg-[#eaf7ee] text-[#146c2e]"
                              : "bg-[#fdecea] text-[#b3261e]"
                          }`}
                        >
                          {pos.direction} {pos.leverage}x
                        </span>
                        <span className="font-medium">
                          {pos.quantity} units · Entry {pos.entryPrice} A → Exit{" "}
                          {pos.closePrice ?? currentPrice} A
                        </span>
                        <span className="badge bg-surface text-[10px]">{pos.status}</span>
                      </div>
                    </div>
                    <div
                      className={`font-mono font-bold ${
                        (pos.realizedPnl ?? 0) >= 0 ? "text-[#146c2e]" : "text-[#b3261e]"
                      }`}
                    >
                      {(pos.realizedPnl ?? 0) >= 0 ? "+" : ""}
                      {(pos.realizedPnl ?? 0).toLocaleString("en-IN")} A
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* TAB 3: LEVERAGE PROGRESSION (2x -> 4x -> 8x -> 10x) */}
          {activeTab === "LEVERAGE" && (
            <div className="mt-4 space-y-4">
              <div className="rounded-lg border border-border bg-surface p-3.5 text-xs">
                <p className="font-semibold">
                  Structured Leverage Progression: 2x → 4x → 8x → 10x (Max 10x)
                </p>
                <p className="mt-1 text-muted">
                  Your current approved maximum leverage is{" "}
                  <strong className="text-foreground">{userMaxLeverage}x</strong>. Leverage tiers
                  are unlocked sequentially upon Government review.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  {[1, 2, 4, 8, 10].map((tier) => (
                    <div
                      key={tier}
                      className={`flex-1 rounded-md border py-2 text-center font-mono text-xs font-bold ${
                        tier <= userMaxLeverage
                          ? "border-emerald-600 bg-[#eaf7ee] text-[#146c2e]"
                          : "border-border bg-white text-muted"
                      }`}
                    >
                      {tier}x {tier <= userMaxLeverage ? "✓" : "🔒"}
                    </div>
                  ))}
                </div>
              </div>

              {nextLeverageStep ? (
                <V5ActionForm
                  action={requestLeverageUpgradeAction}
                  operationKey="request-leverage-upgrade"
                  operationTitle={`Requesting ${nextLeverageStep}x Leverage Approval`}
                  onSuccessReset
                >
                  {(pending) => (
                    <div className="space-y-3 rounded-lg border border-border p-3.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">
                        Request Next Tier: {userMaxLeverage}x → {nextLeverageStep}x
                      </h4>
                      <input
                        type="hidden"
                        name="requestedLeverage"
                        value={String(nextLeverageStep)}
                      />
                      <div>
                        <label className="text-xs font-medium">
                          Reason / Risk Management Justification
                        </label>
                        <textarea
                          name="reason"
                          rows={2}
                          required
                          minLength={5}
                          placeholder={`Explain why you are requesting ${nextLeverageStep}x leverage...`}
                          className="input mt-1 text-xs"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={pending}
                        className="btn btn-primary text-xs"
                      >
                        {pending
                          ? "Submitting Request..."
                          : `Request ${nextLeverageStep}x Leverage Approval`}
                      </button>
                    </div>
                  )}
                </V5ActionForm>
              ) : (
                <div className="rounded-lg bg-[#eaf7ee] p-3 text-xs font-medium text-[#146c2e]">
                  You have unlocked the maximum 10x leverage tier permitted in Aeros Pay.
                </div>
              )}

              {leverageRequests.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Your Leverage Requests
                  </h4>
                  {leverageRequests.map((req) => (
                    <div
                      key={req.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5 text-xs"
                    >
                      <div>
                        <span className="font-mono font-semibold">{req.requestNumber}</span> ·{" "}
                        <span>
                          {req.currentLeverage}x → <strong>{req.requestedLeverage}x</strong>
                        </span>
                        <p className="text-muted">{req.reason}</p>
                        {req.reviewNote && (
                          <p className="text-[11px] font-medium text-foreground">
                            Gov Note: {req.reviewNote}
                          </p>
                        )}
                      </div>
                      <span
                        className={`badge ${
                          req.status === "APPROVED"
                            ? "badge-active"
                            : req.status === "REJECTED"
                              ? "badge-banned"
                              : "badge-suspended"
                        }`}
                      >
                        {req.status}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: BEGINNER'S TRADING GUIDE (Spec Section 11) */}
          {activeTab === "GUIDE" && (
            <div className="mt-4 space-y-3 text-xs leading-relaxed">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3.5">
                <h4 className="text-sm font-bold text-emerald-950">
                  Beginner&apos;s Guide to the Aeros Market Index (AMI)
                </h4>
                <p className="mt-1 text-emerald-900">
                  The Aeros Market Index (AMI) is a sovereign whole-number synthetic index inside
                  Aeros Pay. Every trade settles in whole Aeros against the Government Treasury
                  reserve, preserving the total circulating monetary supply at all times.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-3">
                  <p className="font-bold text-[#146c2e]">1. BUY (Long Position)</p>
                  <p className="mt-1 text-muted">
                    Opening a <strong>BUY</strong> position creates an independent{" "}
                    <strong>LONG</strong> trade. You profit when the Market Index rises above your
                    entry price: <code className="font-mono">P&amp;L = (Current - Entry) × Qty</code>.
                  </p>
                </div>

                <div className="rounded-lg border border-border p-3">
                  <p className="font-bold text-[#b3261e]">2. SELL (Short Position)</p>
                  <p className="mt-1 text-muted">
                    Opening a <strong>SELL</strong> position creates an independent{" "}
                    <strong>SHORT</strong> trade. You profit when the Market Index falls below your
                    entry price: <code className="font-mono">P&amp;L = (Entry - Current) × Qty</code>.
                  </p>
                </div>

                <div className="rounded-lg border border-border p-3">
                  <p className="font-bold">3. Independent Hedge Positions</p>
                  <p className="mt-1 text-muted">
                    Unlike basic spot accounts where buying cancels a short, Aeros Pay uses{" "}
                    <strong>hedge-style position accounting</strong>. You can hold multiple BUY and
                    SELL positions simultaneously without one cancelling the other.
                  </p>
                </div>

                <div className="rounded-lg border border-border p-3">
                  <p className="font-bold">4. Entry vs. Current Price &amp; P&amp;L</p>
                  <p className="mt-1 text-muted">
                    <strong>Entry Price</strong> is locked when you open a position.{" "}
                    <strong>Unrealized P&amp;L</strong> fluctuates live with the current index
                    price. Clicking <strong>Close Position</strong> locks in your{" "}
                    <strong>Realized P&amp;L</strong> and returns your margin +/- P&amp;L.
                  </p>
                </div>

                <div className="rounded-lg border border-border p-3">
                  <p className="font-bold">5. Leverage (2x → 4x → 8x → 10x)</p>
                  <p className="mt-1 text-muted">
                    Leverage lets you open a larger notional position with less upfront margin (
                    <code className="font-mono">Margin = ceil(Notional / Leverage)</code>). Higher
                    leverage amplifies both gains and losses relative to your locked margin and
                    brings the liquidation price closer to your entry price.
                  </p>
                </div>

                <div className="rounded-lg border border-border p-3">
                  <p className="font-bold">6. Market Clock vs. Candle Timeframes</p>
                  <p className="mt-1 text-muted">
                    The Government sets the market update clock (<strong>1m</strong> or{" "}
                    <strong>5m</strong>). Chart timeframe buttons (<strong>5m, 15m, 1h</strong>)
                    control how each candlestick bar aggregates Open, High, Low, and Close prices.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
