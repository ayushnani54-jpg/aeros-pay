"use client";

import { useActionState, useState, useTransition } from "react";
import {
  payAction,
  quotePaymentAction,
  resolvePayeeAction,
  type PaymentQuote,
} from "@/actions/user";
import type { ResolvedPayee } from "@/lib/payments";
import { CURRENCY_NAME, MIN_TRANSACTION_AMOUNT } from "@/lib/constants";
import { PaymentSuccessSound } from "@/components/payment-sound";

type Step = "find" | "amount" | "confirm";

/**
 * Pay screen (spec §10).
 *
 * The flow is search → confirm identity → amount → server quote → confirm →
 * receipt, and every number after "amount" comes from the server:
 *
 *  - `resolvePayeeAction` decides whether a typed handle is a person, a company
 *    or the Government, and returns only the identity. No balance is ever
 *    exposed, and no wallet id is ever accepted from here.
 *  - `quotePaymentAction` returns amount → tax → what the recipient receives,
 *    computed from the tax matrix for the real resolved pair of wallets.
 *  - `payAction` re-resolves everything again server-side and is the only thing
 *    that can produce a receipt. There is no optimistic success in this file.
 *
 * The layout, the two-step feel and the card/button language are V1's, unchanged.
 */
export function PayForm({
  walletLabel,
  walletHandle,
  balance,
  prefillRecipient,
}: {
  walletLabel: string;
  walletHandle: string;
  balance: number;
  prefillRecipient?: string;
}) {
  const [step, setStep] = useState<Step>("find");
  const [recipient, setRecipient] = useState(prefillRecipient ?? "");
  const [amount, setAmount] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [toGovernment, setToGovernment] = useState(false);

  const [payee, setPayee] = useState<ResolvedPayee | null>(null);
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [busy, startLookup] = useTransition();

  const [state, formAction, pending] = useActionState(payAction, null);

  const parsedAmount = typeof amount === "number" ? amount : 0;

  function reset() {
    setStep("find");
    setRecipient("");
    setAmount("");
    setNote("");
    setToGovernment(false);
    setPayee(null);
    setQuote(null);
    setLookupError(null);
  }

  function findPayee(asGovernment: boolean) {
    setLookupError(null);
    startLookup(async () => {
      const result = await resolvePayeeAction({
        username: asGovernment ? "" : recipient,
        toGovernment: asGovernment,
      });
      if (result.ok) {
        setPayee(result.data);
        setToGovernment(asGovernment);
        setStep("amount");
      } else {
        setPayee(null);
        setLookupError(result.error);
      }
    });
  }

  function getQuote() {
    setLookupError(null);
    startLookup(async () => {
      const result = await quotePaymentAction({
        username: toGovernment ? "" : recipient,
        toGovernment,
        amount: parsedAmount,
      });
      if (result.ok) {
        setQuote(result.data);
        setStep("confirm");
      } else {
        setQuote(null);
        setLookupError(result.error);
      }
    });
  }

  // --- receipt (server-confirmed only) --------------------------------------
  if (state?.ok) {
    return (
      <div className="card p-6 text-center" data-testid="payment-receipt">
        {/* Inside the `state.ok` branch, so the server has already returned a
            receipt: the chime can never sound before, or instead of, a real
            confirmation. Keyed on the transaction ref so a second payment in
            the same session sounds again. */}
        <PaymentSuccessSound key={state.data.txRef} />
        <p className="text-lg font-semibold text-success">Payment Successful</p>
        <div className="mt-4 space-y-1 text-sm">
          <p>
            Amount: {state.data.grossAmount.toLocaleString()} {CURRENCY_NAME}
          </p>
          <p>From: {state.data.senderLabel}</p>
          <p>
            To: {state.data.receiverLabel}
            {state.data.receiverUsername ? ` (@${state.data.receiverUsername})` : ""}
          </p>
          {state.data.taxAmount > 0 && (
            <p>
              Tax: {state.data.taxAmount.toLocaleString()} {CURRENCY_NAME}
            </p>
          )}
          <p>
            Receiver got: {state.data.netAmount.toLocaleString()} {CURRENCY_NAME}
          </p>
          <p className="font-mono text-xs text-muted">Ref {state.data.txRef}</p>
        </div>
        <button className="btn btn-primary mt-6" onClick={reset}>
          Send another payment
        </button>
      </div>
    );
  }

  // --- confirm --------------------------------------------------------------
  if (step === "confirm" && quote) {
    return (
      <form action={formAction} className="card space-y-4 p-6">
        <input type="hidden" name="recipientUsername" value={toGovernment ? "" : recipient} />
        <input type="hidden" name="amount" value={parsedAmount} />
        <input type="hidden" name="note" value={note} />
        <input type="hidden" name="toGovernment" value={toGovernment ? "1" : "0"} />

        <p className="text-sm text-muted">Confirm payment</p>
        <p className="text-lg font-medium">
          Send {quote.grossAmount.toLocaleString()} {CURRENCY_NAME} to {quote.payee.label}
          {quote.payee.kind === "GOVERNMENT" ? "" : ` (@${quote.payee.username})`}?
        </p>
        <p className="text-sm text-muted">
          Paying from {walletLabel} ({walletHandle}) · recipient is a {quote.payee.what}
        </p>

        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Amount</dt>
            <dd>
              {quote.grossAmount.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Tax ({(quote.taxRateBp / 100).toFixed(2)}%)</dt>
            <dd>
              {quote.taxAmount.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div className="flex justify-between border-t border-border pt-1 font-medium">
            <dt>Recipient receives</dt>
            <dd>
              {quote.netAmount.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
        </dl>
        {note && <p className="text-xs text-muted">Note: {note}</p>}

        {state && !state.ok && (
          <p className="text-sm text-danger" role="alert">
            {state.error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            className="btn btn-secondary flex-1"
            onClick={() => setStep("amount")}
            disabled={pending}
          >
            Back
          </button>
          <button type="submit" className="btn btn-primary flex-1" disabled={pending}>
            {pending ? "Sending…" : "Confirm Payment"}
          </button>
        </div>
      </form>
    );
  }

  // --- amount ---------------------------------------------------------------
  if (step === "amount" && payee) {
    return (
      <div className="card space-y-4 p-6">
        <div className="rounded-md bg-surface px-3 py-2 text-sm" data-testid="resolved-payee">
          <span className="text-muted">Paying </span>
          <span className="font-medium">{payee.label}</span>
          {payee.kind !== "GOVERNMENT" && (
            <span className="text-muted"> (@{payee.username})</span>
          )}
          <span className="text-muted"> — this is a {payee.what}.</span>
        </div>

        <button
          type="button"
          className="text-sm text-muted hover:text-foreground"
          onClick={() => {
            setPayee(null);
            setQuote(null);
            setStep("find");
          }}
        >
          Not them? Search again
        </button>

        <div>
          <label htmlFor="amount" className="mb-1 block text-sm font-medium">
            Amount ({CURRENCY_NAME})
          </label>
          <input
            id="amount"
            type="number"
            className="input"
            min={MIN_TRANSACTION_AMOUNT}
            step={1}
            value={amount}
            onChange={(e) =>
              setAmount(e.target.value === "" ? "" : Math.floor(Number(e.target.value)))
            }
          />
        </div>

        <div>
          <label htmlFor="note" className="mb-1 block text-sm font-medium">
            Note (optional)
          </label>
          <input
            id="note"
            className="input"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What is this payment for?"
          />
        </div>

        <p className="text-xs text-muted">
          The tax and the final amount are calculated by the server on the next step.
        </p>
        {parsedAmount > balance && (
          <p className="text-xs text-danger">That is more than this wallet holds.</p>
        )}
        {lookupError && (
          <p className="text-sm text-danger" role="alert">
            {lookupError}
          </p>
        )}

        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy || parsedAmount < MIN_TRANSACTION_AMOUNT || parsedAmount > balance}
          onClick={getQuote}
        >
          {busy ? "Checking…" : "Continue"}
        </button>
      </div>
    );
  }

  // --- find -----------------------------------------------------------------
  return (
    <div className="card space-y-4 p-6">
      <div className="rounded-md bg-surface px-3 py-2 text-sm">
        <span className="text-muted">Paying from </span>
        <span className="font-medium">{walletLabel}</span>
        <span className="text-muted"> ({walletHandle}) · balance </span>
        <span className="font-medium">
          {balance.toLocaleString()} {CURRENCY_NAME}
        </span>
      </div>

      <div>
        <label htmlFor="recipientUsername" className="mb-1 block text-sm font-medium">
          Who are you paying?
        </label>
        <input
          id="recipientUsername"
          className="input"
          placeholder="Search a username, e.g. piyush or flowfitness"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value.trim().toLowerCase().replace(/^@/, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && recipient.length > 0) {
              e.preventDefault();
              findPayee(false);
            }
          }}
        />
        <p className="mt-1 text-xs text-muted">
          People and companies share one set of usernames — the server works out which it is.
        </p>
      </div>

      {lookupError && (
        <p className="text-sm text-danger" role="alert">
          {lookupError}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary flex-1"
          disabled={busy || recipient.length === 0}
          onClick={() => findPayee(false)}
        >
          {busy ? "Searching…" : "Find recipient"}
        </button>
        <button
          type="button"
          className="btn btn-secondary flex-1"
          disabled={busy}
          onClick={() => findPayee(true)}
        >
          Pay the Government
        </button>
      </div>
    </div>
  );
}
