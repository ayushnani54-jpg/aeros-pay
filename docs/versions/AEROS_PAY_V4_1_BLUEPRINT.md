# AEROS PAY (V1 → V4.1) — COMPLETE MASTER ARCHITECTURE, FEATURE & BACKEND BLUEPRINT

> **Purpose of this Document**: Hand this document directly to any AI agent, developer, or new Antigravity workspace so it immediately understands 100% of the Aeros Pay virtual economy platform, every Citizen and Government feature, every database table, the Hybrid Neon + 5-Repository GitHub Historical Storage Architecture, and all V4.1 upgrades.

---

## 1. PROJECT OVERVIEW & NON-NEGOTIABLE INVARIANTS

- **Application Name**: **Aeros Pay**
- **Virtual Currency**: **Aeros** (strictly whole-number integers `integer` in PostgreSQL; fractional Aeros are forbidden across the entire platform).
- **Nature of System**: A closed-loop sovereign virtual economy simulation & financial platform managed by a single **Government (Central Authority / Treasury)** and populated by **Citizens (Users)** and **Registered Companies**.
- **Monetary Supply Invariant**:
  $$\text{Total Circulating Supply} = \sum \text{User Balances} + \sum \text{Company Balances} + \text{Government Treasury Balance}$$
  - Money is never created out of thin air during transfers, invoices, escrow, loans, refunds, or market trades.
  - Only an approved **Government Issuance** (`ISSUANCE_CREDIT`) increases total Aeros supply (credited to Government Treasury first).
  - Every transaction, tax deduction, escrow lock, synthetic market buy/sell/short/cover, and refund settles atomically inside a PostgreSQL transaction (`db.transaction(...)`) with row-level `FOR UPDATE` locks and idempotency keys (`idempotency_key`).

---

## 2. WHAT WAS UPGRADED IN VERSION 4.1 (ONE BY ONE)

1. **Hybrid Neon + 5-Repository GitHub Permanent Historical Database (`src/lib/github-archive.ts`, `src/lib/archive.ts`)**:
   - **Neon PostgreSQL** is kept ultra-lean (`~11.8 MB` live database size) holding only active operational state (users, password hashes, live balances, active companies/loans/contracts/positions, and recent `<24h` activity).
   - **5 Private GitHub Repositories** act as the permanent, append-only historical database for all 11 historical datasets:
     1. `aeros-archive-ledger` (`transactions_history`, `closed_exchange_purchases`, `closed_refunds`)
     2. `aeros-archive-contracts` (`settled_invoices`, `settled_contracts`, `repaid_loans`)
     3. `aeros-archive-market` (`settled_market_orders`, `old_market_candles`)
     4. `aeros-archive-economy` (`completed_marketplace_orders`, `closed_company_sales`)
     5. `aeros-archive-audit` (`audit_logs_history`)
2. **12-Step Resumable 24-Hour Archival Engine (`run24HourGithubArchivalCycle`)**:
   - Automatically selects eligible closed/historical records (`>= 24 hours` old by default via `GITHUB_ARCHIVE_MIN_AGE_HOURS`), strips any sensitive fields (`sanitizeRecordForArchive` guarantees `passwordHash`, `securityCodeHash`, tokens, and secrets never leave Neon), builds deterministic `.jsonl` batches and `-manifest.json` proofs, uploads them to the target GitHub repo, updates the monthly lookup index (`index/<YYYY-MM>/<dataset>.json`) with `409 Conflict` retry, **reads back the uploaded file from GitHub to verify its remote SHA-256 checksum**, writes an immutable `accounting_checkpoints` row, records each ID in `archived_record_ledger`, and **only then** deletes the archived rows from Neon.
3. **Storage Threshold Monitoring & Shard Rotation (`archive_repositories`)**:
   - Tracks cumulative bytes and batch counts per GitHub repository. Triggers `WARNING_STORAGE` at `400 MB` and `ROTATION_REQUIRED` at `750 MB` to prevent hitting GitHub repository size limits.
