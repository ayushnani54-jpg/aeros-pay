# Aeros Pay — Version History & Blueprint Archive

This document serves as the chronological, version-by-version ledger of the Aeros Pay application evolution from V1 to V4.1 and into future versions (V5, V6, V7, V8, etc.).

---

## Evolution Timeline

| Version | Status | Blueprint Document | Migration Scripts | Key Architectural Milestone |
|---|---|---|---|---|
| **V1.0** | Completed | Archived in V2 notes | `0000_previous_ares.sql`, `0001_tx_ref_seq.sql` | Closed-loop economy, Citizens, Government Treasury, P2P transfers. |
| **V2.0** | Completed | [UPGRADE-V2.md](./UPGRADE-V2.md) | `0002_v2_upgrade.sql`, `0003_v2_sales_loans.sql`, `0004_configurable_policy.sql` | Registered Companies, Invoices, Corporate Loans, Support, IP Complaints. |
| **V3.0** | Completed | [UPGRADE-V3.md](./UPGRADE-V3.md) | `0005_v3.sql`, `0006_offline_payments.sql`, `0007_max_companies.sql` | Marketplace Escrow, Contracts, Wanted Board, Promotions, CSV/JSON Exports. |
| **V4.0** | Completed | [UPGRADE-V4.md](./UPGRADE-V4.md) | `0008_v4_upgrade.sql` | Aeros Exchange (INR-to-Aeros), Synthetic Market Index (AMI), Refund Center. |
| **V4.1** | Completed | [AEROS_PAY_V4_1_BLUEPRINT.md](./AEROS_PAY_V4_1_BLUEPRINT.md) | `0009_v4_1_github_archive_and_short_selling.sql` | 5-Repo GitHub Archive, Chart Zoom/Pan, Collateralized Short Selling. |
| **V5.0** | **Current** | [AEROS_PAY_V5_MASTER_BLUEPRINT.md](../architecture/AEROS_PAY_V5_MASTER_BLUEPRINT.md) | `0010_v5_upgrade.sql` | 15-Repo GitHub Archive (900 MB Rollover), Hedge Trading (2x–10x), Citizen Jobs, Company Partnerships, Aeros Media, Mobile-First UI. |

---

## Detailed Version Records

### Version 5.0 (Current Production Release)
- **Status**: Completed & Verified.
- **Blueprint**: [AEROS_PAY_V5_MASTER_BLUEPRINT.md](../architecture/AEROS_PAY_V5_MASTER_BLUEPRINT.md).
- **Database Migration**: `drizzle/0010_v5_upgrade.sql`.
- **Key Changes & Features**:
  1. **15-Repository Private GitHub Archive Architecture & 900 MB Threshold**:
     - Dedicated repositories for Market Index (`aeros-archive-market-index`), Trading Ledger (`aeros-archive-trading-ledger`), and 13 domain categories (`registry-v5.json`).
     - 800 MB warning / 900 MB hard operating limit with automatic `<repo>-2`, `<repo>-3` continuation rollover.
     - Manual `"Start GitHub Archive"` durable job runner (`archive_job_runs`) + 24h automatic cron pipeline with SHA-256 read-back verification before Neon deletion.
  2. **Market Update Interval (`1m`/`5m`) & 5-Minute Candle Synchronization**:
     - Configurable 1-minute (default) or 5-minute market tick interval (`government.market_update_interval_minutes`), fixing the 5-minute candle update defect.
  3. **Hedge-Style Trading (`BUY` = `LONG`, `SELL` = `SHORT`) & Leverage Progression (`2x → 4x → 8x → 10x`)**:
     - Independent positions (`market_trade_positions`) that never auto-net; explicit per-position `Close Position` button; progressive leverage unlocks (`leverage_requests`) up to `10x` max.
  4. **Marketplace Redesign & Citizen Jobs (`jobs`, `job_applications`)**:
     - Separated Public Listings, Citizen Jobs Board, and My Activity; Government and Registered Companies hire and pay Citizens atomically.
  5. **Company-to-Company Partnerships (`company_partnerships`, `partnership_settlements`)**:
     - Proposal, partner acceptance, Government approval & tax rate, and atomic 50/50 revenue settlement conserving 100% of `SUPPLY_INVARIANT`.
  6. **Aeros Media (`media_posts`, `media_comments`, `media_likes`, `media_shares`)**:
     - Text-only social platform with `@mentions`, likes, comments, shares, tipping links, 7-day public retention window, and Government moderation.
  7. **Global Action & Loading Notification System & Mobile-First UI**:
     - Persistent yellow/amber processing banner below navbar + bottom floating toast notification across user and admin actions.

---

