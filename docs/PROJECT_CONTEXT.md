# Aeros Pay — Project Context & Workspace Guide

## 1. Executive Summary & Product Identity
**Aeros Pay** is a full-stack, closed-loop sovereign virtual economy platform and financial simulation engine. 
- **Product Name**: Aeros Pay (permanent canonical name).
- **Virtual Currency**: Aeros (strictly whole-number integers `integer`).
- **Current Version**: V4.1.
- **Architectural Paradigm**: Hybrid lean operational database (Neon Serverless PostgreSQL) combined with a permanent append-only historical database across 5 private GitHub repositories.

Aeros Pay is designed to operate as a reliable, secure multi-user platform with enterprise-grade accounting guarantees, atomic transactions, idempotency enforcement, and complete auditability.

---

## 2. Participant Roles & Economic Model
The Aeros Pay economy consists of three distinct actor tiers:

### A. Citizens (Natural Persons)
- **Onboarding**: Registered via single-use invite codes issued by Government (`registration_codes`).
- **Initial Grant**: Upon registration, citizens receive a starting grant (default 2,000 Aeros via `NEW_USER_FUNDING_AMOUNT`) transferred from the Government Treasury.
- **Capabilities**:
  - Peer-to-peer transfers (`/send`, `/pay`) with optional memo and automatic transfer tax.
  - Settle corporate invoices (`/invoices`).
  - Incorporate companies (`/my-company/new`).
  - Participate in the Marketplace as buyers (`/marketplace`, `/market/contracts`, `/market/wanted`).
  - Purchase Aeros using INR policy packages (`/exchange`).
  - Trade the synthetic Aeros Market Index (AMI) via BUY, SELL, SHORT, and COVER (`/aeros-market`).
  - Submit refund claims for disputed transactions (`/refunds`).
  - View unified transaction ledger with GitHub archive fallback (`/transactions`).

### B. Registered Companies (Corporate Entities)
- **Incorporation**: Founded by Citizens, requiring formal review and approval by Government.
- **Corporate Treasury**: Segregated corporate wallet funded with an approval grant (default 3,000 Aeros) from the Government Treasury.
- **Capabilities**:
  - Issue itemized, printable invoices (`/my-company/invoices`).
  - List goods, services, and bounty contracts on the Marketplace (`/my-company/offers`).
  - Apply for business loans with structured instalment repayment plans (`/my-company/loans`).
  - Purchase homepage promotional banners (`/my-company/promotions`).
  - List the company for acquisition or buyout (`/my-company/sale`).

### C. Government (Central Authority & Treasury)
- **Authentication**: Strict administrative portal at `/government/login` with separate session cookie (`aeros_gov_session`).
- **Treasury Singleton**: Holds the central reserves of the economy (`government` table).
- **Monetary Issuance**: The sole mechanism permitted to expand total money supply (`/gov/issuance`).
- **Administrative Control**:
  - Emergency feature toggles via the Control Room (`/gov/control-room`).
  - Tax policy management (transfer tax, corporate tax rates via `/gov/tax`).
  - Loan review, disbursement, and debt restructuring (`/gov/loans`).
  - Marketplace & contract dispute arbitration (`/gov/contracts`, `/gov/ip`).
  - Exchange rate package publication (`/gov/exchange`).
  - Synthetic market configuration and short-selling controls (`/gov/market`).
  - Refund adjudication and settlement (`/gov/refunds`).
  - 5-Repository GitHub Archival operations and storage health monitoring (`/gov/archive`).

---

## 3. Verified Application Architecture & Tech Stack

### Core Technology Stack
- **Framework**: Next.js 16.3.6 (App Router, Turbopack, Server Components, Server Actions).
- **Language**: TypeScript 5.x, React 19.2.8.
- **Styling**: Tailwind CSS v4 with `@tailwindcss/postcss`.
- **Database & ORM**: Neon Serverless PostgreSQL (`@neondatabase/serverless`) + Drizzle ORM (`drizzle-orm` `0.45.3`, `drizzle-kit` `0.31.11`).
- **Authentication**: Stateless HMAC-SHA256 encrypted cookies with session epoch revocation (`users.session_epoch`) and bcrypt password hashing.
- **Validation**: Strict runtime schema validation using Zod (`zod` `^4.6.5`).
- **Historical Storage**: GitHub REST Contents API (`2022-11-28`) across 5 dedicated private repositories.
- **Deployment Platform**: Vercel (with daily automated retention cron at `/api/cron/cleanup`).