4. **Trading Chart Interactive Zoom, Pan & Visible-Window Y-Axis Auto-Scaling (Defect 6.A Fix)**:
   - Added `src/lib/market-chart-utils.ts` and upgraded `src/components/v4/synthetic-market-chart.tsx`:
     - Zoom In (`+`), Zoom Out (`−`), Mouse-Wheel Zoom anchored at cursor position.
     - Pan Left (`←`), Pan Right (`→`), Click-and-Drag panning across the SVG candlestick chart.
     - Window presets (`16c`, `32c`, `48c`, `96c`, `All`) and `Reset / Fit`.
     - Dynamic Y-axis (`computeVisibleYScale`) that auto-scales tightly to the currently visible candle slice rather than flattening candles across all-time highs/lows.
     - Historical cursor pagination (`⇤ Load Older` button calling `/api/market/candles?timeframe=...&before=...`).
5. **Collateralized Short Selling — `SHORT` & `COVER` Order Modes (Defect 6.B Fix)**:
   - Upgraded `src/lib/synthetic-market.ts` (`executeMarketOrder`) and `src/components/v4/synthetic-market-chart.tsx`:
     - Users with `0` long holdings can now sell/short the Aeros Market Index (`AMI`) either by clicking **`SHORT`** or clicking **`SELL`** (which automatically switches to `SHORT` mode when `unitsHeld === 0`).
     - Opening a short position locks collateral (`round(notional * shortCollateralRatioBp / 10000)`, default `100%`) from the user's Aeros balance into the Government Treasury.
     - Covering a short position (`COVER`) releases pro-rata locked collateral +/- realized short P&L (`entryNotional - coverNotional`) back to the user, clamped at `>= 0` so user balances can never become negative even on a `>= 2x` price spike.
     - Government can configure `shortSellingEnabled`, `shortCollateralRatioBp` (`50%`–`300%`), and `maxShortUnitsPerUser` on `/gov/market`.
6. **One-Click "Download All Categories (.zip)" Bundle (`createDownloadAllArchiveBundle`)**:
   - Government can download a single verified PKZIP (`.zip`) bundle containing all 11 historical datasets (`datasets/<dataset>.jsonl`, `datasets/<dataset>.csv`, `manifest.json`, `accounting-summary.json`, `README.txt`).
7. **Unified Citizen Transaction History with GitHub Archive Fallback (`/transactions`)**:
   - Citizens can search, filter by transaction type, and toggle **`+ Include GitHub Archive`** (`?includeArchived=1`), which transparently merges live Neon transactions with historical transactions fetched directly from `aeros-archive-ledger` on GitHub (`ARCHIVED · GITHUB` badge).
8. **Dashboard Economy Hub & Citizen Passport Milestones (`/dashboard`, `/profile`)**:
   - Upgraded Citizen Dashboard with the **Aeros Economy Hub** (direct cards for Exchange, Synthetic Market, Refund Center, Marketplace, and Companies) + **Citizen Economy Checklist**, and upgraded `/profile` with the **Citizen Passport** & verifiable activity badges.

---

## 3. TECH STACK & DIRECTORY MAP

### Exact Tech Stack
- **Framework**: Next.js `16.3.6` (App Router, Server Components, Server Actions, Turbopack)
- **Language & UI**: TypeScript `5.x`, React `19.2.3`, Tailwind CSS `v4`
- **Database**: Neon Serverless PostgreSQL (`@neondatabase/serverless`) + Drizzle ORM (`drizzle-orm` `0.45.1`)
- **Historical Storage**: GitHub REST Contents API (`2022-11-28`) across 5 private repositories
- **Security**: `bcryptjs` password & security-code hashing + HMAC-SHA256 stateless session cookies (`src/lib/session.ts`)

