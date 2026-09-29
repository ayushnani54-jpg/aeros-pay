import "server-only";
import { db } from "@/db/client";
import { reconciliationStatus } from "@/db/schema";
import { eq, sql, type SQL } from "drizzle-orm";
import { istCalendarDayNumber } from "./datetime";

/**
 * "RUN HEALTH CHECK" — READ-ONLY RECONCILIATION (V3)
 * ===========================================================================
 *
 * Every check below is a QUERY. This module moves no Aeros, repairs nothing,
 * and writes nothing except — optionally, and only when you ask it to — one
 * latest-status row so the Government panel can show when the last check ran
 * and whether it passed.
 *
 * There is deliberately NO reconciliation history table. A reconciliation
 * result is derived data; storing snapshots of it would create a second,
 * stale source of truth about the ledger, and the ledger plus the audit log
 * already record everything a reviewer needs.
 *
 * Every check takes an `executor`, which may be `db` or an open transaction.
 * That is what makes the checks testable: a test can corrupt data inside a
 * transaction, run the checks against that same transaction, and roll back, so
 * a deliberately broken fixture never touches the real database.
 */

export type ReconcileSeverity = "CRITICAL" | "WARNING";

export type ReconcileCheck = {
  /** Stable machine key, safe to store and to switch on. */
  key: string;
  label: string;
  severity: ReconcileSeverity;
  passed: boolean;
  /** One human-readable sentence, whether it passed or failed. */
  detail: string;
  /** How many offending rows were found. */
  offenders: number;
  /** Up to five identifiers, so a reviewer can go and look. */
  examples: string[];
};

export type SupplyBreakdown = {
  totalSupply: number;
  treasury: number;
  userHeld: number;
  companyHeld: number;
  accounted: number;
  /** accounted - totalSupply. Zero when the economy balances. */
  difference: number;
};

export type ReconcileResult = {
  ranAt: Date;
  healthy: boolean;
  checksRun: number;
  checksFailed: number;
  checks: ReconcileCheck[];
  supply: SupplyBreakdown;
};

/** Anything that can run raw SQL — `db` or an open transaction. */
type Executor = Pick<typeof db, "execute">;

const EXAMPLE_LIMIT = 5;

/**
 * Runs a check query. Every query must project a single text column named
 * `id` identifying the offending row; an empty result means the check passed.
 */
async function findOffenders(executor: Executor, query: SQL): Promise<string[]> {
  const result = await executor.execute(query);
  const rows = (result as unknown as { rows: { id: unknown }[] }).rows ?? [];
  return rows.map((r) => String(r.id));
}

async function check(
  executor: Executor,
  spec: {
    key: string;
    label: string;
    severity: ReconcileSeverity;
    ok: string;
    bad: (count: number) => string;
    query: SQL;
  },
): Promise<ReconcileCheck> {
  const offenders = await findOffenders(executor, spec.query);
  return {
    key: spec.key,
    label: spec.label,
    severity: spec.severity,
    passed: offenders.length === 0,
    detail: offenders.length === 0 ? spec.ok : spec.bad(offenders.length),
    offenders: offenders.length,
    examples: offenders.slice(0, EXAMPLE_LIMIT),
  };
}

async function readSupply(executor: Executor): Promise<SupplyBreakdown> {
  const result = await executor.execute(sql`
    SELECT
      (SELECT coalesce(sum(total_supply), 0)::int FROM government) AS total_supply,
      (SELECT coalesce(sum(balance), 0)::int      FROM government) AS treasury,
      (SELECT coalesce(sum(balance), 0)::int      FROM users)      AS user_held,
      (SELECT coalesce(sum(balance), 0)::int      FROM companies)  AS company_held
  `);
  const row = (result as unknown as { rows: Record<string, number>[] }).rows[0] ?? {};
  const totalSupply = Number(row.total_supply ?? 0);
  const treasury = Number(row.treasury ?? 0);
  const userHeld = Number(row.user_held ?? 0);
  const companyHeld = Number(row.company_held ?? 0);
  const accounted = treasury + userHeld + companyHeld;
  return {
    totalSupply,
    treasury,
    userHeld,
    companyHeld,
    accounted,
    difference: accounted - totalSupply,
  };
}

