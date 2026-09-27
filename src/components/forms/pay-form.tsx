"use client";

import { useActionState, useState } from "react";
import { payAction } from "@/actions/user";
import { CURRENCY_NAME, MIN_TRANSACTION_AMOUNT } from "@/lib/constants";

type Step = "form" | "confirm";

/**
 * Pay screen. Keeps V1's two-step form → confirm → receipt flow and its
 * visual language; V2 only adds the wallet context line and the ability to
 * pay a company or the Government.
 */
export function PayForm({
  walletLabel,
  walletHandle,
  balance,
  personalTaxPercent,
  companyTaxPercent,
  isCompanyContext,
  prefillRecipient,
}: {
  walletLabel: string;
  walletHandle: string;
  balance: number;
  personalTaxPercent: number;
  companyTaxPercent: number;
  isCompanyContext: boolean;
  prefillRecipient?: string;
}) {
  const [step, setStep] = useState<Step>("form");
  const [recipient, setRecipient] = useState(prefillRecipient ?? "");
  const [amount, setAmount] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [toGovernment, setToGovernment] = useState(false);
  const [state, formAction, pending] = useActionState(payAction, null);

  const parsedAmount = typeof amount === "number" ? amount : 0;

  // Estimate only — the server recomputes the real figure and its rate.
  const estimatedRate = toGovernment
    ? 0
    : isCompanyContext
      ? companyTaxPercent
      : personalTaxPercent;
  const estimatedTax =
    parsedAmount <= 1 ? 0 : Math.floor((parsedAmount * estimatedRate * 100) / 10000);
  const estimatedNet = parsedAmount - estimatedTax;

  if (state?.ok) {
    return (
      <div className="card p-6 text-center">
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
        <button
          className="btn btn-primary mt-6"
          onClick={() => {
            setStep("form");
            setRecipient("");
            setAmount("");
            setNote("");
            setToGovernment(false);
          }}
        >
          Send another payment
        </button>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <form action={formAction} className="card space-y-4 p-6">
        <input type="hidden" name="recipientUsername" value={recipient} />
        <input type="hidden" name="amount" value={parsedAmount} />
        <input type="hidden" name="note" value={note} />
        <input type="hidden" name="toGovernment" value={toGovernment ? "1" : "0"} />

        <p className="text-sm text-muted">Confirm payment</p>
        <p className="text-lg font-medium">
          Send {parsedAmount.toLocaleString()} {CURRENCY_NAME} to{" "}
          {toGovernment ? "the Government" : `@${recipient}`}?
        </p>
        <p className="text-sm text-muted">Paying from {walletLabel} ({walletHandle})</p>

        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Amount</dt>
            <dd>
              {parsedAmount.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Estimated tax</dt>
            <dd>
              {estimatedTax.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div className="flex justify-between font-medium">
            <dt>Receiver receives</dt>
            <dd>
              {estimatedNet.toLocaleString()} {CURRENCY_NAME}
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
            onClick={() => setStep("form")}
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

  const canContinue =
    (toGovernment || recipient.length > 0) &&
    parsedAmount >= MIN_TRANSACTION_AMOUNT &&
    parsedAmount <= balance;

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

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setToGovernment(false)}
          className={toGovernment ? "btn btn-secondary flex-1" : "btn btn-primary flex-1"}
        >
          A person or company
        </button>
        <button
          type="button"
          onClick={() => setToGovernment(true)}
          className={toGovernment ? "btn btn-primary flex-1" : "btn btn-secondary flex-1"}
        >
          The Government
        </button>
      </div>

      {!toGovernment && (
        <div>
          <label htmlFor="recipientUsername" className="mb-1 block text-sm font-medium">
            Recipient username
          </label>
          <input
            id="recipientUsername"
            className="input"
            placeholder="e.g. piyush or ayushfitness"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value.trim().toLowerCase().replace(/^@/, ""))}
          />
          <p className="mt-1 text-xs text-muted">
            Works for both people and companies — they share one set of usernames.
          </p>
        </div>
      )}

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

      {parsedAmount > 0 && (
        <p className="text-xs text-muted">
          {toGovernment
            ? "Payments to the Government are tax-free."
            : `Estimated tax: ${estimatedTax.toLocaleString()} ${CURRENCY_NAME} · Receiver gets ${estimatedNet.toLocaleString()} ${CURRENCY_NAME}`}
        </p>
      )}
      {parsedAmount > balance && (
        <p className="text-xs text-danger">That is more than this wallet holds.</p>
      )}

      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={!canContinue}
        onClick={() => setStep("confirm")}
      >
        Continue
      </button>
    </div>
  );
}