### Key Codebase Files
```text
src/
├── db/
│   ├── client.ts                  # Neon serverless connection pool & Drizzle instance
│   └── schema.ts                  # Complete PostgreSQL schema (36 tables + enums)
├── actions/
│   ├── auth.ts                    # Register (with invite code), Citizen Login, Gov Login, Logout
│   ├── user.ts                    # Send Aeros, Pay by Code/Username, Issuance requests, Profile updates
│   ├── company.ts                 # Register company, issue invoices, pay from company, manage staff
│   ├── loans.ts                   # Apply for Government loans, approve/reject, pay instalments
│   ├── v2.ts                      # Company acquisition listings, offers, counter-offers, support, IP complaints
│   ├── v3.ts                      # Marketplace offers, escrow orders, contracts, wanted requests, promotions, reversals
│   ├── v4.ts                      # Exchange policies/purchases, Synthetic Market BUY/SELL/SHORT/COVER, Refunds, 5-Repo GitHub Archive actions
│   └── gov.ts                     # Government treasury, issuance execution, tax rates, user freeze/suspend/ban, feature toggles
├── lib/
│   ├── constants.ts               # All system constants, 11 ARCHIVE_DATASET_KEYS, 5 GITHUB_ARCHIVE_REPOS
│   ├── validators.ts              # Zod validation schemas for every form and action
│   ├── session.ts                 # HMAC-SHA256 cookie signing & verification
│   ├── auth.ts                    # Current user / Government session guards
│   ├── crypto.ts                  # bcrypt hashing & verification
│   ├── rate-limit.ts              # PostgreSQL atomic rate limiter
│   ├── audit.ts                   # Append-only Government & security audit logger
│   ├── synthetic-market.ts        # Deterministic OHLCV candle engine + BUY/SELL/SHORT/COVER execution
│   ├── market-chart-utils.ts      # Visible-window zoom, pan, clamping & Y-axis auto-scaling math
│   ├── github-archive.ts          # 5-repo GitHub API client, secret sanitizer, SHA-256 remote verifier
│   ├── archive.ts                 # 12-step 24h GitHub archival engine, PKZIP builder, Download All bundle, ledger fallback
│   ├── retention.ts               # Neon database size health check & operational retention cleanup
│   └── exports.ts                 # CSV & JSON streaming exports
└── app/
    ├── (auth)/                    # /login, /register, /government/login
    ├── (app)/                     # Citizen & Company portal routes (/dashboard, /send, /pay, /exchange, /aeros-market, /refunds, /transactions, /marketplace, /market/*, /companies, /my-company/*, /invoices/*, /profile, /updates)
    ├── gov/                       # Government Control Room & administrative routes (/gov, /gov/control-room, /gov/treasury, /gov/issuance, /gov/tax, /gov/users, /gov/companies, /gov/loans, /gov/contracts, /gov/exchange, /gov/market, /gov/refunds, /gov/archive, /gov/retention, /gov/health, /gov/audit)
    └── api/                       # /api/cron/cleanup, /api/market/candles, /api/gov/archive/[batchId], /api/export/[dataset], /api/gov/export/[dataset]
```

---

## 4. COMPLETE CITIZEN / USER FEATURES & WORKFLOWS

1. **Invite-Code Registration & Security (`/register`, `/login`)**:
   - Citizens register using a single-use **Government Invite Code** (`registration_codes`), choosing a unique lowercase username, password, and 6-digit Security Code.
   - Upon registration, if `initialUserFunding > 0`, the new citizen automatically receives their starting Aeros grant from the Government Treasury (`GOVERNMENT_FUNDING`).
2. **Citizen Dashboard & Economy Hub (`/dashboard`)**:
   - Displays live Aeros balance, recent ledger activity, **Aeros Economy Hub** quick-launch cards, and the interactive **Citizen Economy Checklist**.
3. **Peer-to-Peer Transfers & Quick Pay (`/send`, `/pay`)**:
   - Send Aeros to any citizen username or company with an optional memo and idempotency protection.
   - Automatic transfer tax (`transferTaxBp`, if set by Government) is calculated and routed to the Government Treasury in the same atomic transaction.
4. **Invoicing System (`/invoices`, `/invoices/[id]`, `/invoices/[id]/print`)**:
   - View pending and paid invoices issued by companies, pay them with one click (`INVOICE_PAYMENT`), or print official receipts.
5. **Companies & Corporate Banking (`/companies`, `/my-company/*`)**:
   - Citizens can incorporate a company (`/my-company/new`). Once approved by Government (`COMPANY_FUNDING`), the company receives its own corporate Aeros wallet, can issue invoices, post marketplace offers, apply for business loans, buy daily homepage promotions (`/my-company/promotions`), or list the company for sale (`/my-company/sale`).
6. **Marketplace, Escrow Orders, Contracts & Wanted Board (`/marketplace`, `/market/*`)**:
   - **Offers & Orders**: Buy goods/services from companies; funds lock in escrow (`MARKETPLACE_PAYMENT`) until delivery is confirmed or a dispute is resolved.
   - **Contracts (`/market/contracts`)**: Post or bid on milestone/bounty contracts (`CONTRACT_PAYMENT`).
   - **Wanted Requests (`/market/wanted`)**: Post custom buyer requests for companies to fulfill.
