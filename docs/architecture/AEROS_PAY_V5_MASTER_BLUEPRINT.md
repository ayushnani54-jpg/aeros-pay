# AEROS PAY V5 — MASTER ARCHITECTURE & IMPLEMENTATION BLUEPRINT

## 1. Executive Summary
**Aeros Pay V5** upgrades the closed-loop sovereign virtual economy platform in place from V4.1, preserving 100% of existing working functionality and strict accounting invariants (`SUPPLY_INVARIANT`) while delivering:
1. **15 Dedicated Private GitHub Archive Repositories** (`GITHUB_ARCHIVE_REPO_KEYS_V5`) with a 900 MB operating threshold (`GITHUB_V5_REPO_HARD_LIMIT_BYTES`), 800 MB early warning (`GITHUB_V5_REPO_WARNING_BYTES`), automatic continuation repository rollover (`<repo>-2`, `<repo>-3`), and a durable manual/24h archival job runner (`archive_job_runs`).
2. **Global Action & Loading Notification System** (`GlobalActionFeedbackProvider` + `V5ActionForm`) featuring a bottom floating status toast and a persistent yellow/amber processing banner below the top navigation bar.
3. **Mobile-First Responsive UI Redesign** across user and Government pages with coordinated section accent themes, anti-zoom 16px mobile inputs, touch-friendly controls, and horizontal pill navigation.
4. **Market Index Update Cadence (`1m` / `5m`) & 5-Minute Candle Aggregation Fix**, separating tick frequency (`government.market_update_interval_minutes`) from chart candle timeframes (`5m`, `15m`, `1h`).
5. **Hedge-Style Trading (`BUY` = `LONG`, `SELL` = `SHORT`) & Leverage Progression (`2x → 4x → 8x → 10x`)** where opposing trades create independent positions (`market_trade_positions`) that never auto-net or cancel each other, each with its own explicit `Close Position` control.
6. **Marketplace Redesign & Citizen Employment (`jobs`, `job_applications`)** separating Public Goods & Services, Citizen Jobs Board, and My Activity, enforcing that Government and Registered Companies can offer jobs to Citizens while Companies can never offer jobs to other Companies.
7. **Company-to-Company Partnerships (`company_partnerships`, `partnership_settlements`)** with partner acceptance, Government regulatory approval & tax configuration, and atomic 50/50 (or custom) revenue settlement.
8. **Aeros Media (`media_posts`, `media_comments`, `media_likes`, `media_shares`)** — a text-only social feed with `@mentions`, likes, comments, internal shares, direct Aeros tipping links, 7-day server-side public retention (`MEDIA_RETENTION_DAYS = 7`), and GitHub archival.

---

## 2. 15-Repository Private GitHub Historical Archive Architecture

### 2.1 Repository Registry (`github-repos-bootstrap/registry-v5.json`)
| # | Repository Key | Dataset Key | Category & Purpose |
|---|---|---|---|
| 1 | `aeros-archive-market-index` | `old_market_candles` | Dedicated Market Index archive: historical 5m, 15m, and 1h OHLCV candles and AMI price snapshots. |
| 2 | `aeros-archive-trading-ledger` | `settled_market_orders` | Dedicated Trading Ledger archive: closed hedge-style positions, execution orders, and realized P&L settlements. |
| 3 | `aeros-archive-payments` | `transactions_history` | Settled P2P transfers, user-to-company transactions, and tax deductions. |
| 4 | `aeros-archive-exchange` | `closed_exchange_purchases` | Completed, rejected, or cancelled INR-to-Aeros Exchange purchase requests and policy snapshots. |
| 5 | `aeros-archive-refunds` | `closed_refunds` | Resolved, credited, or rejected transaction refund requests. |
| 6 | `aeros-archive-marketplace-listings` | `closed_marketplace_listings` | Archived, expired, or closed company marketplace offers and buyer wanted requests. |
| 7 | `aeros-archive-marketplace-orders` | `completed_marketplace_orders` | Fulfilled, cancelled, or refunded marketplace escrow orders and ratings. |
| 8 | `aeros-archive-jobs` | `completed_jobs` | Completed or cancelled Citizen jobs offered by Government or Registered Companies, plus applications. |
| 9 | `aeros-archive-contracts` | `settled_contracts` | Completed or expired bounty and milestone contracts and contractor applications. |
| 10 | `aeros-archive-company-partnerships` | `settled_partnerships` | Terminated/rejected company-to-company partnerships and historical 50/50 revenue settlements. |
| 11 | `aeros-archive-company-finances` | `settled_invoices` | Paid/cancelled itemized invoices and completed company ownership sales. |
| 12 | `aeros-archive-loans` | `repaid_loans` | Repaid, rejected, or closed Government business loans and instalment schedules. |
| 13 | `aeros-archive-media` | `archived_media_posts` | Expired (>7 days) or moderated Aeros Media text posts, comments, likes, and share counters. |
| 14 | `aeros-archive-government` | `government_decisions` | Historical monetary issuance logs, policy updates, leverage reviews, and accounting checkpoints. |
| 15 | `aeros-archive-audit` | `audit_logs_history` | Immutable administrative and security audit trail records (`audit_logs`). |

