import "server-only";
import { db } from "@/db/client";
import { companies, invoices } from "@/db/schema";
import { eq } from "drizzle-orm";
import { companyWallet, sameWallet, type WalletRef } from "./wallets";

/**
 * SETTLEMENT ROUTING (V3) — THE ANTI-TAX-ROUTING GUARANTEE (spec §4)
 * ===========================================================================
 *
 * THE RULE
 * --------
 * When a company is the beneficiary of a payment — an invoice it issued, and
 * from Phase C a marketplace order or contract — the Aeros must land in the
 * COMPANY's wallet. They must never land in the owner's personal wallet,
 * because company money is taxed as company money and routing it to a
 * personal wallet would be a way to pay the personal rate (or no rate) on
 * business income. That is the whole "anti-tax-routing" rule.
 *
 * WHY THIS IS STRUCTURAL AND NOT A VALIDATION
 * -------------------------------------------
 * A validation is a check that some caller remembered to perform. This module
 * instead makes the wrong destination UNREPRESENTABLE, in three layers:
 *
 *  1. NO CALLER EVER NAMES A DESTINATION. `payInvoice` takes an invoice id and
 *     a payer; it has no destination parameter at all, so there is no request
 *     field, form input or argument anywhere in the stack that a destination
 *     could be smuggled through.
 *
 *  2. THE DESTINATION IS DERIVED FROM THE ROW, HERE, AND NOWHERE ELSE. The
 *     only functions that can produce a `SettlementDestination` are in this
 *     module, and both of them build it as `companyWallet(row.id)` from a
 *     company row they read themselves inside the caller's transaction. The
 *     type carries a module-private brand symbol, so no other file — and no
 *     future phase — can construct or fake one, not even by writing an object
 *     literal of the right shape. `ownerUserId` is deliberately carried on the
 *     destination so the code can *name* the owner it must not pay, while
 *     `wallet` remains the company's.
 *
 *  3. `transferInTx` ENFORCES IT UNCONDITIONALLY AT THE MONEY-MOVING LAYER.
 *     Any transfer that carries an `invoiceId` has its destination re-derived
 *     from that invoice's issuer inside the same transaction and compared, and
 *     any transfer that carries a `settlement` has it compared, with a
 *     mismatch throwing `SettlementRoutingError` before a single Aero moves.
 *     So even a future code path that assembles a transfer by hand cannot
 *     route an invoice's settlement to a personal wallet: the lowest layer,
 *     the one that actually writes the balances, refuses.
 *
 * WHAT PHASE C INHERITS
 * ---------------------
 * A marketplace order that settles to a company calls
 * `deriveCompanySettlement` and passes the result as `settlement`. It then has
 * exactly the same guarantee for free, with no new checks to remember: the
 * destination it gets back is the company wallet by construction, and
 * `transferInTx` re-asserts it.
 */

export class SettlementRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementRoutingError";
  }
}

/**
 * Module-private brand. Not exported, so a `SettlementDestination` can only
 * come from a function in this file — an object literal from another module
 * will not type-check, however carefully it is shaped.
 */
declare const SETTLEMENT_BRAND: unique symbol;

export type SettlementDestination = {
  readonly [SETTLEMENT_BRAND]: true;
  /** ALWAYS a COMPANY wallet, built from the company row's own id. */
  readonly wallet: WalletRef;
  readonly companyId: string;
  readonly companyName: string;
  readonly companyUsername: string;
  /**
   * The owner's user id — carried so callers can *describe* the owner (and so
   * tests can prove the owner's personal wallet is not the destination), never
   * so anything can settle to it.
   */
  readonly ownerUserId: string;
  readonly companyStatus: string;
  readonly what: "COMPANY_BENEFICIARY";
};

/** Anything that can run a `select` — `db` or an open transaction. */
type Executor = Pick<typeof db, "select">;

function brand(row: {
  id: string;
  name: string;
  username: string;
  ownerUserId: string;
  status: string;
}): SettlementDestination {
  // The single place a settlement wallet is constructed. `companyWallet(row.id)`
  // is the only expression here, so a company beneficiary's wallet is the
  // company's wallet as a matter of construction rather than of checking.
  const wallet = companyWallet(row.id);
  if (wallet.kind !== "COMPANY" || wallet.id !== row.id) {
    // Unreachable unless `companyWallet` itself is broken; asserted because
    // this one line is what the whole guarantee rests on.
    throw new SettlementRoutingError("Company settlement wallet could not be derived.");
  }
  return {
    wallet,
    companyId: row.id,
    companyName: row.name,
    companyUsername: row.username,
    ownerUserId: row.ownerUserId,
    companyStatus: row.status,
    what: "COMPANY_BENEFICIARY",
  } as SettlementDestination;
}

/**
 * Derives the settlement destination for a company beneficiary.
 *
 * Phase C's marketplace orders and contracts call this; invoices go through
 * `deriveInvoiceSettlement`, which calls it.
 */
export async function deriveCompanySettlement(
  executor: Executor,
  companyId: string,
): Promise<SettlementDestination> {
  const [row] = await executor
    .select({
      id: companies.id,
      name: companies.name,
      username: companies.username,
      ownerUserId: companies.ownerUserId,
      status: companies.status,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!row) throw new SettlementRoutingError("The beneficiary company no longer exists.");
  return brand(row);
}

/**
 * Derives the settlement destination for an invoice, from the invoice row's
 * OWN issuer column. Nothing but `invoices.company_id` decides where an
 * invoice's money goes.
 */
export async function deriveInvoiceSettlement(
  executor: Executor,
  invoiceId: string,
): Promise<SettlementDestination> {
  const [row] = await executor
    .select({ companyId: invoices.companyId })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);

  if (!row) throw new SettlementRoutingError("Invoice not found for settlement.");
  return deriveCompanySettlement(executor, row.companyId);
}

/**
 * Throws unless `wallet` is exactly the derived destination.
 *
 * The error message is deliberately explicit about the personal-wallet case,
 * because that is the failure this whole module exists to make impossible.
 */
export function assertSettlementDestination(
  destination: SettlementDestination,
  wallet: WalletRef,
): void {
  if (sameWallet(destination.wallet, wallet)) return;

  if (wallet.kind === "USER" && wallet.id === destination.ownerUserId) {
    throw new SettlementRoutingError(
      `A company payment must settle to the company wallet @${destination.companyUsername}, not to its owner's personal wallet.`,
    );
  }
  throw new SettlementRoutingError(
    `A company payment must settle to the company wallet @${destination.companyUsername}, not to ${wallet.kind.toLowerCase()} ${wallet.id}.`,
  );
}
