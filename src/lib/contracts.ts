import "server-only";
import { db } from "@/db/client";
import {
  companies,
  government,
  invoices,
  marketplaceContractApplications,
  marketplaceContracts,
  users,
} from "@/db/schema";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  companyWallet,
  governmentWallet,
  sameWallet,
  userWallet,
  type WalletRef,
} from "./wallets";
import { canCompanyTrade, canUserSend, effectiveCompanyStatus } from "./status";
import { transferInTx } from "./payments";
import { createInvoiceInTx, recipientTypeAndHandleFor } from "./invoices";
import { deriveCompanySettlement, assertSettlementDestination } from "./settlement";
import { runIdempotent, IdempotencyInProgressError } from "./idempotency";
import { notifyUser } from "./notify";
import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";
import {
  CONTRACT_EXPIRY_DAYS,
  CONTRACT_MAX_BUDGET,
  CONTRACT_PROPOSAL_MAX_LENGTH,
  CONTRACT_TEXT_MAX_LENGTH,
  CONTRACT_TITLE_MAX_LENGTH,
  MARKETPLACE_BROWSE_PAGE_SIZE,
} from "./constants";
import type {
  Invoice,
  MarketplaceContract,
  MarketplaceContractApplication,
} from "@/db/schema";

/**
 * CONTRACTS (V3 Phase D, spec §17)
 * ===========================================================================
 *
 * The Government, or an approved company, puts a piece of work out to tender.
 * Eligible users and companies apply. One application is awarded, the work is
 * invoiced (or paid directly, when the awarded party is a person and therefore
 * cannot issue invoices), and the contract completes.
 *
 * created → applications → award → invoice → payment → completion
 *
 * WHAT IS STRUCTURAL HERE
 * ----------------------
 * * ONE APPLICATION PER PARTY, enforced by the Phase A partial unique indexes
 *   `contract_application_{user,company}_unique`, not by a check.
 * * ONE INVOICE PER CONTRACT, enforced by `contract_invoice_unique`.
 * * THE AMOUNT IS DERIVED, NEVER SUPPLIED. It is the accepted application's
 *   `quotedPrice`, or the contract's own `budget` when the applicant quoted
 *   nothing. No caller passes an amount into `payAwardedContractToUser`.
 * * THE DESTINATION IS DERIVED. When the payee is a company, the invoice is
 *   issued BY that company and `payInvoice` settles it with
 *   `deriveCompanySettlement`; this module additionally derives and asserts the
 *   same destination at award/issue time. When the payee is a person, the
 *   destination is `userWallet(contract.awardedToUserId)` — read from the
 *   contract row, and no function here takes a wallet argument for it.
 * * PAYMENT IS IDEMPOTENT. The direct-to-user path is wrapped in a key derived
 *   from the contract id, so a double click cannot pay a contract twice; the
 *   invoice path inherits Phase B's key.
 *
 * There is deliberately no messaging system around any of this (§17).
 */

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = Pick<typeof db, "select">;

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

async function inboxUserId(executor: Executor, wallet: WalletRef): Promise<string | null> {
  if (wallet.kind === "USER") return wallet.id;
  if (wallet.kind === "COMPANY") {
    const [row] = await executor
      .select({ ownerUserId: companies.ownerUserId })
      .from(companies)
      .where(eq(companies.id, wallet.id))
      .limit(1);
    return row?.ownerUserId ?? null;
  }
  return null;
}

/** Human-readable contract number: CT-YYYYMMDD-NNNN, unique per day. */
async function nextContractNumber(tx: Tx): Promise<string> {
  const now = new Date();
  const datePart = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("");
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(marketplaceContracts)
    .where(sql`${marketplaceContracts.contractNumber} LIKE ${`CT-${datePart}-%`}`);
  return `CT-${datePart}-${String((row?.count ?? 0) + 1).padStart(4, "0")}`;
}

/** The wallet that PAYS a contract: its issuer, derived from the row. */
export async function contractIssuerWallet(
  executor: Executor,
  contract: Pick<MarketplaceContract, "issuerType" | "issuerCompanyId">,
): Promise<WalletRef> {
  if (contract.issuerType === "COMPANY") {
    if (!contract.issuerCompanyId) throw new ContractError("This contract has no issuer.");
    return companyWallet(contract.issuerCompanyId);
  }
  const [gov] = await executor.select({ id: government.id }).from(government).limit(1);
  if (!gov) throw new ContractError("Government account is not initialized.");
  return governmentWallet(gov.id);
}

