import "server-only";
import { db } from "@/db/client";
import {
  accountingCheckpoints,
  auditLogs,
  companies,
  companySaleRecords,
  exchangePurchases,
  invoices,
  issuanceRequests,
  loanPayments,
  loans,
  marketOrders,
  marketplaceOffers,
  marketplaceOrders,
  refundRequests,
  supportMessages,
  supportThreads,
  transactions,
  users,
} from "@/db/schema";
import { and, asc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { csvHeader, csvRow, UTF8_BOM } from "./csv";

/**
 * DATA EXPORT (spec §§32, 33, 34, 44)
 * ===========================================================================
 *
 * Four properties this module is built around, in the order they matter:
 *
 * 1. NOTHING IS STORED (§32). There is no exports table, no job row, no file
 *    on disk and no cached blob. An export is a SELECT loop that turns into
 *    bytes on the way out. The only trace an export leaves anywhere is the
 *    single audit row a Government export writes, which records who asked for
 *    what — never the contents.
 *
 * 2. THE SCOPE IS THE SESSION, NEVER THE REQUEST (§44). A dataset is fetched
 *    with an `ExportScope` the ROUTE derived from the caller's own session and
 *    ownership. No dataset reads an id out of the query string; `ExportFilters`
 *    deliberately has no user/company id field at all, only names that NARROW a
 *    Government export, which is already permitted to see everything. A user
 *    export and a company export cannot be widened by any parameter, because
 *    there is no parameter that widens them.
 *
 * 3. MEMORY IS BOUNDED (§34). Every dataset is read by KEYSET PAGINATION on
 *    `(created_at, id)` — a stable, index-friendly composite that cannot skip
 *    or duplicate a row when rows are inserted mid-export, the way OFFSET can.
 *    `streamExport` pulls one page, converts it to bytes, hands it to the
 *    platform, and drops it. Peak memory is one page, whether the table holds
 *    a hundred rows or a hundred thousand.
 *
 * 4. THE OUTPUT IS INERT (§44). See src/lib/csv.ts: every user-controlled text
 *    cell is neutralised so a spreadsheet cannot execute it, and quoted so a
 *    comma cannot shift a column.
 *
 * WHAT IS NEVER IN AN EXPORT
 * --------------------------
 * Every dataset below names its columns EXPLICITLY. There is no `select *`
 * anywhere in this file, which is what makes "no password hash, no security
 * code hash, no session secret" a property of the code rather than a promise:
 * `users.passwordHash`, `government.passwordHash` and
 * `government.securityCodeHash` are never named, and the `government` table is
 * not a dataset at all.
 */

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

// ---------------------------------------------------------------------------
// Scope — who is asking
// ---------------------------------------------------------------------------

export type ExportScope =
  | { kind: "GOVERNMENT" }
  | { kind: "USER"; userId: string; username: string }
  | { kind: "COMPANY"; companyId: string; username: string; ownerUserId: string };

/**
 * The company-scope gate.
 *
 * Callers pass the company they resolved from the ACTING CONTEXT (which is
 * itself re-read from the database and re-checked for ownership on every
 * request — see getActingContext). This is the second, explicit check, so the
 * rule is stated where the export happens and not only where the cookie is
 * read: a company export is only ever for a company this user owns.
 */
export function companyScopeFor(
  user: { id: string },
  company: { id: string; username: string; ownerUserId: string } | null,
): ExportScope {
  if (!company) {
    throw new ExportError("Switch to a company wallet to export that company's records.");
  }
  if (company.ownerUserId !== user.id) {
    throw new ExportError("You can only export records for a company you own.");
  }
  return {
    kind: "COMPANY",
    companyId: company.id,
    username: company.username,
    ownerUserId: company.ownerUserId,
  };
}

export function userScopeFor(user: { id: string; username: string }): ExportScope {
  return { kind: "USER", userId: user.id, username: user.username };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type ExportFilters = {
  /** Inclusive lower bound on the row's own timestamp. */
  from: Date | null;
  /** Inclusive upper bound. */
  to: Date | null;
  /** Transaction type / sale type / audit action, per dataset. */
  type: string | null;
  status: string | null;
  walletType: "USER" | "COMPANY" | "GOVERNMENT" | null;
  minAmount: number | null;
  maxAmount: number | null;
  /** A username to narrow a GOVERNMENT export to. Ignored for user/company
   * exports, which are already scoped to exactly one identity. */
  user: string | null;
  company: string | null;
  /** Free-text match against the party names on the row. */
  entity: string | null;
};

export const EMPTY_FILTERS: ExportFilters = {
  from: null,
  to: null,
  type: null,
  status: null,
  walletType: null,
  minAmount: null,
  maxAmount: null,
  user: null,
  company: null,
  entity: null,
};

export type ExportFilterName = keyof ExportFilters;

const WALLET_TYPES = new Set(["USER", "COMPANY", "GOVERNMENT"]);

function parseDate(raw: string | null, endOfDay: boolean): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // A bare YYYY-MM-DD is read as an IST calendar day boundary, because every
  // other day boundary in this app is IST (src/lib/datetime.ts) and a date
  // picker that silently meant UTC would drop 5½ hours of a day's rows.
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const value = dayOnly
    ? new Date(`${trimmed}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+05:30`)
    : new Date(trimmed);
  return Number.isNaN(value.getTime()) ? null : value;
}

function parseInteger(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

function parseText(raw: string | null, max = 80): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, max);
  return trimmed === "" ? null : trimmed;
}

/**
 * Turns a query string into filters.
 *
 * Everything unparseable becomes `null` — an export with a nonsense filter
 * returns the unfiltered dataset rather than an error, because a filter can
 * only ever NARROW a result set the caller is already allowed to see. There is
 * no parameter here that grants access to anything.
 */
export function parseExportFilters(params: URLSearchParams): ExportFilters {
  const walletType = parseText(params.get("walletType"), 16)?.toUpperCase() ?? null;
  return {
    from: parseDate(params.get("from"), false),
    to: parseDate(params.get("to"), true),
    type: parseText(params.get("type"), 48)?.toUpperCase() ?? null,
    status: parseText(params.get("status"), 48)?.toUpperCase() ?? null,
    walletType: walletType && WALLET_TYPES.has(walletType) ? (walletType as "USER") : null,
    minAmount: parseInteger(params.get("minAmount")),
    maxAmount: parseInteger(params.get("maxAmount")),
    user: parseText(params.get("user"), 32)?.toLowerCase() ?? null,
    company: parseText(params.get("company"), 32)?.toLowerCase() ?? null,
    entity: parseText(params.get("entity"), 80),
  };
}

/** Compact record of which filters were actually applied, for the audit row
 * and the JSON envelope. Never includes anything the caller did not send. */