7. **Aeros Exchange — Fixed-Policy INR to Aeros Packages (`/exchange`)**:
   - View official Government-published INR-to-Aeros exchange policies (`exchange_policies`).
   - Submit an acquisition request (`exchange_purchases`) which captures an **immutable policy snapshot** (`policyVersion`, `inrAmount`, `aerosAmount`, `effectiveRateBp`) so future policy changes or market moves never alter past purchases.
8. **Aeros Market — Synthetic Index Trading Terminal (`/aeros-market`)**:
   - Trade the internal deterministic **Aeros Market Index (`AMI`)** across `5m`, `15m` (default), and `1h` timeframes:
     - **Interactive Candlestick & Volume Chart**: Zoom In (`+`), Zoom Out (`−`), Mouse-Wheel Zoom, Pan (`←`/`→` or drag), Window Presets (`16c`/`32c`/`48c`/`96c`/`All`), `Reset / Fit`, `⇤ Load Older`, and auto-scaling visible Y-axis.
     - **4 Order Modes**:
       - `BUY`: Buy long AMI units (Aeros paid to Treasury).
       - `SELL`: Sell long AMI units (Aeros paid from Treasury; if `unitsHeld === 0` and short selling is enabled, automatically routes as `SHORT`).
       - `SHORT`: Open a collateralized short position without holding long units (locks collateral in Treasury).
       - `COVER`: Buy back shorted units to unlock pro-rata collateral +/- realized short P&L.
     - **Slippage Guard**: Configurable max slippage (`50 bps` to `500 bps`).
9. **Refund Center (`/refunds`)**:
   - Submit structured virtual Aeros refund claims referencing an optional transaction ID, requested Aeros amount, category, and explanation. Track status live (`SUBMITTED` → `UNDER_REVIEW` / `DELAYED` → `APPROVED` / `REJECTED` → `REFUNDED`).
10. **Unified Transaction Ledger + GitHub Archive Lookup (`/transactions`)**:
    - Search and filter personal transaction history by type or keyword, export CSV/JSON, and toggle **`+ Include GitHub Archive`** to seamlessly view historical transactions fetched from `aeros-archive-ledger` on GitHub.
11. **Citizen Passport & Support (`/profile`, `/contact-government`)**:
    - View Citizen Passport, verifiable on-chain/ledger milestones, open support tickets with Government, or file IP/trademark complaints.

---

## 5. COMPLETE GOVERNMENT / ADMIN FEATURES & CONTROLS

Accessible at `/government/login` → `/gov`:

1. **Control Room (`/gov/control-room`)**:
   - Master switches to enable/disable **Transfers**, **Company Creation**, **Marketplace**, **Loans**, **Aeros Exchange**, **Synthetic Market Trading**, and **Refund Submissions** in real time.
2. **Treasury & Monetary Issuance (`/gov/treasury`, `/gov/issuance`)**:
   - View live Treasury balance, total circulating Aeros supply, and execute new monetary issuances (`ISSUANCE_CREDIT`) or review citizen/company issuance requests.
3. **Taxation Engine (`/gov/tax`)**:
   - Configure basis-point tax rates on P2P transfers, company sales, marketplace orders, and contracts.
4. **Citizen & Account Oversight (`/gov/users`, `/gov/codes`)**:
   - Generate single-use registration invite codes; inspect any user's wallet; perform administrative credits/debits (`ADMIN_ADJUSTMENT_CREDIT`/`DEBIT`); reverse erroneous transactions (`TRANSACTION_REVERSAL`); freeze, timed-suspend, ban, or reset passwords.
5. **Corporate, Loan & Contract Regulation (`/gov/companies`, `/gov/loans`, `/gov/contracts`, `/gov/sales`, `/gov/ip`)**:
   - Approve/suspend companies, approve/disburse business loans, arbitrate disputed marketplace orders/contracts, and rule on IP complaints.
6. **Aeros Exchange Administration (`/gov/exchange`)**:
   - Create/update versioned INR-to-Aeros packages (`exchange_policies`) and verify/credit or cancel pending citizen exchange requests.