/** The wallet that is PAID, once a contract is awarded. Derived from the row. */
export function contractPayeeWallet(
  contract: Pick<MarketplaceContract, "awardedToType" | "awardedToUserId" | "awardedToCompanyId">,
): WalletRef {
  if (contract.awardedToType === "USER" && contract.awardedToUserId) {
    return userWallet(contract.awardedToUserId);
  }
  if (contract.awardedToType === "COMPANY" && contract.awardedToCompanyId) {
    return companyWallet(contract.awardedToCompanyId);
  }
  throw new ContractError("This contract has not been awarded to anyone.");
}

export function applicantWallet(
  row: Pick<MarketplaceContractApplication, "applicantType" | "applicantUserId" | "applicantCompanyId">,
): WalletRef {
  if (row.applicantType === "USER") {
    if (!row.applicantUserId) throw new ContractError("This application has no applicant.");
    return userWallet(row.applicantUserId);
  }
  if (!row.applicantCompanyId) throw new ContractError("This application has no applicant.");
  return companyWallet(row.applicantCompanyId);
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export type ContractInput = {
  title: string;
  requirement: string;
  description: string;
  conditions?: string | null;
  budget: number;
  deadline?: Date | null;
};

/**
 * Creates a contract.
 *
 * `issuer` is a server-established fact: either a verified Government session
 * (`{ type: "GOVERNMENT" }`) or the approved company the caller is acting as.
 */
export async function createContract(params: {
  issuer: { type: "GOVERNMENT" } | { type: "COMPANY"; companyId: string };
  input: ContractInput;
}): Promise<MarketplaceContract> {
  const title = cleanText(params.input.title, CONTRACT_TITLE_MAX_LENGTH);
  const requirement = cleanText(params.input.requirement, CONTRACT_TEXT_MAX_LENGTH);
  const description = cleanText(params.input.description, CONTRACT_TEXT_MAX_LENGTH);
  const conditions = cleanText(params.input.conditions, CONTRACT_TEXT_MAX_LENGTH);
  const budget = Math.trunc(params.input.budget);

  if (title.length === 0) throw new ContractError("A title is required.");
  if (requirement.length === 0) throw new ContractError("A requirement is required.");
  if (description.length === 0) throw new ContractError("A description is required.");
  if (!Number.isInteger(budget) || budget < 1 || budget > CONTRACT_MAX_BUDGET) {
    throw new ContractError("The budget must be a whole number of at least 1 Aeros.");
  }

  return db.transaction(async (tx) => {
    if (params.issuer.type === "COMPANY") {
      const [issuer] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, params.issuer.companyId))
        .limit(1);
      if (!issuer) throw new ContractError("That company no longer exists.");
      // "Approved companies" only (§17): a pending, suspended or revoked
      // company cannot put work out to tender.
      if (effectiveCompanyStatus(issuer) !== "APPROVED") {
        throw new ContractError("Only an approved company can issue contracts.");
      }
    }

    const contractNumber = await nextContractNumber(tx);
    const [row] = await tx
      .insert(marketplaceContracts)
      .values({
        contractNumber,
        issuerType: params.issuer.type,
        issuerCompanyId: params.issuer.type === "COMPANY" ? params.issuer.companyId : null,
        title,
        requirement,
        description,
        conditions: conditions || null,
        budget,
        deadline: params.input.deadline ?? null,
        status: "OPEN",
        expiresAt: new Date(Date.now() + CONTRACT_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
      })
      .returning();
    return row;
  });
}

export async function cancelContract(params: {
  contractId: string;
  actor: { type: "GOVERNMENT" } | { type: "COMPANY"; companyId: string };
}): Promise<MarketplaceContract> {
  return db.transaction(async (tx) => {
    const contract = await lockContract(tx, params.contractId);
    assertIssuer(contract, params.actor);
    if (contract.status === "CANCELLED") return contract;
    if (contract.status === "COMPLETED") {
      throw new ContractError("A completed contract cannot be cancelled.");
    }
    if (contract.invoiceId) {
      throw new ContractError(
        "An invoice has been raised against this contract. Settle or cancel the invoice first.",
      );
    }

    const [updated] = await tx
      .update(marketplaceContracts)
      .set({ status: "CANCELLED", closedAt: new Date() })
      .where(
        and(
          eq(marketplaceContracts.id, contract.id),
          inArray(marketplaceContracts.status, ["OPEN", "AWARDED"]),
        ),
      )
      .returning();
    if (!updated) throw new ContractError("This contract changed while you were cancelling it.");
    return updated;
  });
}

