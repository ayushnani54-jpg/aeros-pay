# Aeros Pay V4 — Production Upgrade, Neon Migration & Operations Guide

This guide covers everything required to upgrade an existing Aeros Pay V1–V3 deployment (or initialize a fresh instance) to **Aeros Pay V4**.

---

## 1. Architecture & Additive Upgrade Summary

Aeros Pay V4 is a strictly **additive upgrade**:
- **Preserves V1–V3 & Aeros Pay Lite**: All existing wallets, personal/company transfers, tax calculation, marketplace listings/orders/ratings, wanted requests, contracts, promotions, invoices, loans, IP complaints, support messages, notifications, updates, offline PWA cache, and `/lite` routes remain intact.
- **Fixes 3 Verified V1–V3 Audit Bugs**:
  1. [`src/app/gov/issuance/[id]/page.tsx`](src/app/gov/issuance/[id]/page.tsx): Fixed missing `Math.floor(...)` on the Government issuance approve page (`fee = Math.floor((req.amount * gov.issuanceFeeRateBp) / 10_000)`), eliminating fractional Aeros display when `amount * feeRateBp` is not divisible by `10,000`.
  2. [`src/components/transaction-row.tsx`](src/components/transaction-row.tsx): Fixed self-transfer (`senderType === receiverType && senderId === receiverId`) direction classification so any tax deducted on a self-transfer is never misrendered as `+netAmount` incoming credit.
  3. [`src/actions/company.ts`](src/actions/company.ts): Replaced the non-atomic read-then-delete inside `leaveCompanyAction` with an atomic `DELETE ... WHERE company_id = ... AND user_id = ... AND role <> 'OWNER' RETURNING id`, preventing TOCTOU owner-transferred deletion races.
- **Adds 8 Integrated V4 Subsystems**:
  - **A. Aeros Exchange** (`/exchange`, `/gov/exchange`, [`src/lib/exchange.ts`](src/lib/exchange.ts)) — Versioned Government INR/package policies, frozen policy snapshots on every purchase request, explicit private virtual-economy disclosures, and safe manual Government confirmation workflow (`MANUAL_CONFIRMATION`).
  - **B. Aeros Market** (`/aeros-market`, `/gov/market`, `/api/market/candles`, [`src/lib/synthetic-market.ts`](src/lib/synthetic-market.ts)) — Internal deterministic server-side synthetic index (`AMI-V4.0`) with whole-number OHLC candles, 15m default timeframe (+ 5m and 1h views), bounded demand sensitivity, and zero external crypto/price feeds.
  - **C. Synthetic Market Trading** (`/aeros-market`, [`src/lib/synthetic-market.ts`](src/lib/synthetic-market.ts)) — Server-authoritative whole-number `BUY`/`SELL` execution settled atomically against the Government Treasury via `transferInTx`, with slippage protection, cooldowns, cost-basis tracking, and realized/unrealized P/L.
  - **D. Refund Center** (`/refunds`, `/gov/refunds`, [`src/lib/refunds.ts`](src/lib/refunds.ts)) — User-submitted refund requests (`VIRTUAL_AEROS_REFUND`, `EXCHANGE_PACKAGE_REFUND`), full status lifecycle (`SUBMITTED` → `UNDER_REVIEW` / `DELAYED` / `APPROVED` / `REJECTED` → `COMPLETED`), structured delay notices, and idempotent Treasury-to-user settlement.
  - **E. Government Feature Controls** (`/gov/control-room`, [`src/actions/v4.ts`](src/actions/v4.ts)) — Server-enforced feature switches (`exchangeEnabled`, `exchangeLivePaymentsEnabled`, `marketEnabled`, `tradingEnabled`, `refundCenterEnabled`, `retentionEnabled`, `archiveCenterEnabled`), audited on every change.
  - **F & G. Configurable Retention & Archive Center** (`/gov/retention`, `/gov/archive`, `/api/gov/archive/[batchId]`, [`src/lib/archive.ts`](src/lib/archive.ts)) — Real `.zip` archive generation (`manifest.json`, `accounting-snapshot.json`, `data/<dataset>.json`, `data/<dataset>.csv`) with SHA-256 checksums, download tracking, manifest token verification, and confirmation-phrase-guarded clearing.
  - **H. Core Accounting Preservation ("Never Lose the Balance")** ([`src/lib/archive.ts`](src/lib/archive.ts), [`src/lib/reconcile.ts`](src/lib/reconcile.ts), [`src/lib/sales.ts`](src/lib/sales.ts)) — Authoritative balances (`users.balance`, `companies.balance`, `government.balance`) are never reconstructed by summing deletable transaction rows. Clearing eligible Category C transaction history atomically rolls up cumulative wallet counters (`archivedCredits`, `archivedDebits`, `archivedSalesNet`, `archivedTaxCollected`) and writes an immutable `accounting_checkpoints` row enforced by a database `CHECK` constraint (`treasury + userHeld + companyHeld + retiredSupply = totalSupply`).

---

## 2. Pre-Deployment Checklist & Neon Verification

Before applying the V4 migration to production Neon:

1. **Create a Neon Branch / Snapshot**:
   - In the Neon Console, create a backup branch of your production `main` branch (e.g. `pre-v4-backup`) so you have an instant point-in-time recovery point.
2. **Verify Existing Migration State**:
   - Inspect which migrations from `0000` through `0007` are already applied in your Neon database:
     ```sql
     SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name;
     ```
   - Even if some earlier tables or columns were applied manually, [`drizzle/0008_v4_upgrade.sql`](drizzle/0008_v4_upgrade.sql) uses idempotent `DO $$ ... EXCEPTION WHEN duplicate_object ... $$`, `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS` guards so it can be applied safely without destructive changes.