7. **Synthetic Market Regulation (`/gov/market`)**:
   - Configure `minPrice`, `maxPrice`, `baseVolatilityBp`, `demandSensitivityBp`, `maxStepChangeBp` (anti-manipulation cap), `maxOrderUnits`, `userCooldownSeconds`, `shortSellingEnabled`, `shortCollateralRatioBp`, and `maxShortUnitsPerUser`, or manually sync the candle clock.
8. **Refund Center Adjudication (`/gov/refunds`)**:
   - Review citizen refund claims, post formal delay notices (`DELAYED`), reject with reason, or approve & atomically settle (`REFUND_CREDIT` from Treasury to Citizen).
9. **5-Repository GitHub Archive Center (`/gov/archive`)**:
   - Inspect live connection & storage health (`HEALTHY`, `WARNING_STORAGE` at 400 MB, `ROTATION_REQUIRED` at 750 MB) for all 5 private GitHub repositories.
   - Click **"Run 24-Hour Automated GitHub Archival Cycle Now"** to archive, remote-verify (SHA-256), checkpoint, and clear eligible `>=24h` records across all 11 datasets.
   - Create manual verified ZIP/GitHub batches for any dataset (`Older than (days)` = `0..3650`), retry any failed batch, or click **"Download All Categories (.zip Bundle with Manifest & Checksums)"**.
10. **Database Health, Retention & Audit Logs (`/gov/health`, `/gov/retention`, `/gov/audit`)**:
    - Monitor live Neon PostgreSQL size (`pg_database_size`), configure retention days, and inspect the immutable administrative audit trail.

---

## 6. COMPLETE BACKEND DATA STORAGE MAP (NEON vs GITHUB)

### A. What Stays in Neon PostgreSQL (`DATABASE_URL`)
- **Identity & Auth**: `users` (including `password_hash`, `security_code_hash`), `registration_codes`, `rate_limits`.
- **Live Wallet & Economy State**: `government` singleton, `companies`, `company_members`, `market_state` singleton, `market_positions` (open long & short positions), `retention_settings`, `exchange_policies`.
- **Active Operational Workflows**: Open/pending rows in `invoices`, `loans`, `loan_instalments`, `marketplace_offers`, `marketplace_orders`, `marketplace_contracts`, `wanted_requests`, `promotions`, `company_sale_listings`, `support_tickets`, `ip_complaints`, `refund_requests`, `issuance_requests`.
- **Recent (<24h) Hot History**: Last 24 hours of `transactions`, `market_orders`, `market_candles`, `exchange_purchases`, `audit_logs`.
- **Compact Archival Cursors & Proofs**: `archive_repositories` (5 rows), `archive_batches` (1 row per batch), `accounting_checkpoints` (1 row per cleared transaction batch), `archived_record_ledger` (lightweight deduplication index).

### B. What Moves to the 5 Private GitHub Repositories (Every 24 Hours)
| GitHub Repo Env Var | Default Repo Name | Datasets Stored (`batches/<dataset>/<YYYY>/<MM>/<DD>/<batch>.jsonl`) |
|---|---|---|
| `GITHUB_ARCHIVE_REPO_LEDGER` | `aeros-archive-ledger` | `transactions_history`, `closed_exchange_purchases`, `closed_refunds` |
| `GITHUB_ARCHIVE_REPO_CONTRACTS` | `aeros-archive-contracts` | `settled_invoices`, `settled_contracts`, `repaid_loans` |
| `GITHUB_ARCHIVE_REPO_MARKET` | `aeros-archive-market` | `settled_market_orders`, `old_market_candles` |
| `GITHUB_ARCHIVE_REPO_ECONOMY` | `aeros-archive-economy` | `completed_marketplace_orders`, `closed_company_sales` |
| `GITHUB_ARCHIVE_REPO_AUDIT` | `aeros-archive-audit` | `audit_logs_history` |

---

## 7. VERIFICATION & COMMAND REFERENCE

When working on this project in any future session, run these commands from the project root:

```powershell
# 1. Typecheck entire project (0 errors)
npx.cmd tsc --noEmit

# 2. Lint entire project (0 errors, 0 warnings)
npm.cmd run lint

# 3. Run V4 Verification Suite (Exchange, Synthetic Market, Accounting Invariants)
npm.cmd run test:v4

# 4. Run V4.1 Verification Suite (5-Repo GitHub Archival, Chart Zoom/Pan, Short Selling)
npm.cmd run test:v4:1

# 5. Production Next.js Build (64 routes)
npm.cmd run build
```

