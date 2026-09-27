import { TAX_FREE_AMOUNT_THRESHOLD } from "./constants";

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
 * Rule (spec section 20): a transaction of exactly 1 Aeros always has 0 tax,
 * regardless of the configured rate. All larger valid amounts use the
 * configured percentage, rounded down to the nearest whole Aeros so the
 * receiver never receives a fractional amount and the sender is never
 * charged more than the configured rate implies.
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

export function formatTaxRateBp(taxRateBp: number): string {
  return `${(taxRateBp / 100).toFixed(2)}%`;
}