3. **Verify Supply Invariant Before Upgrade**:
   ```sql
   SELECT
     g.total_supply,
     g.balance AS treasury_balance,
     COALESCE((SELECT SUM(balance) FROM users), 0) AS user_held,
     COALESCE((SELECT SUM(balance) FROM companies), 0) AS company_held,
     g.balance
       + COALESCE((SELECT SUM(balance) FROM users), 0)
       + COALESCE((SELECT SUM(balance) FROM companies), 0) AS total_accounted
   FROM government g;
   ```
   Confirm `total_accounted = total_supply`.

---

## 3. Applying the Neon Database Migration (`0008_v4_upgrade.sql`)

You can apply the V4 migration using either `psql` / Neon SQL Editor or Drizzle:

### Option A — Direct SQL Execution on Neon (Recommended for Production)
Run [`drizzle/0008_v4_upgrade.sql`](drizzle/0008_v4_upgrade.sql) against your Neon connection string:
```bash
psql "$DATABASE_URL" -f drizzle/0008_v4_upgrade.sql
```
*(Or paste the contents of `drizzle/0008_v4_upgrade.sql` into the Neon SQL Editor and click **Run**).*

### Option B — Drizzle Kit
```bash
npm run db:migrate
```

### What `0008_v4_upgrade.sql` Creates / Extends:
- **Enums**:
  - Extended `transaction_type` with `EXCHANGE_PURCHASE`, `MARKET_BUY`, `MARKET_SELL`, `REFUND_PAYOUT`.
  - Created `exchange_purchase_status`, `exchange_payment_mode`, `market_order_side`, `market_order_status`, `market_timeframe`, `refund_request_status`, `refund_request_type`, `archive_dataset`, `archive_batch_status`.
- **Extended Tables (`ADD COLUMN IF NOT EXISTS`)**:
  - `government`: `retired_supply`, `archived_credits`, `archived_debits`, `archived_tax_collected`, `exchange_enabled`, `exchange_live_payments_enabled`, `market_enabled`, `trading_enabled`, `refund_center_enabled`, `retention_enabled`, `archive_center_enabled`, `v4_features_updated_at`.
  - `users`: `archived_credits`, `archived_debits`.
  - `companies`: `archived_credits`, `archived_debits`, `archived_sales_net`.
  - `retention_settings`: `transaction_history_retention_days`, `settled_order_history_retention_days`, `closed_refund_retention_days`, `market_candle_retention_days`.
- **New V4 Tables**:
  - `exchange_package_policies` (seeded with 3 default policies: `PKG-STARTER`, `PKG-BUILDER`, `PKG-ENTERPRISE`)
  - `exchange_purchases`
  - `market_state` (seeded with singleton row `id = 1`, `current_price = 100`, bounds `[10, 10000]`)
  - `market_candles`
  - `market_positions`
  - `market_orders`
  - `refund_requests`
  - `archive_batches`
  - `accounting_checkpoints`

---

## 4. Environment Variables

No new external API keys or third-party services are required for V4. Verify your `.env` / Vercel environment variables:

| Variable | Required | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | **Yes** | Neon PostgreSQL pooled/direct connection string (`postgresql://...`) |
| `SESSION_SECRET` | **Yes** | Minimum 32-character secret used for HMAC-SHA256 session cookies |
| `CRON_SECRET` | Optional | Bearer secret for `/api/cron/cleanup` (32+ chars if set) |
| `NEXT_PUBLIC_APP_URL` | Optional | Canonical public URL of the deployment |

---

## 5. Verification Commands

Run these commands locally or in CI before pushing to GitHub / Vercel:

```bash
# 1. Generate Next.js route types and verify TypeScript compilation
npx next typegen && npx tsc --noEmit

# 2. Run ESLint
npm run lint

# 3. Run the V4 automated verification & accounting-preservation test suite
npm run test:v4

# 4. Run the existing V1-V3 logic verification suite (requires DATABASE_URL if hitting DB)
npm test

# 5. Build for production
npm run build
```

---

## 6. Post-Deployment Verification & Recovery Procedures

1. **System Health & Reconciliation (`/gov/health`)**:
   - Sign in as Government (`/gov/login`) and open `/gov/health`.
   - Confirm all **9 reconciliation checks** pass (`SUPPLY_INVARIANT`, `NON_NEGATIVE_BALANCES`, `ORDER_ESCROW_CONSISTENCY`, `COMPANY_OWNERSHIP_INTEGRITY`, `PROMOTION_ACCOUNTING`, `CONTRACT_TERMINAL_INTEGRITY`, `LOAN_REPAYMENT_INTEGRITY`, `INVOICE_SETTLEMENT_INTEGRITY`, and `CHECKPOINT_ACCOUNTING_INTEGRITY`).
2. **Feature Controls (`/gov/control-room`)**:
   - Confirm all V4 feature switches (`Aeros Exchange`, `Aeros Market`, `Market Trading`, `Refund Center`, `Data Retention`, `Archive Center`) are visible and server-enforced.
   - Note that `Live INR Gateway Mode` is locked off by default so no user purchase is ever falsely marked paid without Government confirmation.
3. **Archive Recovery**:
   - Every cleared dataset has its complete `.zip` archive (`manifest.json`, `accounting-snapshot.json`, `data/<dataset>.json`, `data/<dataset>.csv`) retained in `archive_batches` and downloadable from `/gov/archive`.
   - All wallet balances (`users.balance`, `companies.balance`, `government.balance`) and cumulative counters (`archivedCredits`, `archivedDebits`, `archivedSalesNet`, `archivedTaxCollected`) remain permanently in the primary wallet rows and `accounting_checkpoints`.