### Version 4.1 (Prior Production Release)
- **Status**: Completed & Verified.
- **Blueprint**: [AEROS_PAY_V4_1_BLUEPRINT.md](./AEROS_PAY_V4_1_BLUEPRINT.md) (and canonical master copy at `docs/architecture/AEROS_PAY_V4_1_MASTER_BLUEPRINT.md`).
- **Database Migration**: `drizzle/0009_v4_1_github_archive_and_short_selling.sql`.
- **Key Changes & Features**:
  1. **5-Repository GitHub Permanent Archival Architecture**:
     - Neon PostgreSQL holds active state and recent `< 24h` events (~11.8 MB).
     - 5 Private GitHub repositories store 11 historical datasets (`aeros-archive-ledger`, `aeros-archive-contracts`, `aeros-archive-market`, `aeros-archive-economy`, `aeros-archive-audit`).
     - 12-Step resumable 24-hour archival engine (`run24HourGithubArchivalCycle`) with secret sanitization.
     - Remote read-back SHA-256 verification before clearing records from Neon.
     - Storage threshold monitoring (400 MB warning, 750 MB hard shard rotation).
  2. **Trading Chart Zoom, Pan & Visible Y-Axis Auto-Scaling (Defect 6.A Fix)**:
     - Zoom In (`+`), Zoom Out (`-`), Mouse-wheel zoom anchored to cursor.
     - Pan Left (`<-`), Pan Right (`->`), Drag-to-pan across candlestick chart.
     - Dynamic visible-window Y-scale (`computeVisibleYScale`) tightly fitting visible candle range.
     - Window presets (`16c`, `32c`, `48c`, `96c`, `All`) and historical cursor pagination (`Load Older`).
  3. **Collateralized Short Selling (Defect 6.B Fix)**:
     - Enabled `SHORT` and `COVER` order modes on `/aeros-market`.
     - Automatic routing from `SELL` to `SHORT` when `unitsHeld === 0`.
     - Locks 100% collateral into Treasury; cover payout clamped at $\ge 0$ to strictly prevent negative user balances.
  4. **One-Click Verified ZIP Bundle**: Single-click PKZIP archive containing all 11 historical datasets with manifests and checksums.
  5. **Unified Citizen Ledger with GitHub Archive Fallback**: `/transactions` toggle (`+ Include GitHub Archive`) transparently pulls from `aeros-archive-ledger`.
  6. **Citizen Economy Hub & Passport**: Quick-launch hubs on `/dashboard` and verifiable milestones on `/profile`.
- **Breaking Changes**: None to database schema (additive columns only).
- **Known Limitations & Risks**:
  - Live GitHub archival requires GitHub personal access token with repo scope (`GITHUB_ARCHIVE_TOKEN`).
  - Next.js production build takes ~67s for TypeScript checks due to 64 routes.

---

### Version 4.0
- **Status**: Completed.
- **Reference**: [UPGRADE-V4.md](./UPGRADE-V4.md).
- **Database Migration**: `drizzle/0008_v4_upgrade.sql`.
- **Key Features**:
  - Aeros Exchange: INR-to-Aeros policy packages with immutable purchase snapshots.
  - Synthetic Market Index: Deterministic 5m/15m/1h OHLCV generator and order book.
  - Refund Center: Virtual refund requests, dispute delay notices, and treasury payout settlements.
  - Initial Archive Center: Local PKZIP builder with accounting checkpoints.

---

### Version 3.0
- **Status**: Completed.
- **Reference**: [UPGRADE-V3.md](./UPGRADE-V3.md).
- **Database Migration**: `drizzle/0005_v3.sql`, `0006_offline_payments.sql`, `0007_max_companies.sql`.
- **Key Features**:
  - Marketplace Offers & Escrow-locked orders.
  - Bounty & Milestone Contracts.
  - Buyer Wanted Board.
  - Company Homepage Promotions.
  - CSV/JSON Streaming Exports.

---

### Version 2.0
- **Status**: Completed.
- **Reference**: [UPGRADE-V2.md](./UPGRADE-V2.md).
- **Database Migration**: `drizzle/0002_v2_upgrade.sql`, `0003_v2_sales_loans.sql`, `0004_configurable_policy.sql`.
- **Key Features**:
  - Registered Companies and multi-member permissions.
  - Itemized Invoice billing and official receipt printing.
  - Government Business Loans with instalment schedules.
  - Support ticket threads and Intellectual Property complaints.

---

### Version 1.0
- **Status**: Completed.
- **Database Migration**: `drizzle/0000_previous_ares.sql`, `0001_tx_ref_seq.sql`.
- **Key Features**:
  - Foundation closed-loop economy.
  - Citizens, Government Treasury singleton.
  - Peer-to-peer Aeros transfers and transfer tax deduction.
  - Single-use invite code registration.

---

## Upgrade Protocol for Future Versions (V5, V6, etc.)
When preparing a new major version:
1. **Preserve Prior Blueprint**: Ensure the previous version blueprint (e.g. `AEROS_PAY_V4_1_BLUEPRINT.md`) is preserved untouched.
2. **Document Evolution**: Add a new section in `VERSION_HISTORY.md` detailing new features, database schema changes, and invariants.
3. **Draft New Blueprint**: Create `docs/versions/AEROS_PAY_V<N>_BLUEPRINT.md` capturing the complete actual implementation.
4. **Update Changelog**: Add entries in `docs/CHANGELOG.md`.
