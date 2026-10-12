# Aeros Pay — Database & Historical Archival Architecture (V5)

## 1. Dual-Storage Strategy Overview

Aeros Pay implements a permanent hybrid storage architecture:
1. **Neon Serverless PostgreSQL (`DATABASE_URL`)**:
   - Stores current operational state, user credentials, active balances, open positions, pending workflows, and hot historical events under 24 hours old (plus 7-day public retention for Aeros Media).
   - Maintained at an ultra-lean operational footprint (~11.8 MB) to optimize latency, query speed, and hosting costs.
2. **15 Dedicated Private GitHub Repositories (GitHub REST API)**:
   - Serve as the permanent, immutable, append-only historical database (`GITHUB_ARCHIVE_REPO_KEYS_V5`).
   - Stores 15 terminal datasets partitioned by date and batch index (`github-repos-bootstrap/registry-v5.json`), while preserving full backwards compatibility with the V4.1 5-repository mapping.

---

## 2. Neon Database Schema & Tables

The Neon database schema is defined in `src/db/schema.ts` and managed via Drizzle ORM (`drizzle/` migrations 0000 to 0010):

### Core Tables & Active State
- `government`: Central treasury balance, monetary policy, `market_update_interval_minutes` (`1` or `5`), and global feature toggles (singleton).
- `users`: Citizen credentials, balances, `max_leverage` (`2` default, up to `10`), session epochs, status (`ACTIVE`, `SUSPENDED`, `BANNED`), and funding status.
- `registration_codes`: Single-use invite codes.
- `companies`: Corporate records, corporate balances, category, status (`PENDING`, `APPROVED`, `REJECTED`, `SUSPENDED`).
- `company_members`: Multi-user company staff roles and permissions.
- `market_state`: Synthetic market parameters and index state (singleton).
- `market_positions`: V4/V4.1 aggregate long and short positions.
- `market_trade_positions` (V5): Independent hedge-style `LONG` and `SHORT` positions with `leverage IN (2, 4, 8, 10)` and explicit per-position closing.
- `leverage_requests` (V5): Citizen progressive leverage unlock requests (`2x → 4x → 8x → 10x`).
- `jobs` & `job_applications` (V5): Citizen employment postings by Government or Registered Companies and applicant hiring workflow.
- `company_partnerships` & `partnership_settlements` (V5): Company-to-company joint venture contracts and atomic 50/50 revenue settlements.
- `media_posts`, `media_comments`, `media_likes`, `media_shares` (V5): Text-only social platform with `@mentions` and 7-day public retention.
- `exchange_policies`: Versioned INR-to-Aeros exchange rate packages.

### Active & Hot History Tables (< 24 Hours)
- `transactions`: P2P, invoice, escrow, loan, job, partnership, and tax transfers.
- `invoices`: Corporate customer billing.
- `marketplace_orders`: Escrow-backed marketplace purchases.
- `marketplace_contracts`: Milestone and bounty contracts.
- `loans` & `loan_instalments`: Corporate financing and repayment schedules.
- `market_orders`: Synthetic index BUY, SELL, SHORT, COVER orders.
- `market_candles`: 5m, 15m, 1h OHLCV historical trading candles.
- `refund_requests`: Citizen refund claims and adjudication history.
- `exchange_purchases`: INR acquisition requests and immutable policy snapshots.
- `audit_logs`: Administrative actions and security audit trail.

### Archival Metadata & Cursors
- `archive_repositories`: Storage metrics (`estimated_bytes_used`, `shard_generation`, `continuation_repo_key`, `continuation_repo_name`, `health_status`) for the 15 GitHub repositories.
- `archive_job_runs` (V5): Durable, concurrency-locked manual (`"Start GitHub Archive"`) and 24h scheduled archival job runs tracking 8-stage progression.
- `archive_batches`: Manifest history, checksums, record counts, and archival lifecycle status.
- `archived_record_ledger`: High-speed deduplication index of migrated record IDs.
- `accounting_checkpoints`: Immutable audit checkpoint tracking wallet balances at the moment of historical record clearance.

---

## 3. The 15 Private GitHub Archival Repositories (V5)

| # | Repository Key | Dataset Key | Description |
|---|---|---|---|
| 1 | `aeros-archive-market-index` | `old_market_candles` | Dedicated Market Index archive: historical 5m, 15m, and 1h OHLCV candles and AMI price snapshots. |
| 2 | `aeros-archive-trading-ledger` | `settled_market_orders` | Dedicated Trading Ledger archive: closed hedge-style trading positions, orders, and realized P&L settlements. |
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

---

## 4. The 24-Hour Archival Lifecycle & 12-Step State Machine

Terminal records become eligible for archival after $\ge 24\text{ hours}$ (`DEFAULT_GITHUB_ARCHIVE_MIN_AGE_HOURS`). The archival cycle follows 12 strict steps:

1. **Candidate Selection**: Select terminal records created/settled $\ge 24$ hours ago.
2. **Batch Chunking**: Bounded batches of up to 500 records (`GITHUB_BATCH_MAX_RECORDS`).
3. **Secret Sanitization**: Pass all records through `sanitizeRecordForArchive` to scrub password hashes, security code hashes, and session tokens.
4. **Deterministic Serialization**: Format records into newline-delimited JSON (`.jsonl`).
5. **Manifest Generation**: Create `-manifest.json` containing record count, timestamp, and local SHA-256 hash.
6. **Payload Upload**: Commit `.jsonl` and `-manifest.json` to the assigned GitHub repository via the GitHub Contents API.
7. **Monthly Index Update**: Append entry to `index/YYYY-MM/<dataset>.json` with exponential backoff on HTTP 409 conflict.
8. **Catalog Update**: Update root `index/catalog.json`.
9. **Remote Read-Back & Checksum Verification**:
   - Re-fetch the `.jsonl` payload from GitHub via the REST API.
   - Compute SHA-256 hash of the remote bytes.
   - Assert `remoteHash === localHash`. If fetch fails or hashes mismatch, abort immediately.
10. **Accounting Checkpoint**: Insert snapshot row in `accounting_checkpoints`.
11. **Ledger Record**: Record IDs in `archived_record_ledger`.
12. **Safe Neon Deletion**: Only after steps 1–11 pass, delete the source rows from Neon inside an atomic transaction.

---

## 5. V5 Storage Health Monitoring & 900 MB Continuation Rollover

Each of the 15 GitHub repositories is monitored against the V5 900 MB operating cap:
- **Normal (`< 800 MB`)**: Repository operates in `NORMAL` health.
- **Warning (`>= 800 MB`)**: Flags repository status as `WARNING` (`GITHUB_V5_REPO_WARNING_BYTES`), displaying a storage alert banner in the Government panel and user status notice.
- **Critical & Continuation Rollover (`>= 900 MB`)**: At `900 MB` (`GITHUB_V5_REPO_HARD_LIMIT_BYTES`), `evaluateRepoStorageHealthV5` returns `CRITICAL` and automatically rolls over active writes to the next continuation repository (`<repo>-2`, `<repo>-3`) via `getContinuationRepoName`, preserving all prior repositories as read-only historical shards.

---

## 6. Historical Data Retrieval & Fallback

Citizens and administrators can view historical transactions seamlessly:
- On `/transactions` and `/gov/transactions`, users can toggle **`+ Include GitHub Archive`** (`?includeArchived=1`).
- The application queries the GitHub archive using `fetchArchivedBatchRecordsFromGithub`, paginates records, and merges them into the UI with the `ARCHIVED · GITHUB` indicator badge.