/**
 * The IST daily-issuance check runs in TypeScript rather than SQL, because
 * "which IST calendar day is this instant on" must come from the one shared
 * primitive in src/lib/datetime.ts — duplicating that offset arithmetic in SQL
 * is exactly how two parts of a system end up disagreeing about midnight.
 */
async function checkIssuanceDailyLimit(executor: Executor): Promise<ReconcileCheck> {
  const govResult = await executor.execute(
    sql`SELECT coalesce(max(issuance_cooldown_days), 0)::int AS days FROM government`,
  );
  const cooldownDays = Number(
    (govResult as unknown as { rows: { days: number }[] }).rows[0]?.days ?? 0,
  );

  const base = {
    key: "ISSUANCE_DAILY_LIMIT",
    label: "Issuance respects the daily IST limit",
    severity: "CRITICAL" as const,
  };

  if (cooldownDays <= 0) {
    return {
      ...base,
      passed: true,
      detail: "No issuance cooldown is configured, so there is no daily limit to violate.",
      offenders: 0,
      examples: [],
    };
  }

  const result = await executor.execute(sql`
    SELECT id::text AS id, executed_at
    FROM issuance_requests
    WHERE status = 'EXECUTED' AND executed_at IS NOT NULL
    ORDER BY executed_at
  `);
  const rows =
    (result as unknown as { rows: { id: string; executed_at: string | Date }[] }).rows ?? [];

  const seenByDay = new Map<number, string>();
  const offenders: string[] = [];
  for (const row of rows) {
    const day = istCalendarDayNumber(row.executed_at);
    const first = seenByDay.get(day);
    if (first === undefined) {
      seenByDay.set(day, row.id);
    } else {
      offenders.push(row.id);
    }
  }

  return {
    ...base,
    passed: offenders.length === 0,
    detail:
      offenders.length === 0
        ? "At most one issuance was executed on any IST calendar day."
        : `${offenders.length} issuance(s) were executed on an IST calendar day that already had one.`,
    offenders: offenders.length,
    examples: offenders.slice(0, EXAMPLE_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// The health check
// ---------------------------------------------------------------------------

export async function runHealthCheck(executor: Executor = db): Promise<ReconcileResult> {
  const ranAt = new Date();
  const supply = await readSupply(executor);

  const supplyCheck: ReconcileCheck = {
    key: "SUPPLY_INVARIANT",
    label: "Total supply = treasury + user balances + company balances",
    severity: "CRITICAL",
    passed: supply.difference === 0,
    detail:
      supply.difference === 0
        ? `Balanced: ${supply.accounted.toLocaleString()} Aeros accounted for, against a recorded supply of ${supply.totalSupply.toLocaleString()}.`
        : `MISMATCH of ${supply.difference.toLocaleString()} Aeros: ${supply.accounted.toLocaleString()} accounted for against a recorded supply of ${supply.totalSupply.toLocaleString()}.`,
    offenders: supply.difference === 0 ? 0 : 1,
    examples: supply.difference === 0 ? [] : [`difference=${supply.difference}`],
  };

  const checks: ReconcileCheck[] = [supplyCheck];

  checks.push(
    await check(executor, {
      key: "NO_NEGATIVE_BALANCES",
      label: "No wallet holds a negative balance",
      severity: "CRITICAL",
      ok: "Every user, company and treasury balance is zero or positive.",
      bad: (n) => `${n} wallet(s) hold a negative balance.`,
      query: sql`
        SELECT 'user:'       || id::text AS id FROM users      WHERE balance < 0
        UNION ALL
        SELECT 'company:'    || id::text        FROM companies  WHERE balance < 0
        UNION ALL
        SELECT 'government:' || id::text        FROM government WHERE balance < 0
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_ORPHANED_WALLETS",
      label: "Every wallet belongs to something that exists",
      severity: "CRITICAL",
      ok: "Every company has an existing owner and every user an existing registration code.",
      bad: (n) => `${n} wallet(s) point at an owner or registration code that does not exist.`,
      query: sql`
        SELECT 'company:' || c.id::text AS id
        FROM companies c
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.owner_user_id)
        UNION ALL
        SELECT 'user:' || u.id::text
        FROM users u
        WHERE NOT EXISTS (
          SELECT 1 FROM registration_codes r WHERE r.id = u.registration_code_id
        )
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_ORPHANED_TRANSACTIONS",
      label: "Every ledger row names parties that exist",
      severity: "CRITICAL",
      ok: "Every transaction's sender, receiver and reversal target resolve to a real row.",
      bad: (n) => `${n} ledger row(s) name a party or reversal target that does not exist.`,
      // The Government is intentionally recorded with a NULL party id (that is
      // how every V1 row was written), so only USER and COMPANY parties are
      // required to resolve.
      query: sql`
        SELECT t.tx_ref AS id
        FROM transactions t
        WHERE (t.sender_type = 'USER'
                AND (t.sender_id IS NULL
                     OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.sender_id)))
           OR (t.sender_type = 'COMPANY'
                AND (t.sender_id IS NULL
                     OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.sender_id)))
           OR (t.receiver_type = 'USER'
                AND (t.receiver_id IS NULL
                     OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.receiver_id)))
           OR (t.receiver_type = 'COMPANY'
                AND (t.receiver_id IS NULL
                     OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.receiver_id)))
           OR (t.reverses_transaction_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM transactions o WHERE o.id = t.reverses_transaction_id))
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_CONTRADICTORY_COMPANY_OWNERS",
      label: "No company has contradictory ownership",
      severity: "CRITICAL",
      ok: "Government-owned flags agree with their timestamps, and every company's owner matches its latest sale record.",
      bad: (n) => `${n} company(ies) have contradictory ownership data.`,
      query: sql`
        SELECT 'company:' || id::text AS id
        FROM companies
        WHERE (government_owned AND government_acquired_at IS NULL)
           OR ((NOT government_owned) AND government_acquired_at IS NOT NULL)
        UNION ALL
        SELECT 'company:' || c.id::text
        FROM companies c
        JOIN (
          SELECT DISTINCT ON (company_id) company_id, buyer_user_id
          FROM company_sale_records
          ORDER BY company_id, created_at DESC
        ) latest ON latest.company_id = c.id
        WHERE (NOT c.government_owned) AND latest.buyer_user_id <> c.owner_user_id
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_PAID_INVOICE_WITHOUT_PAYMENT",
      label: "Every PAID invoice has a matching payment",
      severity: "CRITICAL",
      ok: "Every invoice marked PAID is backed by a ledger row for its exact total.",
      bad: (n) => `${n} invoice(s) are marked PAID without a valid linked payment.`,
      query: sql`
        SELECT i.invoice_number AS id
        FROM invoices i
        WHERE i.status = 'PAID'
          AND (i.paid_tx_ref IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM transactions t
                 WHERE t.tx_ref = i.paid_tx_ref
                   AND t.invoice_id = i.id
                   AND t.gross_amount = i.total))
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_DUPLICATE_INVOICE_PAYMENT",
      label: "No invoice was paid twice",
      severity: "CRITICAL",
      ok: "No invoice has more than one non-reversal payment against it.",
      bad: (n) => `${n} invoice(s) have more than one payment recorded.`,
      // Reversal rows are excluded: a refund legitimately references the same
      // invoice and must not look like a second payment.
      query: sql`
        SELECT i.invoice_number AS id
        FROM invoices i
        JOIN (
          SELECT invoice_id
          FROM transactions
          WHERE invoice_id IS NOT NULL AND reverses_transaction_id IS NULL
          GROUP BY invoice_id
          HAVING count(*) > 1
        ) dup ON dup.invoice_id = i.id
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_COMPANY_FUNDED_TWICE",
      label: "No company was funded twice on approval",
      severity: "CRITICAL",
      ok: "Every funded company has exactly one approval-funding ledger row.",
      bad: (n) => `${n} company(ies) have a funding record that does not add up.`,
      query: sql`
        SELECT c.username AS id
        FROM companies c
        JOIN (
          SELECT receiver_id, count(*) AS n
          FROM transactions
          WHERE type = 'COMPANY_FUNDING'
            AND receiver_type = 'COMPANY'
            AND reverses_transaction_id IS NULL
          GROUP BY receiver_id
          HAVING count(*) > 1
        ) dup ON dup.receiver_id = c.id
        UNION ALL
        SELECT c.username
        FROM companies c
        WHERE c.funded_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.type = 'COMPANY_FUNDING'
              AND t.receiver_type = 'COMPANY'
              AND t.receiver_id = c.id)
      `,
    }),
  );

  checks.push(await checkIssuanceDailyLimit(executor));

  checks.push(
    await check(executor, {
      key: "NO_IMPOSSIBLE_LOAN_REPAYMENT",
      label: "No loan has an impossible repayment record",
      severity: "CRITICAL",
      ok: "No loan is over-repaid, repaid before disbursement, or marked paid without a payment row.",
      bad: (n) => `${n} loan(s) have an impossible repayment record.`,
      query: sql`
        SELECT l.loan_number AS id
        FROM loans l
        WHERE (l.principal IS NOT NULL AND l.principal_paid > l.principal)
           OR (l.total_interest IS NOT NULL AND l.interest_paid > l.total_interest)
           OR (l.total_payable IS NOT NULL
                AND (l.principal_paid + l.interest_paid) > l.total_payable)
           OR (l.disbursed_at IS NULL
                AND EXISTS (SELECT 1 FROM loan_payments p WHERE p.loan_id = l.id))
        UNION ALL
        SELECT l.loan_number
        FROM loan_instalments i
        JOIN loans l ON l.id = i.loan_id
        WHERE i.status = 'PAID'
          AND (i.paid_tx_ref IS NULL
               OR NOT EXISTS (SELECT 1 FROM loan_payments p WHERE p.instalment_id = i.id))
        UNION ALL
        SELECT l.loan_number
        FROM loan_payments p
        JOIN loans l ON l.id = p.loan_id
        WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.tx_ref = p.tx_ref)
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_UNRECORDED_OWNERSHIP_TRANSFER",
      label: "Every ownership transfer has a sale record",
      severity: "CRITICAL",
      ok: "Every company purchase has a matching sale record, every sale record a matching ledger row, and every Government-held company an accepted Government offer.",
      bad: (n) => `${n} ownership transfer(s) are not backed by the records they require.`,
      query: sql`
        SELECT t.tx_ref AS id
        FROM transactions t
        WHERE t.type = 'COMPANY_SALE_PURCHASE'
          AND t.reverses_transaction_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM company_sale_records r WHERE r.tx_ref = t.tx_ref)
        UNION ALL
        SELECT r.tx_ref
        FROM company_sale_records r
        WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.tx_ref = r.tx_ref)
        UNION ALL
        SELECT 'company:' || c.id::text
        FROM companies c
        WHERE c.government_owned
          AND NOT EXISTS (
            SELECT 1 FROM company_sale_offers o
            WHERE o.company_id = c.id
              AND o.status = 'ACCEPTED'
              AND o.offeror_type = 'GOVERNMENT')
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_COMPLETED_ORDER_WITHOUT_PAYMENT",
      label: "No settled marketplace order claims a payment that does not exist",
      severity: "CRITICAL",
      ok: "Every PAID or COMPLETED order is backed by a paid invoice with a real ledger row.",
      bad: (n) => `${n} order(s) are marked paid or completed without a real payment.`,
      query: sql`
        SELECT o.order_number AS id
        FROM marketplace_orders o
        WHERE o.status IN ('PAID', 'COMPLETED')
          AND (o.invoice_id IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM invoices i
                 WHERE i.id = o.invoice_id
                   AND i.status = 'PAID'
                   AND i.paid_tx_ref IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM transactions t WHERE t.tx_ref = i.paid_tx_ref)))
      `,
    }),
  );

  // -------------------------------------------------------------------------
  // V3 INTEGRITY (Phase K) — orders, ratings, promotions, contracts
  //
  // Each of these restates, as a query, a rule that is enforced in one place
  // inside a transaction. They are not a second implementation of the rule:
  // they are a way of finding out whether the rule ever failed to hold, which
  // is the only thing a health check can honestly claim to do.
  // -------------------------------------------------------------------------

  checks.push(
    await check(executor, {
      key: "NO_RATING_WITHOUT_ELIGIBLE_ORDER",
      label: "Every rating belongs to an order its rater was entitled to rate",
      severity: "CRITICAL",
      ok: "Every rating is by the buyer of a COMPLETED, paid order, and names that order's own seller.",
      bad: (n) => `${n} rating(s) do not correspond to an order the rater could rate.`,
      // Four ways a rating could be wrong, and all four are rater/seller/status
      // facts that `rateOrder` derives from the order row under a lock.
      query: sql`
        SELECT r.id::text AS id
        FROM marketplace_order_ratings r
        LEFT JOIN marketplace_orders o ON o.id = r.order_id
        WHERE o.id IS NULL
           OR o.status <> 'COMPLETED'
           OR r.rated_company_id <> o.seller_company_id
           OR NOT (
                (r.rater_type = 'USER'    AND o.buyer_type = 'USER'
                   AND r.rater_user_id    IS NOT DISTINCT FROM o.buyer_user_id)
             OR (r.rater_type = 'COMPANY' AND o.buyer_type = 'COMPANY'
                   AND r.rater_company_id IS NOT DISTINCT FROM o.buyer_company_id)
              )
           OR o.invoice_id IS NULL
           OR NOT EXISTS (
                SELECT 1 FROM invoices i
                WHERE i.id = o.invoice_id AND i.status = 'PAID')
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "PROMOTION_SLOT_RESPECTED",
      label: "At most one promotion is ACTIVE, and every charge has a ledger row",
      severity: "CRITICAL",
      ok: "The single promotion slot holds at most one ACTIVE campaign, and no campaign claims Aeros it never paid.",
      bad: (n) => `${n} promotion problem(s) found with the single-slot rule or campaign charges.`,
      // The unique partial index makes two ACTIVE rows impossible, so this is
      // the belt to that index's braces — and it also catches a campaign whose
      // recorded spend has no PROMOTION_CHARGE rows behind it.
      query: sql`
        SELECT 'active-slot:' || count(*)::text AS id
        FROM promotion_campaigns
        WHERE status = 'ACTIVE'
        HAVING count(*) > 1
        UNION ALL
        SELECT 'campaign:' || c.id::text
        FROM promotion_campaigns c
        WHERE c.total_charged > 0
          AND c.company_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM transactions t
            WHERE t.type = 'PROMOTION_CHARGE'
              AND t.sender_type = 'COMPANY'
              AND t.sender_id = c.company_id)
        UNION ALL
        SELECT 'campaign:' || c.id::text
        FROM promotion_campaigns c
        WHERE c.status = 'ACTIVE' AND c.activated_at IS NULL
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_CONTRACT_AWARD_WITHOUT_RECORDS",
      label: "Every contract award and settlement has the records it requires",
      severity: "CRITICAL",
      ok: "Every awarded contract names an accepted application, every contract invoice exists, and every contract payment reference is a real ledger row.",
      bad: (n) => `${n} contract(s) are missing a record their state requires.`,
      query: sql`
        -- Awarded, but no accepted application to award it against, and no
        -- Government issuer (the Government awards from its own panel, which
        -- still writes an accepted application, so this holds for both).
        SELECT c.contract_number AS id
        FROM marketplace_contracts c
        WHERE c.status IN ('AWARDED', 'COMPLETED')
          AND NOT EXISTS (
            SELECT 1 FROM marketplace_contract_applications a
            WHERE a.contract_id = c.id AND a.status = 'ACCEPTED')
        UNION ALL
        -- Awarded to nobody, or awarded to a party that does not exist.
        SELECT c.contract_number
        FROM marketplace_contracts c
        WHERE c.status IN ('AWARDED', 'COMPLETED')
          AND (
               (c.awarded_to_type = 'USER'
                  AND (c.awarded_to_user_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.awarded_to_user_id)))
            OR (c.awarded_to_type = 'COMPANY'
                  AND (c.awarded_to_company_id IS NULL
                       OR NOT EXISTS (SELECT 1 FROM companies k WHERE k.id = c.awarded_to_company_id)))
            OR c.awarded_to_type IS NULL
          )
        UNION ALL
        -- Points at an invoice that does not exist.
        SELECT c.contract_number
        FROM marketplace_contracts c
        WHERE c.invoice_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = c.invoice_id)
        UNION ALL
        -- Claims a payment reference that is not in the ledger.
        SELECT c.contract_number
        FROM marketplace_contracts c
        WHERE c.paid_tx_ref IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.tx_ref = c.paid_tx_ref)
        UNION ALL
        -- Completed without either settlement route having happened.
        SELECT c.contract_number
        FROM marketplace_contracts c
        WHERE c.status = 'COMPLETED'
          AND c.paid_tx_ref IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM invoices i
            WHERE i.id = c.invoice_id AND i.status = 'PAID')
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "NO_ORPHANED_V3_ROWS",
      label: "Every V3 record points at something that exists",
      severity: "CRITICAL",
      ok: "Every order, application, response and campaign resolves to a real offer, contract, request, company and invoice.",
      bad: (n) => `${n} V3 row(s) reference a parent that does not exist.`,
      query: sql`
        SELECT 'order:' || o.order_number AS id
        FROM marketplace_orders o
        WHERE NOT EXISTS (SELECT 1 FROM marketplace_offers f WHERE f.id = o.offer_id)
           OR NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = o.seller_company_id)
           OR (o.invoice_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = o.invoice_id))
        UNION ALL
        SELECT 'offer:' || f.id::text
        FROM marketplace_offers f
        WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = f.company_id)
        UNION ALL
        SELECT 'application:' || a.id::text
        FROM marketplace_contract_applications a
        WHERE NOT EXISTS (
          SELECT 1 FROM marketplace_contracts c WHERE c.id = a.contract_id)
        UNION ALL
        SELECT 'wanted-response:' || r.id::text
        FROM marketplace_wanted_responses r
        WHERE NOT EXISTS (
          SELECT 1 FROM marketplace_wanted_requests w WHERE w.id = r.request_id)
        UNION ALL
        SELECT 'campaign:' || c.id::text
        FROM promotion_campaigns c
        WHERE (c.company_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM companies k WHERE k.id = c.company_id))
           OR (c.offer_id IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM marketplace_offers f WHERE f.id = c.offer_id))
      `,
    }),
  );

  checks.push(
    await check(executor, {
      key: "ORDER_SNAPSHOT_CONSISTENT",
      label: "Every order's frozen price still adds up",
      severity: "WARNING",
      ok: "Every order's subtotal equals its own snapshot of unit price times quantity, and every invoiced order's invoice agrees with it.",
      bad: (n) => `${n} order(s) have a subtotal that does not match their own snapshot.`,
      // An order snapshots the unit price at the moment it is placed precisely
      // so a later price change cannot alter it. If these ever disagree, the
      // figure a buyer agreed to and the figure they were billed have parted.
      query: sql`
        SELECT o.order_number AS id
        FROM marketplace_orders o
        WHERE o.subtotal <> (o.unit_price * o.quantity)
        UNION ALL
        SELECT o.order_number
        FROM marketplace_orders o
        JOIN invoices i ON i.id = o.invoice_id
        WHERE i.subtotal <> o.subtotal
      `,
    }),
  );

  const checksFailed = checks.filter((c) => !c.passed).length;

  return {
    ranAt,
    healthy: checksFailed === 0,
    checksRun: checks.length,
    checksFailed,
    checks,
    supply,
  };
}

// ---------------------------------------------------------------------------
// The single latest-status row (optional, and the only thing ever written)
// ---------------------------------------------------------------------------

/**
 * Overwrites the one latest-status row. There is no history: each save
 * replaces the previous summary. `singleton` plus its UNIQUE index make "at
 * most one row" a database guarantee, not a convention.
 */
export async function saveHealthCheckStatus(
  result: ReconcileResult,
  ranBy?: string | null,
): Promise<void> {
  const failed = result.checks.filter((c) => !c.passed);
  const values = {
    singleton: true,
    lastRunAt: result.ranAt,
    healthy: result.healthy,
    checksRun: result.checksRun,
    checksFailed: result.checksFailed,
    failedCheckKeys: failed.length > 0 ? failed.map((c) => c.key).join(",") : null,
    summary: result.healthy
      ? `All ${result.checksRun} checks passed.`
      : `${result.checksFailed} of ${result.checksRun} checks failed: ${failed
          .map((c) => c.label)
          .join("; ")}`,
    ranBy: ranBy ?? null,
  };

  await db
    .insert(reconciliationStatus)
    .values(values)
    .onConflictDoUpdate({ target: reconciliationStatus.singleton, set: values });
}

export async function getHealthCheckStatus() {
  const [row] = await db
    .select()
    .from(reconciliationStatus)
    .where(eq(reconciliationStatus.singleton, true))
    .limit(1);
  return row ?? null;
}
