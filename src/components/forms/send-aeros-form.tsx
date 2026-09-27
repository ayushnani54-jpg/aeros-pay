"use client";

import { useActionState, useState } from "react";
import { sendAerosAction } from "@/actions/user";
import { CURRENCY_NAME, MIN_TRANSACTION_AMOUNT } from "@/lib/constants";

type Step = "form" | "confirm" | "done";

export function SendAerosForm({ taxRatePercent }: { taxRatePercent: number }) {
  const [step, setStep] = useState<Step>("form");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [state, formAction, pending] = useActionState(sendAerosAction, null);

  const parsedAmount = typeof amount === "number" ? amount : 0;
  const estimatedTax =
    parsedAmount <= 1 ? 0 : Math.floor((parsedAmount * taxRatePercent * 100) / 10000);
  const estimatedNet = parsedAmount - estimatedTax;

  if (state?.ok) {
    return (
      <div className="card p-6 text-center">
        <p className="text-lg font-semibold text-success">Payment Successful</p>
        <div className="mt-4 space-y-1 text-sm">
          <p>Amount: {state.data.grossAmount.toLocaleString()} {CURRENCY_NAME}</p>
          <p>Receiver: @{state.data.receiverUsername}</p>
          {state.data.taxAmount > 0 && <p>Tax: {state.data.taxAmount.toLocaleString()} {CURRENCY_NAME}</p>}
          <p>Receiver got: {state.data.netAmount.toLocaleString()} {CURRENCY_NAME}</p>
          <p className="font-mono text-xs text-muted">Ref {state.data.txRef}</p>
        </div>
        <button
          className="btn btn-primary mt-6"
          onClick={() => {
            setStep("form");
            setRecipient("");
            setAmount("");
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

        <p className="text-sm text-muted">Confirm payment</p>
        <p className="text-lg font-medium">
          Send {parsedAmount.toLocaleString()} {CURRENCY_NAME} to @{recipient}?
        </p>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Amount</dt>
            <dd>{parsedAmount.toLocaleString()} {CURRENCY_NAME}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Tax</dt>
            <dd>{estimatedTax.toLocaleString()} {CURRENCY_NAME}</dd>
          </div>
          <div className="flex justify-between font-medium">
            <dt>Receiver receives</dt>
            <dd>{estimatedNet.toLocaleString()} {CURRENCY_NAME}</dd>
          </div>
        </dl>

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

  return (
    <div className="card space-y-4 p-6">
      <div>
        <label htmlFor="recipientUsername" className="mb-1 block text-sm font-medium">
          Recipient username
        </label>
        <input
          id="recipientUsername"
          className="input"
          placeholder="e.g. piyush"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value.trim().toLowerCase())}
        />
      </div>
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
          onChange={(e) => setAmount(e.target.value === "" ? "" : Math.floor(Number(e.target.value)))}
        />
      </div>

      {parsedAmount > 0 && (
        <p className="text-xs text-muted">
          Estimated tax: {estimatedTax.toLocaleString()} {CURRENCY_NAME} · Receiver gets{" "}
          {estimatedNet.toLocaleString()} {CURRENCY_NAME}
        </p>
      )}

      <button
        type="button"
        className="btn btn-primary w-full"
        disabled={!recipient || !parsedAmount || parsedAmount < MIN_TRANSACTION_AMOUNT}
        onClick={() => setStep("confirm")}
      >
        Send
      </button>
    </div>
  );
}