### Key Directory Structure
- `src/app/(app)/`: Citizen and corporate application portal routes.
- `src/app/gov/`: Government administrative control room and oversight interfaces.
- `src/actions/`: Server Actions implementing business logic and transactional mutations.
- `src/db/`: Neon connection pool (`client.ts`) and complete 47-table schema (`schema.ts`).
- `src/lib/`: Core algorithmic services, security guards, market engine, and archival clients.
  - `archive.ts`: 12-step 24h archival engine, PKZIP builder, accounting checkpoints.
  - `github-archive.ts`: GitHub REST API client, sanitization, SHA-256 verification.
  - `synthetic-market.ts`: Deterministic OHLCV candle generator and order execution.
  - `market-chart-utils.ts`: Interactive chart zoom, pan, and dynamic Y-axis auto-scaling math.
  - `wallets.ts`: Atomic wallet balance mutations and row-level locking.
- `drizzle/`: Migration history (`0000_...sql` to `0009_...sql`).
- `scripts/`: Verification test suites (`test-v4.ts`, `test-v4-1.ts`, `seed-government.ts`).
- `github-repos-bootstrap/`: Initial bootstrap catalogs, schemas, and READMEs for the 5 archive repositories.

---

## 4. The Neon + 5-Repository GitHub Archival System

### Architecture Design
Neon PostgreSQL operates as a lean active operational store (~11.8 MB), retaining active user credentials, open positions, live balances, pending workflows, and hot history under 24 hours old.

Historical records $\ge 24\text{ hours}$ old are permanently migrated to 5 private GitHub repositories:
1. `aeros-archive-ledger`: `transactions_history`, `closed_exchange_purchases`, `closed_refunds`.
2. `aeros-archive-contracts`: `settled_invoices`, `settled_contracts`, `repaid_loans`.
3. `aeros-archive-market`: `settled_market_orders`, `old_market_candles`.
4. `aeros-archive-economy`: `completed_marketplace_orders`, `closed_company_sales`.
5. `aeros-archive-audit`: `audit_logs_history`.

### The 12-Step Resumable 24-Hour Archival Cycle
When the daily cron or manual trigger runs:
1. Terminal records $\ge 24\text{ hours}$ are selected.
2. Chunked into bounded batches of up to 500 records.
3. Sanitized via `sanitizeRecordForArchive` (stripping all password hashes and secrets).
4. Serialized to deterministic `.jsonl` with `-manifest.json`.
5. Uploaded to the assigned GitHub repository.
6. Monthly catalog index (`index/YYYY-MM/<dataset>.json`) updated with HTTP 409 conflict retries.
7. Root `index/catalog.json` updated.
8. **Remote read-back & SHA-256 checksum verification**: The uploaded file is read back from GitHub and its checksum matched against local bytes.
9. Accounting checkpoint written to `accounting_checkpoints`.
10. IDs recorded in `archived_record_ledger`.
11. Safe deletion from Neon executed **only after** all previous steps succeed.
12. Repository storage monitored against soft warning (400 MB) and hard shard rotation (750 MB).

---

## 5. Non-Negotiable Economic & Security Invariants
1. **Whole Integer Math**: No floating-point or fractional Aeros exist in the system.
2. **Supply Conservation**:
   $$\text{Total Circulating Supply} = \sum \text{User Balances} + \sum \text{Company Balances} + \text{Treasury Balance}$$
   Transfers, fees, loans, escrow, and trades are strictly conservative.
3. **Transaction Atomicity**: All mutations occur inside `db.transaction(...)` with `FOR UPDATE` locks and unique client `idempotency_key` enforcement.
4. **Short-Selling Safety**: Collateral is locked $\ge 100\%$ upon entry; cover payouts are clamped at $\ge 0$ to prevent negative citizen balances.
5. **Zero Credential Exposure**: Passwords, tokens, and hashes never leave the server or enter archives.

---

## 6. How a Future Agent Should Start an Unfamiliar Task
When starting any task in this workspace:
1. **Never guess**: Read the actual code in `src/` and check `docs/architecture/AEROS_PAY_V4_1_MASTER_BLUEPRINT.md`.
2. **Run baseline verification**: Confirm the workspace is green by running `npm.cmd run test:v4:1` and `npm.cmd run lint`.
3. **Identify the exact skill**: Consult `.agents/skills/` (`aeros-pay-code-change`, `safe-bug-fixing`, `neon-migrations`, `github-archive`, `production-audit`).
4. **Follow the 10-Step Workflow**: Plan the smallest coherent change, implement, verify with all 5 gates, and update documentation.