### 2.2 900 MB Operating Threshold & Continuation Rollover
- **Soft Warning Threshold**: `800 MB` (`838,860,800` bytes). Surfaces an early warning in the Government Archive Center and top navigation bar.
- **Hard Operating Threshold**: `900 MB` (`943,718,400` bytes). Before any upload crosses 900 MB, the repository is marked `CRITICAL` (`shouldRotateShard: true`), and subsequent writes roll over to `<repo-name>-2`, `<repo-name>-3`, etc., while keeping older continuation repositories permanently readable via the catalog index.
- **Verification Before Deletion**: Zero Neon rows are ever deleted until the `.jsonl` batch, `-manifest.json`, and monthly index are uploaded to GitHub and verified via remote read-back SHA-256 checksum comparison.

---

## 3. Database Schema Additions (`drizzle/0010_v5_upgrade.sql`)
- **Altered Tables**:
  - `government`: Added `market_update_interval_minutes integer NOT NULL DEFAULT 1`.
  - `users`: Added `max_leverage integer NOT NULL DEFAULT 2`.
  - `archive_repositories`: Added `shard_generation`, `continuation_repo_key`, and `continuation_repo_name`.
- **New V5 Tables (11)**:
  1. `archive_job_runs`: Durable, concurrency-locked manual and scheduled archival job tracking.
  2. `market_trade_positions`: Hedge-style independent `LONG` and `SHORT` positions with `leverage IN (2, 4, 8, 10)` and `margin_locked`.
  3. `leverage_requests`: Citizen progressive leverage unlock requests (`2x → 4x → 8x → 10x`).
  4. `jobs`: Citizen employment postings by `GOVERNMENT` or `COMPANY`.
  5. `job_applications`: Citizen applications and hiring status for open jobs.
  6. `company_partnerships`: Company-to-company joint venture contracts with basis-point share splits and Government tax rates.
  7. `partnership_settlements`: Atomic revenue distribution ledger preserving `SUPPLY_INVARIANT`.
  8. `media_posts`: Text-only social posts with 7-day public retention (`is_expired`).
  9. `media_comments`: Text comments on Aeros Media posts.
  10. `media_likes`: Unique per-user post likes.
  11. `media_shares`: Internal post share records.

---

## 4. Core Economic & Accounting Invariants
$$\text{Total Circulating Supply} = \sum \text{User Balances} + \sum \text{Company Balances} + \text{Government Treasury Balance}$$
- **Hedge Trading Settlement**: Opening a `LONG` or `SHORT` position transfers `marginLocked = ceil((quantity * entryPrice) / leverage)` from the Citizen wallet to the Government Treasury. Closing a position transfers `clamp(marginLocked + unrealizedPnl, 0, treasuryBalance)` from the Government Treasury back to the Citizen wallet. Opposing positions never auto-net.
- **Citizen Job Settlement**: Completing an `IN_PROGRESS` job transfers `compensationAeros` atomically from the hiring Company wallet (or Government Treasury) to the hired Citizen wallet.
- **Partnership 50/50 Settlement**: Given `grossAmount` held in the initiating Company wallet, `govTaxDeducted = floor(grossAmount * govTaxRateBp / 10000)`, `netDistributable = grossAmount - govTaxDeducted`, `partnerPayout = floor(netDistributable * partnerShareBp / 10000)`, and `initiatorPayout = netDistributable - partnerPayout`. Thus `initiatorPayout + partnerPayout + govTaxDeducted === grossAmount` for every integer amount.