export function describeFilters(f: ExportFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.from) out.from = f.from.toISOString();
  if (f.to) out.to = f.to.toISOString();
  if (f.type) out.type = f.type;
  if (f.status) out.status = f.status;
  if (f.walletType) out.walletType = f.walletType;
  if (f.minAmount !== null) out.minAmount = String(f.minAmount);
  if (f.maxAmount !== null) out.maxAmount = String(f.maxAmount);
  if (f.user) out.user = f.user;
  if (f.company) out.company = f.company;
  if (f.entity) out.entity = f.entity;
  return out;
}

// ---------------------------------------------------------------------------
// Keyset pagination
// ---------------------------------------------------------------------------

/**
 * The paging cursor.
 *
 * `at` is deliberately a STRING, not a Date, and that is not a style choice.
 * Postgres stores `timestamptz` to MICROSECOND precision; a JavaScript `Date`
 * holds milliseconds. Round-tripping a timestamp through a `Date` therefore
 * TRUNCATES it — and a truncated cursor is strictly less than the row it came
 * from, so `(created_at, id) > cursor` matches that row again and the export
 * pages forever without advancing. Carrying the timestamp as the text
 * Postgres itself rendered, and casting it straight back, keeps every digit.
 */
export type ExportCursor = { at: string; id: string } | null;

/** Selects the ordering timestamp at full precision, as text. */
function cursorAtColumn(createdAt: PgColumn) {
  return sql<string>`${createdAt}::text`;
}

/**
 * `(created_at, id) > (cursorAt, cursorId)`.
 *
 * A composite row comparison rather than `created_at > x`, so rows sharing a
 * timestamp (very common — a payment writes several rows in one transaction)
 * are neither skipped nor repeated.
 */
function afterCursor(
  createdAt: SQL | ReturnType<typeof sql>,
  id: SQL | ReturnType<typeof sql>,
  cursor: ExportCursor,
): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${createdAt}, ${id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
}

function cursorFrom(rows: Array<{ _at: string; _id: string }>): ExportCursor {
  const last = rows[rows.length - 1];
  return last ? { at: last._at, id: last._id } : null;
}

function dateRange(column: SQL | ReturnType<typeof sql>, f: ExportFilters): (SQL | undefined)[] {
  return [
    f.from ? gte(column as never, f.from) : undefined,
    f.to ? lte(column as never, f.to) : undefined,
  ];
}

function amountRange(column: SQL | ReturnType<typeof sql>, f: ExportFilters): (SQL | undefined)[] {
  return [
    f.minAmount !== null ? gte(column as never, f.minAmount) : undefined,
    f.maxAmount !== null ? lte(column as never, f.maxAmount) : undefined,
  ];
}