async function lockContract(tx: Tx, contractId: string): Promise<MarketplaceContract> {
  const [row] = await tx
    .select()
    .from(marketplaceContracts)
    .where(eq(marketplaceContracts.id, contractId))
    .for("update");
  if (!row) throw new ContractError("Contract not found.");
  return row;
}

function assertIssuer(
  contract: MarketplaceContract,
  actor: { type: "GOVERNMENT" } | { type: "COMPANY"; companyId: string },
): void {
  if (actor.type === "GOVERNMENT") {
    if (contract.issuerType !== "GOVERNMENT") {
      throw new ContractError("This contract was not issued by the Government.");
    }
    return;
  }
  if (contract.issuerType !== "COMPANY" || contract.issuerCompanyId !== actor.companyId) {
    throw new ContractError("This contract was not issued by your company.");
  }
}

/** Lapses OPEN contracts past their expiry. Lazy and cheap. */
export async function expireOverdueContracts(): Promise<number> {
  const rows = await db
    .update(marketplaceContracts)
    .set({ status: "EXPIRED", closedAt: new Date() })
    .where(
      and(
        eq(marketplaceContracts.status, "OPEN"),
        lte(marketplaceContracts.expiresAt, new Date()),
      ),
    )
    .returning({ id: marketplaceContracts.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export async function applyForContract(params: {
  contractId: string;
  applicant: WalletRef;
  proposal: string;
  quotedPrice?: number | null;
}): Promise<MarketplaceContractApplication> {
  const proposal = cleanText(params.proposal, CONTRACT_PROPOSAL_MAX_LENGTH);
  if (proposal.length === 0) throw new ContractError("Please describe your proposal.");
  if (params.applicant.kind === "GOVERNMENT") {
    throw new ContractError("The Government does not apply for contracts.");
  }

  let quotedPrice: number | null = null;
  if (params.quotedPrice !== null && params.quotedPrice !== undefined) {
    quotedPrice = Math.trunc(params.quotedPrice);
    if (!Number.isInteger(quotedPrice) || quotedPrice < 1 || quotedPrice > CONTRACT_MAX_BUDGET) {
      throw new ContractError("A quoted price must be a whole number of at least 1 Aeros.");
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const contract = await lockContract(tx, params.contractId);
      if (contract.status !== "OPEN") {
        throw new ContractError(`This contract is ${contract.status} and is not taking applications.`);
      }
      if (contract.expiresAt.getTime() <= Date.now()) {
        throw new ContractError("This contract has closed for applications.");
      }

      // Eligibility: the applicant must be able to transact.
      if (params.applicant.kind === "USER") {
        const [row] = await tx.select().from(users).where(eq(users.id, params.applicant.id)).limit(1);
        if (!row) throw new ContractError("Your account could not be read.");
        if (!canUserSend(row)) throw new ContractError("Your account cannot apply right now.");
      } else {
        const [row] = await tx
          .select()
          .from(companies)
          .where(eq(companies.id, params.applicant.id))
          .limit(1);
        if (!row) throw new ContractError("Your company could not be read.");
        if (!canCompanyTrade(row)) throw new ContractError("This company cannot apply right now.");
        if (
          contract.issuerType === "COMPANY" &&
          contract.issuerCompanyId === params.applicant.id
        ) {
          throw new ContractError("A company cannot apply for its own contract.");
        }
      }

      const [application] = await tx
        .insert(marketplaceContractApplications)
        .values({
          contractId: contract.id,
          applicantType: params.applicant.kind,
          applicantUserId: params.applicant.kind === "USER" ? params.applicant.id : null,
          applicantCompanyId: params.applicant.kind === "COMPANY" ? params.applicant.id : null,
          proposal,
          quotedPrice,
          status: "PENDING",
        })
        .returning();

      const issuerWallet = await contractIssuerWallet(tx, contract);
      const inbox = await inboxUserId(tx, issuerWallet);
      if (inbox) {
        await notifyUser(
          tx,
          inbox,
          "CONTRACT_APPLICATION",
          `A new application arrived for contract ${contract.contractNumber} — ${contract.title}.`,
          `/market/contracts/${contract.id}`,
        );
      }
      if (contract.issuerType === "GOVERNMENT") {
        await recordAudit(tx, {
          action: "CONTRACT_APPLICATION_RECEIVED",
          actorType: params.applicant.kind === "USER" ? "USER" : "COMPANY",
          actorId: params.applicant.id,
          targetType: "CONTRACT",
          targetId: contract.id,
          metadata: { contractNumber: contract.contractNumber, quotedPrice },
        });
      }

      return application;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ContractError("You have already applied for this contract.");
    }
    throw e;
  }
}

export async function withdrawContractApplication(params: {
  applicationId: string;
  applicant: WalletRef;
}): Promise<MarketplaceContractApplication> {
  return db.transaction(async (tx) => {
    const [application] = await tx
      .select()
      .from(marketplaceContractApplications)
      .where(eq(marketplaceContractApplications.id, params.applicationId))
      .for("update");
    if (!application) throw new ContractError("Application not found.");
    if (!sameWallet(applicantWallet(application), params.applicant)) {
      throw new ContractError("This is not your application.");
    }
    if (application.status !== "PENDING") {
      throw new ContractError(`This application is already ${application.status}.`);
    }

    const [updated] = await tx
      .update(marketplaceContractApplications)
      .set({ status: "WITHDRAWN", respondedAt: new Date() })
      .where(
        and(
          eq(marketplaceContractApplications.id, application.id),
          eq(marketplaceContractApplications.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) throw new ContractError("This application changed while you were withdrawing.");
    return updated;
  });
}

// ---------------------------------------------------------------------------
// Award
// ---------------------------------------------------------------------------

/**
 * Awards a contract to one application.
 *
 * OPEN → AWARDED, the chosen application → ACCEPTED, every other pending one →
 * REJECTED, all in one transaction under the contract's row lock, so two
 * concurrent awards cannot both win and a contract can never end up with two
 * accepted applications.
 */
export async function awardContract(params: {
  contractId: string;
  applicationId: string;
  actor: { type: "GOVERNMENT" } | { type: "COMPANY"; companyId: string };
  actorLabel: string;
}): Promise<{ contract: MarketplaceContract; application: MarketplaceContractApplication }> {
  return db.transaction(async (tx) => {
    const contract = await lockContract(tx, params.contractId);
    assertIssuer(contract, params.actor);
    if (contract.status !== "OPEN") {
      throw new ContractError(`This contract is ${contract.status} and cannot be awarded.`);
    }

    const [application] = await tx
      .select()
      .from(marketplaceContractApplications)
      .where(eq(marketplaceContractApplications.id, params.applicationId))
      .for("update");
    if (!application) throw new ContractError("Application not found.");
    if (application.contractId !== contract.id) {
      throw new ContractError("That application belongs to a different contract.");
    }
    if (application.status !== "PENDING") {
      throw new ContractError(`That application is ${application.status}.`);
    }

    const payee = applicantWallet(application);
    // A company payee's money must land in the company wallet. Derived and
    // asserted here so the destination is fixed at award time, not at payment
    // time, and so no later step has a choice about it.
    if (payee.kind === "COMPANY") {
      const destination = await deriveCompanySettlement(tx, payee.id);
      assertSettlementDestination(destination, companyWallet(payee.id));
    }

    const [acceptedApp] = await tx
      .update(marketplaceContractApplications)
      .set({ status: "ACCEPTED", respondedAt: new Date() })
      .where(
        and(
          eq(marketplaceContractApplications.id, application.id),
          eq(marketplaceContractApplications.status, "PENDING"),
        ),
      )
      .returning();
    if (!acceptedApp) throw new ContractError("This application changed while you were awarding.");

    await tx
      .update(marketplaceContractApplications)
      .set({ status: "REJECTED", respondedAt: new Date() })
      .where(
        and(
          eq(marketplaceContractApplications.contractId, contract.id),
          eq(marketplaceContractApplications.status, "PENDING"),
        ),
      );

    const [updated] = await tx
      .update(marketplaceContracts)
      .set({
        status: "AWARDED",
        awardedAt: new Date(),
        awardedToType: application.applicantType,
        awardedToUserId: application.applicantUserId,
        awardedToCompanyId: application.applicantCompanyId,
      })
      .where(
        and(eq(marketplaceContracts.id, contract.id), eq(marketplaceContracts.status, "OPEN")),
      )
      .returning();
    if (!updated) throw new ContractError("This contract changed while you were awarding it.");

    const inbox = await inboxUserId(tx, payee);
    if (inbox) {
      await notifyUser(
        tx,
        inbox,
        "CONTRACT_AWARDED",
        `Contract ${contract.contractNumber} — ${contract.title} — was awarded to you.`,
        `/market/contracts/${contract.id}`,
      );
    }

    await recordAudit(tx, {
      action: "CONTRACT_AWARDED",
      actorType: params.actor.type,
      actorId: params.actor.type === "COMPANY" ? params.actor.companyId : null,
      actorLabel: params.actorLabel,
      targetType: "CONTRACT",
      targetId: contract.id,
      previousValue: "OPEN",
      newValue: "AWARDED",
      metadata: {
        contractNumber: contract.contractNumber,
        awardedToType: application.applicantType,
        quotedPrice: application.quotedPrice,
        budget: contract.budget,
      },
    });

    return { contract: updated, application: acceptedApp };
  });
}

/**
 * The amount a contract owes, derived from its accepted application.
 *
 * The applicant's quote wins when they gave one, otherwise the budget. Capped
 * at the budget, so an accepted quote can never bill more than was advertised.
 */
export async function contractPayableAmount(
  executor: Executor,
  contract: MarketplaceContract,
): Promise<number> {
  const [accepted] = await executor
    .select({ quotedPrice: marketplaceContractApplications.quotedPrice })
    .from(marketplaceContractApplications)
    .where(
      and(
        eq(marketplaceContractApplications.contractId, contract.id),
        eq(marketplaceContractApplications.status, "ACCEPTED"),
      ),
    )
    .limit(1);

  const quoted = accepted?.quotedPrice ?? null;
  const amount = quoted !== null ? Math.min(quoted, contract.budget) : contract.budget;
  if (!Number.isInteger(amount) || amount < 1) {
    throw new ContractError("This contract has no payable amount.");
  }
  return amount;
}

// ---------------------------------------------------------------------------
// Invoice (company payee) — reuses the Phase B engine
// ---------------------------------------------------------------------------

/**
 * The awarded COMPANY raises the contract's invoice on its issuer.
 *
 * `createInvoiceInTx` is the same engine every other invoice in the app uses,
 * so the numbering, the recipient resolution and the frozen tax snapshot are
 * identical. `contract_invoice_unique` makes a second invoice impossible.
 */
export async function issueContractInvoice(params: {
  contractId: string;
  payeeCompanyId: string;
  dueAt?: Date | null;
}): Promise<{ contract: MarketplaceContract; invoice: Invoice }> {
  try {
    return await db.transaction(async (tx) => {
      const contract = await lockContract(tx, params.contractId);
      if (contract.status !== "AWARDED") {
        throw new ContractError(`This contract is ${contract.status} and cannot be invoiced.`);
      }
      if (contract.invoiceId) {
        throw new ContractError("An invoice has already been raised for this contract.");
      }
      if (contract.awardedToType !== "COMPANY" || contract.awardedToCompanyId !== params.payeeCompanyId) {
        throw new ContractError("This contract was not awarded to your company.");
      }

      const [payee] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, params.payeeCompanyId))
        .limit(1);
      if (!payee) throw new ContractError("That company no longer exists.");

      const destination = await deriveCompanySettlement(tx, payee.id);
      assertSettlementDestination(destination, companyWallet(payee.id));

      const issuerWallet = await contractIssuerWallet(tx, contract);
      const { recipientType, username } = await recipientTypeAndHandleFor(tx, issuerWallet);
      const amount = await contractPayableAmount(tx, contract);

      const invoice = await createInvoiceInTx(tx, {
        company: payee,
        recipientType,
        recipientUsername: username,
        itemName: `Contract ${contract.contractNumber} — ${contract.title}`.slice(0, 160),
        description: contract.requirement,
        quantity: 1,
        unitPrice: amount,
        note: `Contract ${contract.contractNumber}`,
        dueAt: params.dueAt ?? null,
        taxContext: "CONTRACT_PAYMENT",
      });

      const [updated] = await tx
        .update(marketplaceContracts)
        .set({ invoiceId: invoice.id })
        .where(
          and(
            eq(marketplaceContracts.id, contract.id),
            eq(marketplaceContracts.status, "AWARDED"),
            isNull(marketplaceContracts.invoiceId),
          ),
        )
        .returning();
      if (!updated) {
        throw new ContractError("This contract changed while the invoice was being raised.");
      }

      const inbox = await inboxUserId(tx, issuerWallet);
      if (inbox) {
        await notifyUser(
          tx,
          inbox,
          "CONTRACT_INVOICE",
          `Invoice ${invoice.invoiceNumber} for contract ${contract.contractNumber} is ready — ${invoice.total.toLocaleString()} Aeros.`,
          `/invoices/${invoice.id}`,
        );
      }
      if (contract.issuerType === "GOVERNMENT") {
        await recordAudit(tx, {
          action: "CONTRACT_INVOICE_ISSUED",
          actorType: "COMPANY",
          actorId: payee.id,
          actorLabel: payee.name,
          targetType: "CONTRACT",
          targetId: contract.id,
          newValue: String(invoice.total),
          metadata: {
            contractNumber: contract.contractNumber,
            invoiceNumber: invoice.invoiceNumber,
          },
        });
      }

      return { contract: updated, invoice };
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ContractError("An invoice has already been raised for this contract.");
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Direct payment (user payee) — a person cannot issue an invoice
// ---------------------------------------------------------------------------

/**
 * The issuer pays an awarded contract whose payee is a PERSON.
 *
 * Nothing about the movement is supplied by the caller: the amount comes from
 * the accepted application, the destination from `contract.awardedToUserId`,
 * and the payer from the contract's own issuer column. Wrapped in an
 * idempotency key derived from the contract id, so a duplicate submit replays
 * instead of paying twice.
 */
export async function payAwardedContractToUser(params: {
  contractId: string;
  actor: { type: "GOVERNMENT"; id: string; label: string } | { type: "COMPANY"; companyId: string; label: string };
}): Promise<{ contract: MarketplaceContract; txRef: string; amount: number; replayed: boolean }> {
  const actorType = params.actor.type;
  const actorId = actorType === "GOVERNMENT" ? params.actor.id : params.actor.companyId;

  const outcome = await runIdempotent<{
    contract: MarketplaceContract;
    txRef: string;
    amount: number;
  }>({
    // THE ACTOR IS PART OF THE KEY, not only of the fingerprint.
    //
    // It used to be `CONTRACTPAY:<contractId>` alone while the FACTS carried
    // the actor, and that asymmetry was a live denial-of-service. `runIdempotent`
    // CLAIMS the key before `perform` runs — before `assertIssuer` has had a
    // chance to refuse anybody — so one refused attempt by a company that does
    // not issue the contract left a FAILED key stamped with THAT company's
    // fingerprint. The real issuer's next attempt then hashed differently and
    // was rejected with "this idempotency key was already used for a different
    // request", making the contract unpayable until the key expired. Any user
    // with a company could trigger it by posting somebody else's contract id.
    //
    // Keying per actor — exactly as `invoicePaymentKey` already does for
    // invoices — means a refused caller can only ever poison their own key.
    // Nothing is lost: paying twice is prevented by `contract.paid_tx_ref` and
    // the guarded `WHERE status = 'AWARDED'` update below, both under the
    // contract's row lock. The key only buys retry-replay for one caller.
    key: `CONTRACTPAY:${params.contractId}:${actorType}:${actorId}`,
    scope: "CONTRACT_PAYMENT",
    actor: { type: actorType, id: actorId },
    facts: { contractId: params.contractId, actorType, actorId },
    perform: async (tx) => {
      const contract = await lockContract(tx, params.contractId);
      assertIssuer(
        contract,
        actorType === "GOVERNMENT"
          ? { type: "GOVERNMENT" }
          : { type: "COMPANY", companyId: (params.actor as { companyId: string }).companyId },
      );
      if (contract.status !== "AWARDED") {
        throw new ContractError(`This contract is ${contract.status} and cannot be paid.`);
      }
      if (contract.awardedToType !== "USER") {
        throw new ContractError(
          "This contract was awarded to a company; it is settled through the company's invoice.",
        );
      }
      if (contract.paidTxRef) {
        throw new ContractError("This contract has already been paid.");
      }

      const payer = await contractIssuerWallet(tx, contract);
      const payee = contractPayeeWallet(contract);
      const amount = await contractPayableAmount(tx, contract);

      const result = await transferInTx(tx, {
        from: payer,
        to: payee,
        amount,
        type: "CONTRACT_PAYMENT",
        taxContext: "CONTRACT_PAYMENT",
        reason: `Contract ${contract.contractNumber} — ${contract.title}`,
        // The Government paying out of the treasury is an administrative
        // movement, exactly as in payments.ts's other treasury paths.
        forcedTaxRateBp: payer.kind === "GOVERNMENT" ? 0 : undefined,
        skipSenderCheck: payer.kind === "GOVERNMENT",
        notify: {
          receiverType: "CONTRACT_PAID",
          receiverMessage: (r) =>
            `Contract ${contract.contractNumber} paid — ${r.netAmount.toLocaleString()} Aeros received. Ref ${r.txRef}.`,
          href: `/market/contracts/${contract.id}`,
        },
      });

      const [updated] = await tx
        .update(marketplaceContracts)
        .set({ status: "COMPLETED", closedAt: new Date(), paidTxRef: result.txRef })
        .where(
          and(
            eq(marketplaceContracts.id, contract.id),
            eq(marketplaceContracts.status, "AWARDED"),
            isNull(marketplaceContracts.paidTxRef),
          ),
        )
        .returning();
      if (!updated) throw new ContractError("This contract changed while it was being paid.");

      await recordAudit(tx, {
        action: "CONTRACT_PAID",
        actorType,
        actorId,
        actorLabel: params.actor.label,
        targetType: "CONTRACT",
        targetId: contract.id,
        previousValue: "AWARDED",
        newValue: "COMPLETED",
        metadata: {
          contractNumber: contract.contractNumber,
          amount,
          txRef: result.txRef,
        },
      });

      return {
        value: { contract: updated, txRef: result.txRef, amount },
        txRef: result.txRef,
        entityType: "CONTRACT",
        entityId: contract.id,
      };
    },
    replay: async (record) => {
      const [row] = await db
        .select()
        .from(marketplaceContracts)
        .where(eq(marketplaceContracts.id, params.contractId))
        .limit(1);
      if (!row || !record.resultTxRef) {
        throw new ContractError("This contract was paid but its receipt could not be read.");
      }
      return {
        contract: row,
        txRef: record.resultTxRef,
        amount: await contractPayableAmount(db, row),
      };
    },
  });

  return { ...outcome.value, replayed: outcome.replayed };
}

export function isContractPaymentInProgress(e: unknown): boolean {
  return e instanceof IdempotencyInProgressError;
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export type ContractRow = {
  contract: MarketplaceContract;
  issuerLabel: string;
  issuerHandle: string;
  awardedToLabel: string | null;
  applicationCount: number;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceTotal: number | null;
};

async function labelContracts(rows: MarketplaceContract[]): Promise<ContractRow[]> {
  if (rows.length === 0) return [];

  const companyIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.issuerCompanyId, r.awardedToCompanyId])
        .filter((v): v is string => !!v),
    ),
  ];
  const userIds = [...new Set(rows.map((r) => r.awardedToUserId).filter((v): v is string => !!v))];
  const invoiceIds = [...new Set(rows.map((r) => r.invoiceId).filter((v): v is string => !!v))];

  const companyRows = companyIds.length
    ? await db
        .select({ id: companies.id, username: companies.username, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, username: users.username, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const invoiceRows = invoiceIds.length
    ? await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          total: invoices.total,
        })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds))
    : [];
  const counts = await db
    .select({
      contractId: marketplaceContractApplications.contractId,
      count: sql<number>`count(*)::int`,
    })
    .from(marketplaceContractApplications)
    .where(inArray(marketplaceContractApplications.contractId, rows.map((r) => r.id)))
    .groupBy(marketplaceContractApplications.contractId);

  const companyMap = new Map(companyRows.map((r) => [r.id, r]));
  const userMap = new Map(userRows.map((r) => [r.id, r]));
  const invoiceMap = new Map(invoiceRows.map((r) => [r.id, r]));
  const countMap = new Map(counts.map((r) => [r.contractId, r.count]));

  return rows.map((contract) => {
    const issuerCompany = contract.issuerCompanyId
      ? companyMap.get(contract.issuerCompanyId)
      : null;
    const awardedCompany = contract.awardedToCompanyId
      ? companyMap.get(contract.awardedToCompanyId)
      : null;
    const awardedUser = contract.awardedToUserId ? userMap.get(contract.awardedToUserId) : null;
    const invoice = contract.invoiceId ? invoiceMap.get(contract.invoiceId) : null;

    return {
      contract,
      issuerLabel: issuerCompany?.name ?? "Government",
      issuerHandle: issuerCompany?.username ?? "government",
      awardedToLabel:
        awardedCompany?.name ??
        (awardedUser ? `${awardedUser.displayName} (@${awardedUser.username})` : null),
      applicationCount: countMap.get(contract.id) ?? 0,
      invoiceNumber: invoice?.invoiceNumber ?? null,
      invoiceStatus: invoice?.status ?? null,
      invoiceTotal: invoice?.total ?? null,
    };
  });
}

export type ContractBrowseResult = {
  rows: ContractRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

/** Paginated browse over contracts. Nothing about the query is stored. */
export async function browseContracts(filters: {
  q?: string | null;
  status?: "OPEN" | "AWARDED" | "COMPLETED" | "ALL";
  page?: number;
  pageSize?: number;
} = {}): Promise<ContractBrowseResult> {
  const pageSize = Math.min(
    Math.max(Math.trunc(filters.pageSize ?? MARKETPLACE_BROWSE_PAGE_SIZE), 1),
    50,
  );
  const page = Math.max(Math.trunc(filters.page ?? 1), 1);

  const conditions: SQL<unknown>[] = [];
  const status = filters.status ?? "OPEN";
  if (status !== "ALL") {
    conditions.push(eq(marketplaceContracts.status, status) as SQL<unknown>);
  }

  const q = cleanText(filters.q, 120);
  if (q.length > 0) {
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      or(
        sql`${marketplaceContracts.title} ILIKE ${like}`,
        sql`${marketplaceContracts.requirement} ILIKE ${like}`,
        sql`${marketplaceContracts.description} ILIKE ${like}`,
        sql`${marketplaceContracts.contractNumber} ILIKE ${like}`,
      ) as SQL<unknown>,
    );
  }

  const where = conditions.length > 0 ? (and(...conditions) as SQL<unknown>) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(marketplaceContracts)
    .where(where);
  const total = countRow?.count ?? 0;

  const rows = await db
    .select()
    .from(marketplaceContracts)
    .where(where)
    .orderBy(desc(marketplaceContracts.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: await labelContracts(rows),
    total,
    page,
    pageSize,
    pageCount: Math.max(Math.ceil(total / pageSize), 1),
  };
}

export async function getContractById(contractId: string): Promise<ContractRow | null> {
  const [row] = await db
    .select()
    .from(marketplaceContracts)
    .where(eq(marketplaceContracts.id, contractId))
    .limit(1);
  if (!row) return null;
  const [labelled] = await labelContracts([row]);
  return labelled;
}

export type ContractApplicationRow = {
  application: MarketplaceContractApplication;
  applicantLabel: string;
  applicantHandle: string;
};

export async function getApplicationsForContract(
  contractId: string,
): Promise<ContractApplicationRow[]> {
  const rows = await db
    .select()
    .from(marketplaceContractApplications)
    .where(eq(marketplaceContractApplications.contractId, contractId))
    .orderBy(asc(marketplaceContractApplications.createdAt));
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.applicantUserId).filter((v): v is string => !!v))];
  const companyIds = [
    ...new Set(rows.map((r) => r.applicantCompanyId).filter((v): v is string => !!v)),
  ];
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, username: users.username, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const companyRows = companyIds.length
    ? await db
        .select({ id: companies.id, username: companies.username, name: companies.name })
        .from(companies)
        .where(inArray(companies.id, companyIds))
    : [];
  const userMap = new Map(userRows.map((r) => [r.id, r]));
  const companyMap = new Map(companyRows.map((r) => [r.id, r]));

  return rows.map((application) => {
    const u = application.applicantUserId ? userMap.get(application.applicantUserId) : null;
    const c = application.applicantCompanyId ? companyMap.get(application.applicantCompanyId) : null;
    return {
      application,
      applicantLabel: u?.displayName ?? c?.name ?? "Unknown",
      applicantHandle: u?.username ?? c?.username ?? "unknown",
    };
  });
}

