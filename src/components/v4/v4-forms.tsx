"use client";

import { useActionState, useState } from "react";
import {
  cancelMyExchangePurchaseAction,
  clearArchiveBatchAction,
  createArchiveBatchAction,
  createRefundRequestAction,
  govDecideRefundAction,
  requestExchangePurchaseAction,
  reviewExchangePurchaseAction,
  syncMarketClockAction,
  updateMarketConfigAction,
  updateV4FeatureTogglesAction,
  updateV4RetentionSettingsAction,
  upsertExchangePolicyAction,
  verifyArchiveBatchAction,
} from "@/actions/v4";
import {
  ARCHIVE_CLEAR_CONFIRM_PHRASE,
  CURRENCY_NAME,
  DEFAULT_EXCHANGE_DISCLOSURE,
} from "@/lib/constants";

// ---------------------------------------------------------------------------
// 1. User Exchange Purchase Form & Cancel Button
// ---------------------------------------------------------------------------

export function ExchangePurchaseForm({
  policy,
  disabled,
}: {
  policy: {
    id: string;
    policyCode: string;
    version: number;
    title: string;
    description: string | null;
    inrPrice: number;
    aerosAmount: number;
    bonusAeros: number;
    totalAeros: number;
    disclosureText: string;
  };
  disabled?: boolean;
}) {
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `ex-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [state, action, pending] = useActionState(requestExchangePurchaseAction, null);

  return (
    <form action={action} className="space-y-3 border-t border-border pt-3">
      <input type="hidden" name="policyId" value={policy.id} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div>
        <label className="label text-xs">
          Manual payment / receipt reference (optional, for Government verification)
        </label>
        <input
          name="paymentReference"
          type="text"
          maxLength={120}
          placeholder="e.g. Receipt # / manual approval note"
          disabled={disabled || pending}
          className="input text-xs"
        />
      </div>

      <label className="flex items-start gap-2 text-xs text-muted">
        <input
          type="checkbox"
          name="acknowledgedDisclosure"
          value="true"
          required
          disabled={disabled || pending}
          className="mt-0.5"
        />
        <span>{policy.disclosureText}</span>
      </label>

      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="text-xs text-success">
          Request {state.data.purchaseNumber} submitted for Government verification. No {CURRENCY_NAME}{" "}
          are credited until confirmed by the Government.
        </p>
      )}

      <button
        type="submit"
        disabled={disabled || pending}
        className="btn btn-primary w-full text-sm"
      >
        {pending
          ? "Submitting request…"
          : `Request ${policy.totalAeros.toLocaleString()} ${CURRENCY_NAME} (₹${policy.inrPrice.toLocaleString()} Manual Confirmation)`}
      </button>
    </form>
  );
}

export function CancelExchangePurchaseButton({ purchaseId }: { purchaseId: string }) {
  const [state, action, pending] = useActionState(cancelMyExchangePurchaseAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="purchaseId" value={purchaseId} />
      <button type="submit" disabled={pending} className="btn btn-secondary text-xs">
        {pending ? "Cancelling…" : "Cancel request"}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// 2. User Refund Request Form
// ---------------------------------------------------------------------------

export function CreateRefundRequestForm({
  creditedPurchases,
  disabled,
}: {
  creditedPurchases: Array<{
    id: string;
    purchaseNumber: string;
    packageTitleSnapshot: string;
    totalAerosSnapshot: number;
    inrPriceSnapshot: number;
  }>;
  disabled?: boolean;
}) {
  const [refundType, setRefundType] = useState<
    "VIRTUAL_AEROS_REFUND" | "EXCHANGE_PACKAGE_REFUND"
  >("VIRTUAL_AEROS_REFUND");
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `rfd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );
  const [state, action, pending] = useActionState(createRefundRequestAction, null);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <div>
        <label className="label">Refund category</label>
        <select
          name="refundType"
          value={refundType}
          onChange={(e) =>
            setRefundType(
              e.target.value as "VIRTUAL_AEROS_REFUND" | "EXCHANGE_PACKAGE_REFUND",
            )
          }
          disabled={disabled || pending}
          className="input"
        >
          <option value="VIRTUAL_AEROS_REFUND">
            Virtual {CURRENCY_NAME} Adjustment / Transaction Dispute
          </option>
          <option value="EXCHANGE_PACKAGE_REFUND">
            Aeros Exchange Package Refund (Reclaims {CURRENCY_NAME} + Manual INR Review)
          </option>
        </select>
      </div>

      {refundType === "EXCHANGE_PACKAGE_REFUND" ? (
        <div>
          <label className="label">Select credited Exchange acquisition</label>
          <select
            name="exchangePurchaseId"
            required
            disabled={disabled || pending}
            className="input"
          >
            <option value="">— Select an Exchange acquisition —</option>
            {creditedPurchases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.purchaseNumber} · {p.packageTitleSnapshot} ({p.totalAerosSnapshot.toLocaleString()}{" "}
                {CURRENCY_NAME} / ₹{p.inrPriceSnapshot.toLocaleString()})
              </option>
            ))}
          </select>
          <input type="hidden" name="requestedAerosAmount" value="1" />
          <p className="mt-1 text-xs text-muted">
            Note: Completing an Exchange package refund reclaims the package&apos;s{" "}
            {CURRENCY_NAME} from your wallet to the Treasury. Any external INR settlement is
            handled manually outside the app and is never automatic.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Requested {CURRENCY_NAME} amount</label>
            <input
              name="requestedAerosAmount"
              type="number"
              min={1}
              step={1}
              required
              disabled={disabled || pending}
              placeholder="e.g. 250"
              className="input font-mono"
            />
          </div>
          <div>
            <label className="label">Related Transaction Reference (optional)</label>
            <input
              name="sourceTxRef"
              type="text"
              maxLength={32}
              disabled={disabled || pending}
              placeholder="TX-20261010-000001"
              className="input font-mono"
            />
          </div>
        </div>
      )}

      <div>
        <label className="label">Reason for refund request</label>
        <textarea
          name="reason"
          rows={3}
          required
          minLength={5}
          maxLength={1000}
          disabled={disabled || pending}
          placeholder="Explain why you are requesting this refund…"
          className="input"
        />
      </div>

      <div>
        <label className="label">Additional notes / supporting details (optional)</label>
        <input
          name="userNotes"
          type="text"
          maxLength={1000}
          disabled={disabled || pending}
          placeholder="Any additional context for the Government reviewer"
          className="input"
        />
      </div>

      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="text-xs text-success">
          Refund request {state.data.refundNumber} submitted. You can track its status below.
        </p>
      )}

      <button type="submit" disabled={disabled || pending} className="btn btn-primary">
        {pending ? "Submitting…" : "Submit refund request"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 3. Government V4 Feature Controls Form
// ---------------------------------------------------------------------------

export function GovV4FeatureTogglesForm({
  toggles,
}: {
  toggles: {
    exchangeEnabled: boolean;
    exchangeLivePaymentsEnabled: boolean;
    marketEnabled: boolean;
    tradingEnabled: boolean;
    refundCenterEnabled: boolean;
    retentionEnabled: boolean;
    archiveCenterEnabled: boolean;
  };
}) {
  const [state, action, pending] = useActionState(updateV4FeatureTogglesAction, null);

  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="flex items-center justify-between gap-3 rounded border border-border p-3">
        <div>
          <p className="font-medium">Aeros Exchange</p>
          <p className="text-xs text-muted">
            Allows users to view Government INR package policies and submit manual-confirmation
            acquisition requests.
          </p>
        </div>
        <input
          type="checkbox"
          name="exchangeEnabled"
          value="true"
          defaultChecked={toggles.exchangeEnabled}
        />
      </label>

      <label className="flex items-center justify-between gap-3 rounded border border-border p-3">
        <div>
          <p className="font-medium">Aeros Market (Synthetic Index Chart)</p>
          <p className="text-xs text-muted">
            Enables the internal deterministic synthetic market chart (5m / 15m / 1h candles).
          </p>
        </div>
        <input
          type="checkbox"
          name="marketEnabled"
          value="true"
          defaultChecked={toggles.marketEnabled}
        />
      </label>

      <label className="flex items-center justify-between gap-3 rounded border border-border p-3">
        <div>
          <p className="font-medium">Aeros Market Trading (BUY / SELL)</p>
          <p className="text-xs text-muted">
            Allows eligible users to buy and sell AMI units against the Government Treasury.
            Requires Aeros Market to be enabled.
          </p>
        </div>
        <input
          type="checkbox"
          name="tradingEnabled"
          value="true"
          defaultChecked={toggles.tradingEnabled}
        />
      </label>

      <label className="flex items-center justify-between gap-3 rounded border border-border p-3">
        <div>
          <p className="font-medium">Refund Center</p>
          <p className="text-xs text-muted">
            Allows users to submit refund requests and view Government decisions.
          </p>
        </div>
        <input
          type="checkbox"
          name="refundCenterEnabled"
          value="true"
          defaultChecked={toggles.refundCenterEnabled}
        />
      </label>

      <label className="flex items-center justify-between gap-3 rounded border border-border p-3">
        <div>
          <p className="font-medium">Data Retention Engine</p>
          <p className="text-xs text-muted">
            Master toggle for scheduled and manual temporary-data cleanup and text scrubbing.
          </p>
        </div>
        <input
          type="checkbox"
          name="retentionEnabled"
          value="true"
          defaultChecked={toggles.retentionEnabled}
        />
      </label>

      <label className="flex items-center justify-between gap-3 rounded border border-border p-3">
        <div>
          <p className="font-medium">Archive Center (ZIP Export &amp; Safe Clearing)</p>
          <p className="text-xs text-muted">
            Enables verified `.zip` archive generation and Archive-Before-Clearing with immutable
            accounting checkpoints.
          </p>
        </div>
        <input
          type="checkbox"
          name="archiveCenterEnabled"
          value="true"
          defaultChecked={toggles.archiveCenterEnabled}
        />
      </label>

      <input type="hidden" name="exchangeLivePaymentsEnabled" value="false" />

      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="text-xs text-success">V4 feature controls updated and audited.</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Saving…" : "Save V4 feature controls"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 4. Government Exchange Policy & Review Forms
// ---------------------------------------------------------------------------

export function GovExchangePolicyForm() {
  const [state, action, pending] = useActionState(upsertExchangePolicyAction, null);

  return (
    <form action={action} className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Policy Code (creates new version if existing)</label>
          <input
            name="policyCode"
            type="text"
            required
            placeholder="PKG-STARTER"
            className="input font-mono uppercase"
          />
        </div>
        <div>
          <label className="label">Package Title</label>
          <input
            name="title"
            type="text"
            required
            placeholder="Starter Aeros Pack"
            className="input"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label">INR Reference Price (₹)</label>
          <input
            name="inrPrice"
            type="number"
            min={1}
            step={1}
            required
            placeholder="99"
            className="input font-mono"
          />
        </div>
        <div>
          <label className="label">Base {CURRENCY_NAME}</label>
          <input
            name="aerosAmount"
            type="number"
            min={1}
            step={1}
            required
            placeholder="500"
            className="input font-mono"
          />
        </div>
        <div>
          <label className="label">Bonus {CURRENCY_NAME}</label>
          <input
            name="bonusAeros"
            type="number"
            min={0}
            step={1}
            defaultValue={0}
            className="input font-mono"
          />
        </div>
      </div>

      <div>
        <label className="label">Description (optional)</label>
        <input
          name="description"
          type="text"
          maxLength={500}
          placeholder="Short description of this package"
          className="input"
        />
      </div>

      <div>
        <label className="label">Mandatory Private Economy Disclosure Text</label>
        <textarea
          name="disclosureText"
          rows={2}
          required
          defaultValue={DEFAULT_EXCHANGE_DISCLOSURE}
          className="input text-xs"
        />
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" name="active" value="true" defaultChecked />
        <span>Set this policy version active immediately</span>
      </label>

      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="text-xs text-success">
          Package policy version saved. Previous active version (if any) was superseded.
        </p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Saving policy…" : "Publish package policy version"}
      </button>
    </form>
  );
}

export function GovReviewExchangePurchaseForm({ purchaseId }: { purchaseId: string }) {
  const [state, action, pending] = useActionState(reviewExchangePurchaseAction, null);

  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="purchaseId" value={purchaseId} />
      <input
        name="reviewNote"
        type="text"
        maxLength={500}
        placeholder="Verification / receipt note"
        className="input max-w-xs text-xs"
      />
      <button
        type="submit"
        name="decision"
        value="CREDITED"
        disabled={pending}
        className="btn btn-primary text-xs"
      >
        Confirm &amp; Credit {CURRENCY_NAME}
      </button>
      <button
        type="submit"
        name="decision"
        value="CANCELLED"
        disabled={pending}
        className="btn btn-secondary text-xs"
      >
        Cancel Request
      </button>
      {state && !state.ok && <p className="w-full text-xs text-danger">{state.error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// 5. Government Market Configuration Form
// ---------------------------------------------------------------------------

export function GovMarketConfigForm({
  config,
}: {
  config: {
    minPrice: number;
    maxPrice: number;
    baseVolatilityBp: number;
    demandSensitivityBp: number;
    maxStepChangeBp: number;
    maxOrderUnits: number;
    userCooldownSeconds: number;
  };
}) {
  const [state, action, pending] = useActionState(updateMarketConfigAction, null);
  const [syncState, syncAction, syncPending] = useActionState(syncMarketClockAction, null);

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Minimum Price ({CURRENCY_NAME})</label>
            <input
              name="minPrice"
              type="number"
              min={1}
              defaultValue={config.minPrice}
              required
              className="input font-mono"
            />
          </div>
          <div>
            <label className="label">Maximum Price ({CURRENCY_NAME})</label>
            <input
              name="maxPrice"
              type="number"
              min={2}
              defaultValue={config.maxPrice}
              required
              className="input font-mono"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label">Base Volatility (bp, 150 = 1.5%)</label>
            <input
              name="baseVolatilityBp"
              type="number"
              min={10}
              max={2500}
              defaultValue={config.baseVolatilityBp}
              required
              className="input font-mono"
            />
          </div>
          <div>
            <label className="label">Demand Sensitivity (bp)</label>
            <input
              name="demandSensitivityBp"
              type="number"
              min={0}
              max={1000}
              defaultValue={config.demandSensitivityBp}
              required
              className="input font-mono"
            />
          </div>
          <div>
            <label className="label">Max Step Cap (bp, 500 = 5%)</label>
            <input
              name="maxStepChangeBp"
              type="number"
              min={25}
              max={3000}
              defaultValue={config.maxStepChangeBp}
              required
              className="input font-mono"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Max Units Per Order</label>
            <input
              name="maxOrderUnits"
              type="number"
              min={1}
              max={100000}
              defaultValue={config.maxOrderUnits}
              required
              className="input font-mono"
            />
          </div>
          <div>
            <label className="label">User Cooldown (seconds)</label>
            <input
              name="userCooldownSeconds"
              type="number"
              min={0}
              max={3600}
              defaultValue={config.userCooldownSeconds}
              required
              className="input font-mono"
            />
          </div>
        </div>

        {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
        {state && state.ok && (
          <p className="text-xs text-success">Synthetic market parameters updated.</p>
        )}

        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Saving…" : "Save market parameters"}
        </button>
      </form>

      <form action={syncAction} className="border-t border-border pt-3">
        <button type="submit" disabled={syncPending} className="btn btn-secondary text-xs">
          {syncPending ? "Synchronizing buckets…" : "Synchronize 5m/15m/1h market buckets to now"}
        </button>
        {syncState && !syncState.ok && (
          <p className="mt-1 text-xs text-danger">{syncState.error}</p>
        )}
        {syncState && syncState.ok && (
          <p className="mt-1 text-xs text-success">Market buckets synchronized.</p>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. Government Refund Decision Form
// ---------------------------------------------------------------------------

export function GovRefundDecisionForm({
  refund,
}: {
  refund: {
    id: string;
    refundNumber: string;
    refundType: "VIRTUAL_AEROS_REFUND" | "EXCHANGE_PACKAGE_REFUND";
    requestedAerosAmount: number;
    approvedAerosAmount: number | null;
    status: string;
    settlementTxRef: string | null;
  };
}) {
  const [state, action, pending] = useActionState(govDecideRefundAction, null);

  return (
    <form action={action} className="mt-3 space-y-3 border-t border-border pt-3 text-xs">
      <input type="hidden" name="refundId" value={refund.id} />

      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label className="label text-xs">Next Status</label>
          <select name="nextStatus" defaultValue="UNDER_REVIEW" className="input text-xs">
            <option value="UNDER_REVIEW">UNDER_REVIEW</option>
            <option value="DELAYED">DELAYED</option>
            <option value="APPROVED">APPROVED</option>
            <option value="PROCESSING">PROCESSING</option>
            <option value="COMPLETED">COMPLETED</option>
            <option value="REJECTED">REJECTED</option>
          </select>
        </div>
        <div>
          <label className="label text-xs">Approved {CURRENCY_NAME} Amount</label>
          <input
            name="approvedAerosAmount"
            type="number"
            min={0}
            step={1}
            defaultValue={refund.approvedAerosAmount ?? refund.requestedAerosAmount}
            className="input font-mono text-xs"
          />
        </div>
        <div>
          <label className="label text-xs">Expected Resolution Date (if delayed)</label>
          <input name="expectedResolutionDate" type="date" className="input text-xs" />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label className="label text-xs">Government Decision / Status Note (required)</label>
          <input
            name="governmentDecisionNote"
            type="text"
            required
            maxLength={1000}
            placeholder="Reason or decision details shown to user"
            className="input text-xs"
          />
        </div>
        <div>
          <label className="label text-xs">Delay Reason (optional)</label>
          <input
            name="delayReason"
            type="text"
            maxLength={500}
            placeholder="If marking DELAYED, explain why"
            className="input text-xs"
          />
        </div>
      </div>

      {!refund.settlementTxRef && (
        <label className="flex items-center gap-2">
          <input type="checkbox" name="executeAerosTransfer" value="true" />
          <span>
            {refund.refundType === "VIRTUAL_AEROS_REFUND"
              ? `Execute virtual ${CURRENCY_NAME} credit from Government Treasury to user wallet (on APPROVED / COMPLETED)`
              : `Reclaim credited package ${CURRENCY_NAME} from user wallet to Treasury & mark Exchange purchase REFUNDED`}
          </span>
        </label>
      )}

      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state && state.ok && <p className="text-xs text-success">Refund decision recorded.</p>}

      <button type="submit" disabled={pending} className="btn btn-primary text-xs">
        {pending ? "Updating…" : "Apply refund decision"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 7. Government V4 Retention Settings & Archive Center Forms
// ---------------------------------------------------------------------------

export function GovV4RetentionSettingsForm({
  settings,
}: {
  settings: {
    transactionHistoryRetentionDays: number | null;
    settledOrderHistoryRetentionDays: number | null;
    closedRefundRetentionDays: number | null;
    marketCandleRetentionDays: number | null;
  };
}) {
  const [state, action, pending] = useActionState(updateV4RetentionSettingsAction, null);

  return (
    <form action={action} className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">
            Operational Transaction History Eligibility (days, blank = never)
          </label>
          <input
            name="transactionHistoryRetentionDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={settings.transactionHistoryRetentionDays ?? ""}
            placeholder="Keep forever"
            className="input font-mono"
          />
          <p className="mt-1 text-xs text-muted">
            Only Category C operational transfers older than this can be packaged and cleared in
            the Archive Center. Balances and reconciliation anchors are never deleted.
          </p>
        </div>
        <div>
          <label className="label">
            Settled Synthetic Market Orders Eligibility (days, blank = never)
          </label>
          <input
            name="settledOrderHistoryRetentionDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={settings.settledOrderHistoryRetentionDays ?? ""}
            placeholder="Keep forever"
            className="input font-mono"
          />
        </div>
        <div>
          <label className="label">
            Completed / Rejected Refund Requests Eligibility (days, blank = never)
          </label>
          <input
            name="closedRefundRetentionDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={settings.closedRefundRetentionDays ?? ""}
            placeholder="Keep forever"
            className="input font-mono"
          />
        </div>
        <div>
          <label className="label">
            Historical Synthetic Market Candles Eligibility (days)
          </label>
          <input
            name="marketCandleRetentionDays"
            type="number"
            min={2}
            max={3650}
            defaultValue={settings.marketCandleRetentionDays ?? 90}
            className="input font-mono"
          />
        </div>
      </div>

      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="text-xs text-success">V4 archive-retention policies saved.</p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Saving…" : "Save V4 archive-retention policies"}
      </button>
    </form>
  );
}

export function CreateArchiveBatchForm() {
  const [state, action, pending] = useActionState(createArchiveBatchAction, null);

  return (
    <form action={action} className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Dataset to Archive into Verified ZIP</label>
          <select name="datasetKey" className="input">
            <option value="transactions_history">
              Operational Transaction History (Category C — Preserves Balances &amp; Checkpoints)
            </option>
            <option value="settled_market_orders">
              Settled Synthetic Market Orders
            </option>
            <option value="closed_refunds">
              Completed / Rejected Refund Requests
            </option>
            <option value="old_market_candles">
              Historical Synthetic Market Candles (&gt;48h old)
            </option>
          </select>
        </div>
        <div>
          <label className="label">Include records older than (days)</label>
          <input
            name="olderThanDays"
            type="number"
            min={0}
            max={3650}
            defaultValue={30}
            required
            className="input font-mono"
          />
        </div>
      </div>

      {state && !state.ok && <p className="text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="text-xs text-success">
          Created archive batch {state.data.batchNumber} ({state.data.recordCount} records).
          Verification token: <span className="font-mono font-semibold">{state.data.verificationToken}</span>.
          Download the ZIP below and verify it before clearing.
        </p>
      )}

      <button type="submit" disabled={pending} className="btn btn-primary">
        {pending ? "Building ZIP archive…" : "Generate verified ZIP archive batch"}
      </button>
    </form>
  );
}

export function VerifyArchiveBatchForm({
  batchId,
  verificationTokenHint,
}: {
  batchId: string;
  verificationTokenHint: string;
}) {
  const [state, action, pending] = useActionState(verifyArchiveBatchAction, null);

  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <input
        name="verificationToken"
        type="text"
        required
        defaultValue={verificationTokenHint}
        placeholder="Verification token (e.g. VRF-…)"
        className="input max-w-[220px] font-mono text-xs"
      />
      <button type="submit" disabled={pending} className="btn btn-secondary text-xs">
        {pending ? "Verifying SHA-256…" : "Verify Archive Integrity"}
      </button>
      {state && !state.ok && <p className="w-full text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="w-full text-xs text-success">
          Archive batch verified. Eligible for safe clearing.
        </p>
      )}
    </form>
  );
}

export function ClearArchiveBatchForm({
  batchId,
  verificationToken,
}: {
  batchId: string;
  verificationToken: string;
}) {
  const [state, action, pending] = useActionState(clearArchiveBatchAction, null);

  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
      <input type="hidden" name="batchId" value={batchId} />
      <input
        name="verificationToken"
        type="text"
        required
        defaultValue={verificationToken}
        placeholder="Verification token"
        className="input max-w-[180px] font-mono text-xs"
      />
      <input
        name="confirmPhrase"
        type="text"
        required
        placeholder={`Type ${ARCHIVE_CLEAR_CONFIRM_PHRASE}`}
        className="input max-w-[220px] font-mono text-xs"
      />
      <button type="submit" disabled={pending} className="btn btn-primary text-xs">
        {pending ? "Clearing & checkpointing…" : "Clear Archived Records Safely"}
      </button>
      {state && !state.ok && <p className="w-full text-xs text-danger">{state.error}</p>}
      {state && state.ok && (
        <p className="w-full text-xs text-success">
          Cleared {state.data.clearedCount} archived records.
          {state.data.checkpointNumber
            ? ` Immutable accounting checkpoint ${state.data.checkpointNumber} recorded.`
            : ""}
        </p>
      )}
    </form>
  );
}
