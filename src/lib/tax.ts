import { TAX_FREE_AMOUNT_THRESHOLD } from "./constants";
import type { WalletRef } from "./wallets";

export type TaxBreakdown = {
  grossAmount: number;
  taxAmount: number;
  netAmount: number;
  taxRateBpApplied: number;
};

/**
 * Computes the tax breakdown for a transfer of `grossAmount` Aeros at the
 * given tax rate (in basis points, e.g. 500 = 5.00%).
 *
 * This is the DEDUCT-FROM-GROSS convention used by every direct payment: the
 * sender is debited `grossAmount`, the receiver is credited `netAmount`, and
 * the Government treasury receives `taxAmount`.
 *
 * Rule (spec §20, preserved from V1): a transaction of exactly 1 Aeros always
 * has 0 tax, regardless of the configured rate. All larger valid amounts use
 * the configured percentage, rounded down to the nearest whole Aeros so the
 * receiver never receives a fractional amount and the sender is never charged
 * more than the configured rate implies.
 */
export function computeTax(grossAmount: number, taxRateBp: number): TaxBreakdown {
  if (!Number.isInteger(grossAmount) || grossAmount < 1) {
    throw new Error("grossAmount must be a positive integer");
  }

  if (grossAmount <= TAX_FREE_AMOUNT_THRESHOLD) {
    return {
      grossAmount,
      taxAmount: 0,
      netAmount: grossAmount,
      taxRateBpApplied: 0,
    };
  }

  const taxAmount = Math.floor((grossAmount * taxRateBp) / 10000);
  const netAmount = grossAmount - taxAmount;

  return {
    grossAmount,
    taxAmount,
    netAmount,
    taxRateBpApplied: taxRateBp,
  };
}

export type InvoiceTotals = {
  subtotal: number;
  taxAmount: number;
  /** What the buyer pays. Equal to `subtotal`: the buyer never pays tax on top. */
  total: number;
  /** What the company receives: `total - taxAmount`. */
  netAmount: number;
  taxRateBpApplied: number;
};

/**
 * Tax on an invoice is taken from the COMPANY's proceeds, not added on top.
 *
 * An invoice quotes a price (`subtotal`). The buyer pays exactly that price
 * (`total = subtotal`). The tax is deducted from it: the Government treasury
 * receives `taxAmount`, and the company receives `netAmount = total - tax`.
 * Example: a 500 invoice at 5% -> buyer pays 500, tax 25, company receives 475.
 *
 * (Invoices created BEFORE this rule were "add-on": total = subtotal + tax and
 * the company received the whole subtotal. Those old invoices are still paid
 * exactly as quoted - see payInvoiceInTx in src/lib/invoices.ts.)
 *
 * The resulting ledger row satisfies the system-wide invariant
 * `gross = tax + net`, with gross = total (what the buyer paid) and
 * net = total - tax (what the company received) - so invoices need no special
 * case anywhere in the accounting or reconciliation code.
 */
export function computeInvoiceTotals(subtotal: number, taxRateBp: number): InvoiceTotals {
  if (!Number.isInteger(subtotal) || subtotal < 1) {
    throw new Error("subtotal must be a positive integer");
  }

  const taxAmount = Math.floor((subtotal * taxRateBp) / 10000);

  return {
    subtotal,
    taxAmount,
    total: subtotal,
    netAmount: subtotal - taxAmount,
    taxRateBpApplied: taxAmount > 0 ? taxRateBp : 0,
  };
}

export function formatTaxRateBp(taxRateBp: number): string {
  return `${(taxRateBp / 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Which rate applies to which transfer (spec §22)
//
// V3 NOTE — READ BEFORE CALLING `resolveTaxRateBp` DIRECTLY
// --------------------------------------------------------
// These are still the rules, and they are still the ONLY implementation of
// them; V3 did not fork this function. What changed is who calls it: the live
// decision now goes through `src/lib/taxmatrix.ts`, which first consults the
// Government-configurable tax matrix and falls back to THIS function when the
// matrix has nothing configured for the combination in question (the default,
// since the matrix ships empty).
//
// So: server code that is about to move Aeros calls
// `resolveTaxDecision`/`resolveEffectiveTaxRateBp` in taxmatrix.ts, not this.
// This function stays exported because it is that module's fallback and
// because it is a pure function worth unit-testing on its own.
// ---------------------------------------------------------------------------

/**
 * The rate inputs the V2 rules need. Not to be confused with a V3
 * "transaction context" (DIRECT_TRANSFER, INVOICE_PAYMENT, ...), which is the
 * third axis of the tax matrix and lives in src/lib/taxmatrix.ts as
 * `TaxTransactionContext`.
 */
export type TaxContext = {
  /** Global personal rate from the government row. */
  personalRateBp: number;
  /** Government's default company rate. */
  defaultCompanyRateBp: number;
  /** Per-company override for the sender, when the sender is a company. */
  senderCompanyRateBp?: number | null;
  /** Per-company override for the receiver, when the receiver is a company. */
  receiverCompanyRateBp?: number | null;
};

/**
 * Resolves the tax rate for a transfer between two wallets.
 *
 *   USER       -> USER         personal rate
 *   USER       -> COMPANY      receiving company's rate (it is the seller)
 *   COMPANY    -> USER         sending company's rate (it is the seller/payer)
 *   COMPANY    -> COMPANY      sending company's rate
 *   GOVERNMENT -> anything     tax-free
 *   anything   -> GOVERNMENT   tax-free
 *
 * A company's own rate wins over the Government's default company rate when
 * one has been set for it.
 */
export function resolveTaxRateBp(
  sender: WalletRef,
  receiver: WalletRef,
  ctx: TaxContext,
): number {
  // Government never taxes itself, in either direction.
  if (sender.kind === "GOVERNMENT" || receiver.kind === "GOVERNMENT") return 0;

  if (sender.kind === "COMPANY") {
    return ctx.senderCompanyRateBp ?? ctx.defaultCompanyRateBp;
  }

  if (receiver.kind === "COMPANY") {
    return ctx.receiverCompanyRateBp ?? ctx.defaultCompanyRateBp;
  }

  return ctx.personalRateBp;
}

/** The ledger `type` that best describes a transfer between two wallets. */
export function resolveTransactionType(
  sender: WalletRef,
  receiver: WalletRef,
):
  | "TRANSFER"
  | "COMPANY_SALE"
  | "COMPANY_PAYMENT"
  | "GOVERNMENT_PAYMENT"
  | "GOVERNMENT_RECEIPT" {
  if (sender.kind === "GOVERNMENT") return "GOVERNMENT_PAYMENT";
  if (receiver.kind === "GOVERNMENT") return "GOVERNMENT_RECEIPT";
  if (sender.kind === "COMPANY") return "COMPANY_PAYMENT";
  if (receiver.kind === "COMPANY") return "COMPANY_SALE";
  return "TRANSFER";
}