function allOf(conditions: (SQL | undefined)[]): SQL | undefined {
  const present = conditions.filter((c): c is SQL => c !== undefined);
  if (present.length === 0) return undefined;
  return and(...present);
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export type ExportRow = Record<string, unknown>;
export type ExportPage = { rows: ExportRow[]; next: ExportCursor };

export type ExportDataset = {
  key: string;
  label: string;
  description: string;
  /** Which scopes may read it. A dataset absent from a scope's list is not
   * merely hidden from the UI — `getDataset` refuses it. */
  scopes: readonly ExportScope["kind"][];
  columns: readonly string[];
  supports: readonly ExportFilterName[];
  fetchPage(scope: ExportScope, f: ExportFilters, cursor: ExportCursor, limit: number): Promise<ExportPage>;
};

/** Usernames a Government filter names, resolved to ids exactly once. */
async function resolveNamedParties(f: ExportFilters): Promise<{
  userId: string | null;
  companyId: string | null;
}> {
  const [u, c] = await Promise.all([
    f.user
      ? db.select({ id: users.id }).from(users).where(eq(users.username, f.user)).limit(1)
      : Promise.resolve([]),
    f.company
      ? db.select({ id: companies.id }).from(companies).where(eq(companies.username, f.company)).limit(1)
      : Promise.resolve([]),
  ]);
  return {
    // A name that matches nothing yields an impossible id rather than "no
    // filter", so `?user=nobody` returns an empty export, not the whole table.
    userId: f.user ? (u[0]?.id ?? "00000000-0000-0000-0000-000000000000") : null,
    companyId: f.company ? (c[0]?.id ?? "00000000-0000-0000-0000-000000000000") : null,
  };
}

// --- the ledger, and the four views of it ----------------------------------

const TRANSACTION_COLUMNS = [
  "txRef",
  "type",
  "createdAt",
  "senderType",
  "senderUsername",
  "receiverType",
  "receiverUsername",
  "grossAmount",
  "taxAmount",
  "netAmount",
  "taxRateBpApplied",
  "reason",
  "invoiceId",
  "reversesTransactionId",
] as const;

const transactionSelect = {
  txRef: transactions.txRef,
  type: transactions.type,
  createdAt: transactions.createdAt,
  senderType: transactions.senderType,
  senderUsername: transactions.senderUsername,
  receiverType: transactions.receiverType,
  receiverUsername: transactions.receiverUsername,
  grossAmount: transactions.grossAmount,
  taxAmount: transactions.taxAmount,
  netAmount: transactions.netAmount,
  taxRateBpApplied: transactions.taxRateBpApplied,
  reason: transactions.reason,
  invoiceId: transactions.invoiceId,
  reversesTransactionId: transactions.reversesTransactionId,
  _at: cursorAtColumn(transactions.createdAt),
  _id: transactions.id,
};

/**
 * The one place ledger rows are read for export.
 *
 * `scopeConditions` is built from the SCOPE (a session fact) and `extra` from
 * the dataset (a fixed predicate like "involves the Treasury"). Filters can
 * only add further conditions on top, so no combination of query parameters
 * can produce a row the scope did not already permit.
 */
async function transactionPage(
  scope: ExportScope,
  f: ExportFilters,
  cursor: ExportCursor,
  limit: number,
  extra: (SQL | undefined)[] = [],
): Promise<ExportPage> {
  const conditions: (SQL | undefined)[] = [...extra];

  if (scope.kind === "USER") {
    conditions.push(
      or(
        and(eq(transactions.senderType, "USER"), eq(transactions.senderId, scope.userId)),
        and(eq(transactions.receiverType, "USER"), eq(transactions.receiverId, scope.userId)),
      ),
    );
  } else if (scope.kind === "COMPANY") {
    conditions.push(
      or(
        and(eq(transactions.senderType, "COMPANY"), eq(transactions.senderId, scope.companyId)),
        and(eq(transactions.receiverType, "COMPANY"), eq(transactions.receiverId, scope.companyId)),
      ),
    );
  } else {
    const named = await resolveNamedParties(f);
    if (named.userId) {
      conditions.push(
        or(eq(transactions.senderId, named.userId), eq(transactions.receiverId, named.userId)),
      );
    }
    if (named.companyId) {
      conditions.push(
        or(eq(transactions.senderId, named.companyId), eq(transactions.receiverId, named.companyId)),
      );
    }
    if (f.walletType) {
      conditions.push(
        or(eq(transactions.senderType, f.walletType), eq(transactions.receiverType, f.walletType)),
      );
    }
    if (f.entity) {
      conditions.push(
        or(
          ilike(transactions.senderUsername, `%${f.entity}%`),
          ilike(transactions.receiverUsername, `%${f.entity}%`),
        ),
      );
    }
  }

  if (f.type) {
    // An unknown type name must not throw on the enum cast; compare as text.
    conditions.push(sql`${transactions.type}::text = ${f.type}`);
  }
  conditions.push(...dateRange(transactions.createdAt as never, f));
  conditions.push(...amountRange(transactions.grossAmount as never, f));
  conditions.push(afterCursor(transactions.createdAt as never, transactions.id as never, cursor));

  const rows = await db
    .select(transactionSelect)
    .from(transactions)
    .where(allOf(conditions))
    .orderBy(asc(transactions.createdAt), asc(transactions.id))
    .limit(limit);

  return { rows, next: cursorFrom(rows) };
}

// --- registry --------------------------------------------------------------

const GOVERNMENT_ONLY: readonly ExportScope["kind"][] = ["GOVERNMENT"];

const DATASETS: ExportDataset[] = [
  {
    key: "transactions",
    label: "Transactions / ledger",
    description: "Every ledger row: parties, gross, tax, net, rate and reason.",
    scopes: ["GOVERNMENT", "USER", "COMPANY"],
    columns: TRANSACTION_COLUMNS,
    supports: ["from", "to", "type", "walletType", "minAmount", "maxAmount", "user", "company", "entity"],
    fetchPage: (scope, f, cursor, limit) => transactionPage(scope, f, cursor, limit),
  },
  {
    key: "treasury",
    label: "Treasury movements",
    description: "Ledger rows where the Government is the payer or the payee.",
    scopes: GOVERNMENT_ONLY,
    columns: TRANSACTION_COLUMNS,
    supports: ["from", "to", "type", "minAmount", "maxAmount", "user", "company", "entity"],
    fetchPage: (scope, f, cursor, limit) =>
      transactionPage(scope, f, cursor, limit, [
        or(eq(transactions.senderType, "GOVERNMENT"), eq(transactions.receiverType, "GOVERNMENT")),
      ]),
  },
  {
    key: "taxes",
    label: "Taxes collected",
    description: "Ledger rows that collected tax, with the rate that applied.",
    scopes: GOVERNMENT_ONLY,
    columns: TRANSACTION_COLUMNS,
    supports: ["from", "to", "type", "walletType", "minAmount", "maxAmount", "user", "company", "entity"],
    fetchPage: (scope, f, cursor, limit) =>
      transactionPage(scope, f, cursor, limit, [sql`${transactions.taxAmount} > 0`]),
  },
  {
    key: "company-funding",
    label: "Company funding",
    description: "Approval funding paid out of the Treasury to companies.",
    scopes: GOVERNMENT_ONLY,
    columns: TRANSACTION_COLUMNS,
    supports: ["from", "to", "minAmount", "maxAmount", "company", "entity"],
    fetchPage: (scope, f, cursor, limit) =>
      transactionPage(scope, f, cursor, limit, [eq(transactions.type, "COMPANY_FUNDING")]),
  },
  {
    key: "issuance",
    label: "Issuance history",
    description: "Every Aeros issuance request, its outcome and its ledger reference.",
    scopes: GOVERNMENT_ONLY,
    columns: ["id", "amount", "status", "reason", "note", "createdAt", "executedAt", "executedTxRef"],
    supports: ["from", "to", "status", "minAmount", "maxAmount"],
    async fetchPage(_scope, f, cursor, limit) {
      const conditions = [
        f.status ? sql`${issuanceRequests.status}::text = ${f.status}` : undefined,
        ...dateRange(issuanceRequests.createdAt as never, f),
        ...amountRange(issuanceRequests.amount as never, f),
        afterCursor(issuanceRequests.createdAt as never, issuanceRequests.id as never, cursor),
      ];
      const rows = await db
        .select({
          id: issuanceRequests.id,
          amount: issuanceRequests.amount,
          status: issuanceRequests.status,
          reason: issuanceRequests.reason,
          note: issuanceRequests.note,
          createdAt: issuanceRequests.createdAt,
          executedAt: issuanceRequests.executedAt,
          executedTxRef: issuanceRequests.executedTxRef,
          _at: cursorAtColumn(issuanceRequests.createdAt),
          _id: issuanceRequests.id,
        })
        .from(issuanceRequests)
        .where(allOf(conditions))
        .orderBy(asc(issuanceRequests.createdAt), asc(issuanceRequests.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "company-ownership",
    label: "Company ownership",
    description: "Who owns each company right now, and whether it is under Government stewardship.",
    scopes: GOVERNMENT_ONLY,
    columns: [
      "companyId",
      "companyUsername",
      "companyName",
      "status",
      "ownerUsername",
      "ownerUserId",
      "governmentOwned",
      "governmentAcquiredAt",
      "balance",
      "createdAt",
    ],
    supports: ["from", "to", "status", "company", "entity"],
    async fetchPage(_scope, f, cursor, limit) {
      const conditions = [
        f.status ? sql`${companies.status}::text = ${f.status}` : undefined,
        f.company ? eq(companies.username, f.company) : undefined,
        f.entity ? ilike(companies.name, `%${f.entity}%`) : undefined,
        ...dateRange(companies.createdAt as never, f),
        afterCursor(companies.createdAt as never, companies.id as never, cursor),
      ];
      const rows = await db
        .select({
          companyId: companies.id,
          companyUsername: companies.username,
          companyName: companies.name,
          status: companies.status,
          ownerUsername: users.username,
          ownerUserId: companies.ownerUserId,
          governmentOwned: companies.governmentOwned,
          governmentAcquiredAt: companies.governmentAcquiredAt,
          balance: companies.balance,
          createdAt: companies.createdAt,
          _at: cursorAtColumn(companies.createdAt),
          _id: companies.id,
        })
        .from(companies)
        .leftJoin(users, eq(users.id, companies.ownerUserId))
        .where(allOf(conditions))
        .orderBy(asc(companies.createdAt), asc(companies.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "company-sales",
    label: "Company sales",
    description: "Completed ownership transfers, with price, valuation basis and ledger reference.",
    scopes: ["GOVERNMENT", "COMPANY"],
    columns: [
      "id",
      "companyId",
      "sellerUserId",
      "buyerUserId",
      "price",
      "salesFigure",
      "multiplierBp",
      "companyBalanceAtSale",
      "saleType",
      "txRef",
      "createdAt",
    ],
    supports: ["from", "to", "type", "minAmount", "maxAmount", "company"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "COMPANY") {
        conditions.push(eq(companySaleRecords.companyId, scope.companyId));
      } else if (f.company) {
        const named = await resolveNamedParties(f);
        conditions.push(eq(companySaleRecords.companyId, named.companyId!));
      }
      conditions.push(
        f.type ? eq(companySaleRecords.saleType, f.type) : undefined,
        ...dateRange(companySaleRecords.createdAt as never, f),
        ...amountRange(companySaleRecords.price as never, f),
        afterCursor(companySaleRecords.createdAt as never, companySaleRecords.id as never, cursor),
      );
      const rows = await db
        .select({
          id: companySaleRecords.id,
          companyId: companySaleRecords.companyId,
          sellerUserId: companySaleRecords.sellerUserId,
          buyerUserId: companySaleRecords.buyerUserId,
          price: companySaleRecords.price,
          salesFigure: companySaleRecords.salesFigure,
          multiplierBp: companySaleRecords.multiplierBp,
          companyBalanceAtSale: companySaleRecords.companyBalanceAtSale,
          saleType: companySaleRecords.saleType,
          txRef: companySaleRecords.txRef,
          createdAt: companySaleRecords.createdAt,
          _at: cursorAtColumn(companySaleRecords.createdAt),
          _id: companySaleRecords.id,
        })
        .from(companySaleRecords)
        .where(allOf(conditions))
        .orderBy(asc(companySaleRecords.createdAt), asc(companySaleRecords.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "loans",
    label: "Loans",
    description: "Every loan application and its frozen terms.",
    scopes: ["GOVERNMENT", "COMPANY"],
    columns: [
      "loanNumber",
      "companyId",
      "status",
      "requestedAmount",
      "principal",
      "interestRateBp",
      "totalPayable",
      "principalPaid",
      "interestPaid",
      "instalmentCount",
      "createdAt",
      "disbursedAt",
      "completedAt",
      "defaultedAt",
      "purpose",
    ],
    supports: ["from", "to", "status", "minAmount", "maxAmount", "company"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "COMPANY") {
        conditions.push(eq(loans.companyId, scope.companyId));
      } else if (f.company) {
        const named = await resolveNamedParties(f);
        conditions.push(eq(loans.companyId, named.companyId!));
      }
      conditions.push(
        f.status ? sql`${loans.status}::text = ${f.status}` : undefined,
        ...dateRange(loans.createdAt as never, f),
        ...amountRange(loans.requestedAmount as never, f),
        afterCursor(loans.createdAt as never, loans.id as never, cursor),
      );
      const rows = await db
        .select({
          loanNumber: loans.loanNumber,
          companyId: loans.companyId,
          status: loans.status,
          requestedAmount: loans.requestedAmount,
          principal: loans.principal,
          interestRateBp: loans.interestRateBp,
          totalPayable: loans.totalPayable,
          principalPaid: loans.principalPaid,
          interestPaid: loans.interestPaid,
          instalmentCount: loans.instalmentCount,
          createdAt: loans.createdAt,
          disbursedAt: loans.disbursedAt,
          completedAt: loans.completedAt,
          defaultedAt: loans.defaultedAt,
          purpose: loans.purpose,
          _at: cursorAtColumn(loans.createdAt),
          _id: loans.id,
        })
        .from(loans)
        .where(allOf(conditions))
        .orderBy(asc(loans.createdAt), asc(loans.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "loan-repayments",
    label: "Loan repayments",
    description: "Every instalment payment, with its principal/interest split.",
    scopes: ["GOVERNMENT", "COMPANY"],
    columns: [
      "id",
      "loanId",
      "instalmentId",
      "amount",
      "principalPaid",
      "interestPaid",
      "remainingBalance",
      "txRef",
      "paidByUserId",
      "createdAt",
    ],
    supports: ["from", "to", "minAmount", "maxAmount", "company"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "COMPANY") {
        conditions.push(
          inArray(
            loanPayments.loanId,
            db.select({ id: loans.id }).from(loans).where(eq(loans.companyId, scope.companyId)),
          ),
        );
      } else if (f.company) {
        const named = await resolveNamedParties(f);
        conditions.push(
          inArray(
            loanPayments.loanId,
            db.select({ id: loans.id }).from(loans).where(eq(loans.companyId, named.companyId!)),
          ),
        );
      }
      conditions.push(
        ...dateRange(loanPayments.createdAt as never, f),
        ...amountRange(loanPayments.amount as never, f),
        afterCursor(loanPayments.createdAt as never, loanPayments.id as never, cursor),
      );
      const rows = await db
        .select({
          id: loanPayments.id,
          loanId: loanPayments.loanId,
          instalmentId: loanPayments.instalmentId,
          amount: loanPayments.amount,
          principalPaid: loanPayments.principalPaid,
          interestPaid: loanPayments.interestPaid,
          remainingBalance: loanPayments.remainingBalance,
          txRef: loanPayments.txRef,
          paidByUserId: loanPayments.paidByUserId,
          createdAt: loanPayments.createdAt,
          _at: cursorAtColumn(loanPayments.createdAt),
          _id: loanPayments.id,
        })
        .from(loanPayments)
        .where(allOf(conditions))
        .orderBy(asc(loanPayments.createdAt), asc(loanPayments.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "invoices",
    label: "Invoices",
    description: "Invoices issued and received, with tax and settlement reference.",
    scopes: ["GOVERNMENT", "USER", "COMPANY"],
    columns: [
      "invoiceNumber",
      "companyId",
      "recipientType",
      "buyerUserId",
      "recipientCompanyId",
      "sourceOrderId",
      "itemName",
      "quantity",
      "unitPrice",
      "subtotal",
      "taxRateBp",
      "taxAmount",
      "total",
      "status",
      "createdAt",
      "dueAt",
      "paidAt",
      "paidTxRef",
      "description",
      "note",
    ],
    supports: ["from", "to", "status", "minAmount", "maxAmount", "user", "company"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "USER") {
        // A user sees invoices addressed to them. Users do not issue invoices.
        conditions.push(eq(invoices.buyerUserId, scope.userId));
      } else if (scope.kind === "COMPANY") {
        // Both directions: the ones this company sent and the ones it owes.
        conditions.push(
          or(
            eq(invoices.companyId, scope.companyId),
            eq(invoices.recipientCompanyId, scope.companyId),
          ),
        );
      } else {
        const named = await resolveNamedParties(f);
        if (named.userId) conditions.push(eq(invoices.buyerUserId, named.userId));
        if (named.companyId) {
          conditions.push(
            or(
              eq(invoices.companyId, named.companyId),
              eq(invoices.recipientCompanyId, named.companyId),
            ),
          );
        }
      }
      conditions.push(
        f.status ? sql`${invoices.status}::text = ${f.status}` : undefined,
        ...dateRange(invoices.createdAt as never, f),
        ...amountRange(invoices.total as never, f),
        afterCursor(invoices.createdAt as never, invoices.id as never, cursor),
      );
      const rows = await db
        .select({
          invoiceNumber: invoices.invoiceNumber,
          companyId: invoices.companyId,
          recipientType: invoices.recipientType,
          buyerUserId: invoices.buyerUserId,
          recipientCompanyId: invoices.recipientCompanyId,
          sourceOrderId: invoices.sourceOrderId,
          itemName: invoices.itemName,
          quantity: invoices.quantity,
          unitPrice: invoices.unitPrice,
          subtotal: invoices.subtotal,
          taxRateBp: invoices.taxRateBp,
          taxAmount: invoices.taxAmount,
          total: invoices.total,
          status: invoices.status,
          createdAt: invoices.createdAt,
          dueAt: invoices.dueAt,
          paidAt: invoices.paidAt,
          paidTxRef: invoices.paidTxRef,
          description: invoices.description,
          note: invoices.note,
          _at: cursorAtColumn(invoices.createdAt),
          _id: invoices.id,
        })
        .from(invoices)
        .where(allOf(conditions))
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "orders",
    label: "Market orders",
    description: "Marketplace orders with their snapshot prices and lifecycle timestamps.",
    scopes: ["GOVERNMENT", "USER", "COMPANY"],
    columns: [
      "orderNumber",
      "offerId",
      "sellerCompanyId",
      "buyerType",
      "buyerUserId",
      "buyerCompanyId",
      "quantity",
      "unitPrice",
      "subtotal",
      "status",
      "invoiceId",
      "createdAt",
      "acceptedAt",
      "paidAt",
      "completedAt",
      "cancelledAt",
      "expiresAt",
      "cancelReason",
    ],
    supports: ["from", "to", "status", "minAmount", "maxAmount", "user", "company"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "USER") {
        conditions.push(eq(marketplaceOrders.buyerUserId, scope.userId));
      } else if (scope.kind === "COMPANY") {
        conditions.push(
          or(
            eq(marketplaceOrders.sellerCompanyId, scope.companyId),
            eq(marketplaceOrders.buyerCompanyId, scope.companyId),
          ),
        );
      } else {
        const named = await resolveNamedParties(f);
        if (named.userId) conditions.push(eq(marketplaceOrders.buyerUserId, named.userId));
        if (named.companyId) {
          conditions.push(
            or(
              eq(marketplaceOrders.sellerCompanyId, named.companyId),
              eq(marketplaceOrders.buyerCompanyId, named.companyId),
            ),
          );
        }
      }
      conditions.push(
        f.status ? sql`${marketplaceOrders.status}::text = ${f.status}` : undefined,
        ...dateRange(marketplaceOrders.createdAt as never, f),
        ...amountRange(marketplaceOrders.subtotal as never, f),
        afterCursor(marketplaceOrders.createdAt as never, marketplaceOrders.id as never, cursor),
      );
      const rows = await db
        .select({
          orderNumber: marketplaceOrders.orderNumber,
          offerId: marketplaceOrders.offerId,
          sellerCompanyId: marketplaceOrders.sellerCompanyId,
          buyerType: marketplaceOrders.buyerType,
          buyerUserId: marketplaceOrders.buyerUserId,
          buyerCompanyId: marketplaceOrders.buyerCompanyId,
          quantity: marketplaceOrders.quantity,
          unitPrice: marketplaceOrders.unitPrice,
          subtotal: marketplaceOrders.subtotal,
          status: marketplaceOrders.status,
          invoiceId: marketplaceOrders.invoiceId,
          createdAt: marketplaceOrders.createdAt,
          acceptedAt: marketplaceOrders.acceptedAt,
          paidAt: marketplaceOrders.paidAt,
          completedAt: marketplaceOrders.completedAt,
          cancelledAt: marketplaceOrders.cancelledAt,
          expiresAt: marketplaceOrders.expiresAt,
          cancelReason: marketplaceOrders.cancelReason,
          _at: cursorAtColumn(marketplaceOrders.createdAt),
          _id: marketplaceOrders.id,
        })
        .from(marketplaceOrders)
        .where(allOf(conditions))
        .orderBy(asc(marketplaceOrders.createdAt), asc(marketplaceOrders.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "marketplace",
    label: "Market listings",
    description: "Every marketplace listing, its price and its availability.",
    scopes: ["GOVERNMENT", "COMPANY"],
    columns: [
      "id",
      "companyId",
      "title",
      "category",
      "unitPrice",
      "quantityAvailable",
      "status",
      "createdAt",
      "pausedAt",
      "closedAt",
      "description",
    ],
    supports: ["from", "to", "status", "minAmount", "maxAmount", "company", "entity"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "COMPANY") {
        conditions.push(eq(marketplaceOffers.companyId, scope.companyId));
      } else if (f.company) {
        const named = await resolveNamedParties(f);
        conditions.push(eq(marketplaceOffers.companyId, named.companyId!));
      }
      conditions.push(
        f.status ? sql`${marketplaceOffers.status}::text = ${f.status}` : undefined,
        f.entity ? ilike(marketplaceOffers.title, `%${f.entity}%`) : undefined,
        ...dateRange(marketplaceOffers.createdAt as never, f),
        ...amountRange(marketplaceOffers.unitPrice as never, f),
        afterCursor(marketplaceOffers.createdAt as never, marketplaceOffers.id as never, cursor),
      );
      const rows = await db
        .select({
          id: marketplaceOffers.id,
          companyId: marketplaceOffers.companyId,
          title: marketplaceOffers.title,
          category: marketplaceOffers.category,
          unitPrice: marketplaceOffers.unitPrice,
          quantityAvailable: marketplaceOffers.quantityAvailable,
          status: marketplaceOffers.status,
          createdAt: marketplaceOffers.createdAt,
          pausedAt: marketplaceOffers.pausedAt,
          closedAt: marketplaceOffers.closedAt,
          description: marketplaceOffers.description,
          _at: cursorAtColumn(marketplaceOffers.createdAt),
          _id: marketplaceOffers.id,
        })
        .from(marketplaceOffers)
        .where(allOf(conditions))
        .orderBy(asc(marketplaceOffers.createdAt), asc(marketplaceOffers.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "audit",
    label: "Government audit log",
    description: "Administrative actions, with before/after values and reasons.",
    scopes: GOVERNMENT_ONLY,
    columns: [
      "id",
      "action",
      "actorType",
      "actorLabel",
      "targetType",
      "targetId",
      "previousValue",
      "newValue",
      "reason",
      "metadata",
      "archivedAt",
      "createdAt",
    ],
    supports: ["from", "to", "type", "entity"],
    async fetchPage(_scope, f, cursor, limit) {
      const conditions = [
        f.type ? eq(auditLogs.action, f.type) : undefined,
        f.entity ? ilike(auditLogs.actorLabel, `%${f.entity}%`) : undefined,
        ...dateRange(auditLogs.createdAt as never, f),
        afterCursor(auditLogs.createdAt as never, auditLogs.id as never, cursor),
      ];
      const rows = await db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          actorType: auditLogs.actorType,
          actorLabel: auditLogs.actorLabel,
          targetType: auditLogs.targetType,
          targetId: auditLogs.targetId,
          previousValue: auditLogs.previousValue,
          newValue: auditLogs.newValue,
          reason: auditLogs.reason,
          metadata: auditLogs.metadata,
          archivedAt: auditLogs.archivedAt,
          createdAt: auditLogs.createdAt,
          _at: cursorAtColumn(auditLogs.createdAt),
          _id: auditLogs.id,
        })
        .from(auditLogs)
        .where(allOf(conditions))
        .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "users",
    label: "Users",
    description: "Accounts, balances and status. Never includes a password hash.",
    scopes: GOVERNMENT_ONLY,
    columns: [
      "id",
      "username",
      "displayName",
      "balance",
      "status",
      "createdAt",
      "suspendedUntil",
      "bannedAt",
      "isOfficialGovernmentUser",
      "isGovernmentMember",
    ],
    supports: ["from", "to", "status", "minAmount", "maxAmount", "user", "entity"],
    async fetchPage(_scope, f, cursor, limit) {
      const conditions = [
        f.status ? sql`${users.status}::text = ${f.status}` : undefined,
        f.user ? eq(users.username, f.user) : undefined,
        f.entity ? ilike(users.displayName, `%${f.entity}%`) : undefined,
        ...dateRange(users.createdAt as never, f),
        ...amountRange(users.balance as never, f),
        afterCursor(users.createdAt as never, users.id as never, cursor),
      ];
      const rows = await db
        .select({
          // `passwordHash` is deliberately not named here, and there is no
          // `select *` anywhere in this file that could reintroduce it.
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          balance: users.balance,
          status: users.status,
          createdAt: users.createdAt,
          suspendedUntil: users.suspendedUntil,
          bannedAt: users.bannedAt,
          isOfficialGovernmentUser: users.isOfficialGovernmentUser,
          isGovernmentMember: users.isGovernmentMember,
          _at: cursorAtColumn(users.createdAt),
          _id: users.id,
        })
        .from(users)
        .where(allOf(conditions))
        .orderBy(asc(users.createdAt), asc(users.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "companies",
    label: "Companies",
    description: "Every company, its status, balance and tax position.",
    scopes: GOVERNMENT_ONLY,
    columns: [
      "id",
      "username",
      "name",
      "category",
      "status",
      "balance",
      "ownerUserId",
      "governmentOwned",
      "taxRateBp",
      "strikes",
      "createdAt",
      "reviewedAt",
      "description",
    ],
    supports: ["from", "to", "status", "minAmount", "maxAmount", "company", "entity"],
    async fetchPage(_scope, f, cursor, limit) {
      const conditions = [
        f.status ? sql`${companies.status}::text = ${f.status}` : undefined,
        f.company ? eq(companies.username, f.company) : undefined,
        f.entity ? ilike(companies.name, `%${f.entity}%`) : undefined,
        ...dateRange(companies.createdAt as never, f),
        ...amountRange(companies.balance as never, f),
        afterCursor(companies.createdAt as never, companies.id as never, cursor),
      ];
      const rows = await db
        .select({
          id: companies.id,
          username: companies.username,
          name: companies.name,
          category: companies.category,
          status: companies.status,
          balance: companies.balance,
          ownerUserId: companies.ownerUserId,
          governmentOwned: companies.governmentOwned,
          taxRateBp: companies.taxRateBp,
          strikes: companies.strikes,
          createdAt: companies.createdAt,
          reviewedAt: companies.reviewedAt,
          description: companies.description,
          _at: cursorAtColumn(companies.createdAt),
          _id: companies.id,
        })
        .from(companies)
        .where(allOf(conditions))
        .orderBy(asc(companies.createdAt), asc(companies.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "support",
    label: "Support records",
    description:
      "Support messages still inside the retention window. Messages past it are gone from the database, so they are absent here too.",
    scopes: GOVERNMENT_ONLY,
    columns: ["id", "threadId", "threadStatus", "userUsername", "senderType", "senderLabel", "body", "createdAt"],
    supports: ["from", "to", "status", "user", "entity"],
    async fetchPage(_scope, f, cursor, limit) {
      const named = await resolveNamedParties(f);
      const conditions = [
        f.status ? sql`${supportThreads.status}::text = ${f.status}` : undefined,
        named.userId ? eq(supportThreads.userId, named.userId) : undefined,
        f.entity ? ilike(supportMessages.senderLabel, `%${f.entity}%`) : undefined,
        ...dateRange(supportMessages.createdAt as never, f),
        afterCursor(supportMessages.createdAt as never, supportMessages.id as never, cursor),
      ];
      const rows = await db
        .select({
          id: supportMessages.id,
          threadId: supportMessages.threadId,
          threadStatus: supportThreads.status,
          userUsername: users.username,
          senderType: supportMessages.senderType,
          senderLabel: supportMessages.senderLabel,
          body: supportMessages.body,
          createdAt: supportMessages.createdAt,
          _at: cursorAtColumn(supportMessages.createdAt),
          _id: supportMessages.id,
        })
        .from(supportMessages)
        .innerJoin(supportThreads, eq(supportThreads.id, supportMessages.threadId))
        .leftJoin(users, eq(users.id, supportThreads.userId))
        .where(allOf(conditions))
        .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "exchange-purchases",
    label: "Aeros Exchange purchases",
    description:
      "Exchange package acquisition requests, frozen policy snapshots, payment mode and credit references.",
    scopes: ["GOVERNMENT", "USER"],
    columns: [
      "purchaseNumber",
      "userId",
      "policyCodeSnapshot",
      "policyVersionSnapshot",
      "packageTitleSnapshot",
      "inrPriceSnapshot",
      "aerosAmountSnapshot",
      "bonusAerosSnapshot",
      "totalAerosSnapshot",
      "paymentMode",
      "paymentReference",
      "status",
      "creditedTxRef",
      "reviewNote",
      "createdAt",
      "creditedAt",
      "cancelledAt",
      "refundedAt",
    ],
    supports: ["from", "to", "status", "minAmount", "maxAmount", "user"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "USER") {
        conditions.push(eq(exchangePurchases.userId, scope.userId));
      } else if (f.user) {
        const named = await resolveNamedParties(f);
        if (named.userId) conditions.push(eq(exchangePurchases.userId, named.userId));
      }
      conditions.push(
        f.status ? sql`${exchangePurchases.status}::text = ${f.status}` : undefined,
        ...dateRange(exchangePurchases.createdAt as never, f),
        ...amountRange(exchangePurchases.totalAerosSnapshot as never, f),
        afterCursor(exchangePurchases.createdAt as never, exchangePurchases.id as never, cursor),
      );
      const rows = await db
        .select({
          purchaseNumber: exchangePurchases.purchaseNumber,
          userId: exchangePurchases.userId,
          policyCodeSnapshot: exchangePurchases.policyCodeSnapshot,
          policyVersionSnapshot: exchangePurchases.policyVersionSnapshot,
          packageTitleSnapshot: exchangePurchases.packageTitleSnapshot,
          inrPriceSnapshot: exchangePurchases.inrPriceSnapshot,
          aerosAmountSnapshot: exchangePurchases.aerosAmountSnapshot,
          bonusAerosSnapshot: exchangePurchases.bonusAerosSnapshot,
          totalAerosSnapshot: exchangePurchases.totalAerosSnapshot,
          paymentMode: exchangePurchases.paymentMode,
          paymentReference: exchangePurchases.paymentReference,
          status: exchangePurchases.status,
          creditedTxRef: exchangePurchases.creditedTxRef,
          reviewNote: exchangePurchases.reviewNote,
          createdAt: exchangePurchases.createdAt,
          creditedAt: exchangePurchases.creditedAt,
          cancelledAt: exchangePurchases.cancelledAt,
          refundedAt: exchangePurchases.refundedAt,
          _at: cursorAtColumn(exchangePurchases.createdAt),
          _id: exchangePurchases.id,
        })
        .from(exchangePurchases)
        .where(allOf(conditions))
        .orderBy(asc(exchangePurchases.createdAt), asc(exchangePurchases.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "synthetic-market-orders",
    label: "Synthetic market trades",
    description:
      "Executed BUY and SELL orders on the internal Aeros Market Index, with execution price and P/L.",
    scopes: ["GOVERNMENT", "USER"],
    columns: [
      "orderNumber",
      "userId",
      "side",
      "quantity",
      "expectedPrice",
      "executionPrice",
      "totalAeros",
      "costBasisDelta",
      "realizedPnlDelta",
      "status",
      "txRef",
      "methodologyVersion",
      "createdAt",
    ],
    supports: ["from", "to", "type", "status", "minAmount", "maxAmount", "user"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "USER") {
        conditions.push(eq(marketOrders.userId, scope.userId));
      } else if (f.user) {
        const named = await resolveNamedParties(f);
        if (named.userId) conditions.push(eq(marketOrders.userId, named.userId));
      }
      conditions.push(
        f.type ? sql`${marketOrders.side}::text = ${f.type}` : undefined,
        f.status ? sql`${marketOrders.status}::text = ${f.status}` : undefined,
        ...dateRange(marketOrders.createdAt as never, f),
        ...amountRange(marketOrders.totalAeros as never, f),
        afterCursor(marketOrders.createdAt as never, marketOrders.id as never, cursor),
      );
      const rows = await db
        .select({
          orderNumber: marketOrders.orderNumber,
          userId: marketOrders.userId,
          side: marketOrders.side,
          quantity: marketOrders.quantity,
          expectedPrice: marketOrders.expectedPrice,
          executionPrice: marketOrders.executionPrice,
          totalAeros: marketOrders.totalAeros,
          costBasisDelta: marketOrders.costBasisDelta,
          realizedPnlDelta: marketOrders.realizedPnlDelta,
          status: marketOrders.status,
          txRef: marketOrders.txRef,
          methodologyVersion: marketOrders.methodologyVersion,
          createdAt: marketOrders.createdAt,
          _at: cursorAtColumn(marketOrders.createdAt),
          _id: marketOrders.id,
        })
        .from(marketOrders)
        .where(allOf(conditions))
        .orderBy(asc(marketOrders.createdAt), asc(marketOrders.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "refund-requests",
    label: "Refund requests",
    description:
      "User refund requests, delay reasons, Government decisions and virtual Aeros settlement references.",
    scopes: ["GOVERNMENT", "USER"],
    columns: [
      "refundNumber",
      "userId",
      "refundType",
      "sourceTxRef",
      "exchangePurchaseId",
      "requestedAerosAmount",
      "approvedAerosAmount",
      "inrReferenceAmount",
      "status",
      "settlementTxRef",
      "reason",
      "userNotes",
      "governmentDecisionNote",
      "delayReason",
      "expectedResolutionAt",
      "createdAt",
      "completedAt",
      "rejectedAt",
    ],
    supports: ["from", "to", "type", "status", "minAmount", "maxAmount", "user"],
    async fetchPage(scope, f, cursor, limit) {
      const conditions: (SQL | undefined)[] = [];
      if (scope.kind === "USER") {
        conditions.push(eq(refundRequests.userId, scope.userId));
      } else if (f.user) {
        const named = await resolveNamedParties(f);
        if (named.userId) conditions.push(eq(refundRequests.userId, named.userId));
      }
      conditions.push(
        f.type ? sql`${refundRequests.refundType}::text = ${f.type}` : undefined,
        f.status ? sql`${refundRequests.status}::text = ${f.status}` : undefined,
        ...dateRange(refundRequests.createdAt as never, f),
        ...amountRange(refundRequests.requestedAerosAmount as never, f),
        afterCursor(refundRequests.createdAt as never, refundRequests.id as never, cursor),
      );
      const rows = await db
        .select({
          refundNumber: refundRequests.refundNumber,
          userId: refundRequests.userId,
          refundType: refundRequests.refundType,
          sourceTxRef: refundRequests.sourceTxRef,
          exchangePurchaseId: refundRequests.exchangePurchaseId,
          requestedAerosAmount: refundRequests.requestedAerosAmount,
          approvedAerosAmount: refundRequests.approvedAerosAmount,
          inrReferenceAmount: refundRequests.inrReferenceAmount,
          status: refundRequests.status,
          settlementTxRef: refundRequests.settlementTxRef,
          reason: refundRequests.reason,
          userNotes: refundRequests.userNotes,
          governmentDecisionNote: refundRequests.governmentDecisionNote,
          delayReason: refundRequests.delayReason,
          expectedResolutionAt: refundRequests.expectedResolutionAt,
          createdAt: refundRequests.createdAt,
          completedAt: refundRequests.completedAt,
          rejectedAt: refundRequests.rejectedAt,
          _at: cursorAtColumn(refundRequests.createdAt),
          _id: refundRequests.id,
        })
        .from(refundRequests)
        .where(allOf(conditions))
        .orderBy(asc(refundRequests.createdAt), asc(refundRequests.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
  {
    key: "accounting-checkpoints",
    label: "Accounting checkpoints",
    description:
      "Immutable period checkpoints preserving cumulative volumes and supply invariants across cleared archives.",
    scopes: GOVERNMENT_ONLY,
    columns: [
      "checkpointNumber",
      "archiveBatchId",
      "periodStart",
      "periodEnd",
      "clearedTxCount",
      "grossVolumeCleared",
      "taxVolumeCleared",
      "netVolumeCleared",
      "totalSupplySnapshot",
      "retiredSupplySnapshot",
      "treasuryBalanceSnapshot",
      "userHeldBalanceSnapshot",
      "companyHeldBalanceSnapshot",
      "checkpointHash",
      "createdAt",
    ],
    supports: ["from", "to"],
    async fetchPage(_scope, f, cursor, limit) {
      const conditions = [
        ...dateRange(accountingCheckpoints.createdAt as never, f),
        afterCursor(
          accountingCheckpoints.createdAt as never,
          accountingCheckpoints.id as never,
          cursor,
        ),
      ];
      const rows = await db
        .select({
          checkpointNumber: accountingCheckpoints.checkpointNumber,
          archiveBatchId: accountingCheckpoints.archiveBatchId,
          periodStart: accountingCheckpoints.periodStart,
          periodEnd: accountingCheckpoints.periodEnd,
          clearedTxCount: accountingCheckpoints.clearedTxCount,
          grossVolumeCleared: accountingCheckpoints.grossVolumeCleared,
          taxVolumeCleared: accountingCheckpoints.taxVolumeCleared,
          netVolumeCleared: accountingCheckpoints.netVolumeCleared,
          totalSupplySnapshot: accountingCheckpoints.totalSupplySnapshot,
          retiredSupplySnapshot: accountingCheckpoints.retiredSupplySnapshot,
          treasuryBalanceSnapshot: accountingCheckpoints.treasuryBalanceSnapshot,
          userHeldBalanceSnapshot: accountingCheckpoints.userHeldBalanceSnapshot,
          companyHeldBalanceSnapshot: accountingCheckpoints.companyHeldBalanceSnapshot,
          checkpointHash: accountingCheckpoints.checkpointHash,
          createdAt: accountingCheckpoints.createdAt,
          _at: cursorAtColumn(accountingCheckpoints.createdAt),
          _id: accountingCheckpoints.id,
        })
        .from(accountingCheckpoints)
        .where(allOf(conditions))
        .orderBy(asc(accountingCheckpoints.createdAt), asc(accountingCheckpoints.id))
        .limit(limit);
      return { rows, next: cursorFrom(rows) };
    },
  },
];

const DATASETS_BY_KEY = new Map(DATASETS.map((d) => [d.key, d]));

export const EXPORT_DATASETS: readonly ExportDataset[] = DATASETS;

export function datasetsForScope(kind: ExportScope["kind"]): ExportDataset[] {
  return DATASETS.filter((d) => d.scopes.includes(kind));
}

/**
 * Looks up a dataset FOR A SCOPE.
 *
 * The scope is part of the lookup, not a check performed afterwards, so there
 * is no window in which a handler holds a dataset it is not entitled to read.
 * An unknown key and a forbidden key produce the same error, so the endpoint
 * does not enumerate the Government's datasets to a logged-in user.
 */
export function getDataset(key: string, kind: ExportScope["kind"]): ExportDataset {
  const dataset = DATASETS_BY_KEY.get(key);
  if (!dataset || !dataset.scopes.includes(kind)) {
    throw new ExportError(`Unknown export: ${key}`);
  }
  return dataset;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type ExportFormat = "csv" | "json";

export function parseFormat(raw: string | null): ExportFormat {
  return raw?.toLowerCase() === "json" ? "json" : "csv";
}

/**
 * Rows fetched per database round trip.
 *
 * This number IS the memory bound: at any instant the process holds one page
 * of rows plus the bytes of one page's worth of text. It is not a performance
 * tuning knob to raise casually — 500 rows of ledger is tens of kilobytes,
 * which is the point.
 */
export const EXPORT_PAGE_SIZE = 500;

/** Drops the internal cursor columns before a row is serialised. */
function publicRow(row: ExportRow, columns: readonly string[]): ExportRow {
  const out: ExportRow = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

/**
 * Turns a dataset into a byte stream.
 *
 * The generator shape matters: `pull` is called by the platform only when the
 * consumer is ready for more, so a slow client applies backpressure all the
 way to the database instead of filling a buffer here. Nothing accumulates —
 * each page is encoded, enqueued and released.
 */
export function streamExport(
  dataset: ExportDataset,
  scope: ExportScope,
  filters: ExportFilters,
  format: ExportFormat,
  opts: { pageSize?: number; generatedAt?: Date } = {},
): ReadableStream<Uint8Array> {
  const pageSize = opts.pageSize ?? EXPORT_PAGE_SIZE;
  const encoder = new TextEncoder();
  const generatedAt = opts.generatedAt ?? new Date();

  let cursor: ExportCursor = null;
  let started = false;
  let finished = false;
  let rowCount = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          if (format === "csv") {
            controller.enqueue(encoder.encode(UTF8_BOM + csvHeader(dataset.columns)));
          } else {
            controller.enqueue(
              encoder.encode(
                `{"dataset":${JSON.stringify(dataset.key)},` +
                  `"generatedAt":${JSON.stringify(generatedAt.toISOString())},` +
                  `"scope":${JSON.stringify(scope.kind)},` +
                  `"filters":${JSON.stringify(describeFilters(filters))},` +
                  `"columns":${JSON.stringify(dataset.columns)},` +
                  `"rows":[`,
              ),
            );
          }
          return;
        }

        /** Emits the JSON envelope's tail (CSV needs none) and ends. */
        const finish = () => {
          if (format === "json") {
            controller.enqueue(encoder.encode(`],"rowCount":${rowCount}}`));
          }
          controller.close();
        };

        if (finished) {
          finish();
          return;
        }

        const page = await dataset.fetchPage(scope, filters, cursor, pageSize);

        if (page.rows.length === 0) {
          finished = true;
          finish();
          return;
        }

        let chunk = "";
        for (const row of page.rows) {
          const shaped = publicRow(row, dataset.columns);
          if (format === "csv") {
            chunk += csvRow(dataset.columns.map((c) => shaped[c]));
          } else {
            chunk += (rowCount === 0 ? "" : ",") + JSON.stringify(shaped, jsonReplacer);
          }
          rowCount++;
        }
        controller.enqueue(encoder.encode(chunk));

        // BACKSTOP: a cursor that did not advance would page the same rows
        // forever. That is exactly what a truncated timestamp used to do here
        // (see ExportCursor), and it is the failure mode a streaming export
        // must never have — an endless response is worse than a wrong one.
        // The condition should be impossible; the check costs nothing.
        if (page.next && cursor && page.next.at === cursor.at && page.next.id === cursor.id) {
          finished = true;
          finish();
          return;
        }

        cursor = page.next;
        // A short page means the table is exhausted; the next pull closes.
        if (page.rows.length < pageSize) finished = true;
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/** Dates become ISO strings; everything else is left exactly as the database
 * returned it, so the JSON export is lossless (unlike CSV, which guards text
 * for spreadsheet safety). */
function jsonReplacer(_key: string, value: unknown): unknown {
  return value;
}

export function exportFilename(datasetKey: string, format: ExportFormat, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replaceAll(":", "").replace("T", "-");
  return `aeros-${datasetKey}-${stamp}.${format}`;
}

export function exportHeaders(datasetKey: string, format: ExportFormat, at = new Date()): HeadersInit {
  return {
    "content-type":
      format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${exportFilename(datasetKey, format, at)}"`,
    // An export is a live snapshot of private data. It is never cached, by
    // the browser or by anything in between.
    "cache-control": "no-store, max-age=0",
    "x-content-type-options": "nosniff",
  };
}