/** Contracts issued by a wallet (a company, or the Government). */
export async function getContractsForIssuer(
  issuer: { type: "GOVERNMENT" } | { type: "COMPANY"; companyId: string },
  limit = 100,
): Promise<ContractRow[]> {
  const rows = await db
    .select()
    .from(marketplaceContracts)
    .where(
      issuer.type === "GOVERNMENT"
        ? eq(marketplaceContracts.issuerType, "GOVERNMENT")
        : eq(marketplaceContracts.issuerCompanyId, issuer.companyId),
    )
    .orderBy(desc(marketplaceContracts.createdAt))
    .limit(limit);
  return labelContracts(rows);
}

/** Contracts awarded to the wallet the viewer is acting as. */
export async function getContractsAwardedTo(
  payee: WalletRef,
  limit = 100,
): Promise<ContractRow[]> {
  if (payee.kind === "GOVERNMENT") return [];
  const rows = await db
    .select()
    .from(marketplaceContracts)
    .where(
      payee.kind === "USER"
        ? eq(marketplaceContracts.awardedToUserId, payee.id)
        : eq(marketplaceContracts.awardedToCompanyId, payee.id),
    )
    .orderBy(desc(marketplaceContracts.createdAt))
    .limit(limit);
  return labelContracts(rows);
}

/** This wallet's application to a contract, if any. */
export async function getMyApplication(
  contractId: string,
  applicant: WalletRef,
): Promise<MarketplaceContractApplication | null> {
  if (applicant.kind === "GOVERNMENT") return null;
  const [row] = await db
    .select()
    .from(marketplaceContractApplications)
    .where(
      and(
        eq(marketplaceContractApplications.contractId, contractId),
        applicant.kind === "USER"
          ? eq(marketplaceContractApplications.applicantUserId, applicant.id)
          : eq(marketplaceContractApplications.applicantCompanyId, applicant.id),
      ),
    )
    .limit(1);
  return row ?? null;
}
