# Aeros Pay — Changelog

All notable changes to the Aeros Pay project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to Semantic Versioning.

## [5.0.0] - 2026-10-12

### Added
- **15-Repository Private GitHub Historical Archive Architecture**:
  - Partitioned 15 historical datasets across 15 dedicated private GitHub repositories (`GITHUB_ARCHIVE_REPO_KEYS_V5`), including dedicated repositories for Market Index (`aeros-archive-market-index`) and Trading Ledger (`aeros-archive-trading-ledger`).
  - Added `github-repos-bootstrap/registry-v5.json` and 15 repository bootstrap directories (`README.md`, `schema/archive-schema-v5.0.json`, `index/catalog.json`).
  - Configured 900 MB operating threshold (`GITHUB_V5_REPO_HARD_LIMIT_BYTES`) and 800 MB warning threshold (`GITHUB_V5_REPO_WARNING_BYTES`) with automatic continuation repository rollover (`<repo>-2`, `<repo>-3`).
  - Added durable manual `"Start GitHub Archive"` job runner (`archive_job_runs`) with concurrency locking and 8-stage pipeline tracking.
- **Market Update Interval (`1m` / `5m`) & 5-Minute Candle Aggregation Fix**:
  - Added Government-configurable market update interval (`1` minute default or `5` minutes) in `government.market_update_interval_minutes`.
  - Fixed 5-minute candle bucket synchronization so `5m`, `15m`, and `1h` candles update deterministically on interval boundaries.
- **Hedge-Style Trading (`BUY` = `LONG`, `SELL` = `SHORT`) & Leverage Progression (`2x → 4x → 8x → 10x`)**:
  - Added independent hedge trading positions (`market_trade_positions`) where opposing trades never auto-net or cancel each other.
  - Added explicit per-position `Close Position` actions and Beginner's Trading Guide on `/aeros-market`.
  - Added Citizen leverage progression (`2x` default, progressive requests for `4x`, `8x`, and `10x` max via `leverage_requests`).
- **Marketplace Redesign & Citizen Jobs (`jobs`, `job_applications`)**:
  - Separated Public Goods & Services, Citizen Jobs Board, and My Activity on `/market`.
  - Enabled Government and Registered Companies to offer jobs to Citizens with atomic compensation payout on completion.
- **Company-to-Company Partnerships (`company_partnerships`, `partnership_settlements`)**:
  - Implemented corporate alliance proposals, partner acceptance, Government regulatory approval with tax configuration, and atomic 50/50 revenue settlement.
- **Aeros Media (`media_posts`, `media_comments`, `media_likes`, `media_shares`)**:
  - Built text-only social feed at `/media` with `@mentions`, likes, comments, shares, direct Aeros tipping links, 7-day public retention window, and Government moderation.
- **Global Action & Loading Notification System & Mobile-First UI Redesign**:
  - Added persistent yellow/amber processing banner below the navbar + bottom floating toast (`GlobalActionFeedbackProvider` and `V5ActionForm`).
  - Upgraded mobile-first responsive layouts, anti-zoom 16px form inputs, and section accent themes across the application.

### Fixed
- **Government Archive Center (`/gov/archive`) SSR & 15-Repository Pipeline**:
  - Fixed `getArchiveCenterV41Overview()` filtering and fallback metadata when 15 V5 repositories exist alongside 5 legacy repositories in `archive_repositories`.
  - Added `CREATE SEQUENCE IF NOT EXISTS` guards in `nextArchiveBatchNumber()` and `nextCheckpointNumber()`.
  - Fixed `GovArchiveV5Panel` stage progression bar to highlight active phase (`currentPhase`) rather than only job status, and added clickable GitHub repository links (`https://github.com/ayushnani54-jpg/<repo>`), remaining headroom before 900 MB, and per-repo verification status.
  - Extended `startOrResumeV5ArchiveJob()` to evaluate all 15 V5 dataset categories and sync V5 repository counters.
- **Aeros Media Timestamps & Clean UI Presentation**:
  - Rendered formatted creation timestamps (`createdAt`) on all Aeros Media posts and comments in `aeros-media-feed.tsx` instead of displaying raw internal `postNumber` IDs.
  - Removed internal `"V5"` version badges from user-facing navigation bars and section headers.

## [4.1.0] - 2026-10-11

### Added
- **Permanent Antigravity Workspace Initialization**: Imported complete V4.1 application directly into root workspace (`d:\vscode projects\antigravity-Projects\Aeros Pay`).
- **Antigravity Instructions & Rules**: Root `AGENTS.md` and dedicated workspace rules in `.agents/rules/` (`aeros-pay-core.md`, `data-integrity.md`, `security-and-secrets.md`, `testing-and-release.md`).
- **5 Specialized Agent Skills**: Modular skills created under `.agents/skills/`:
  - `aeros-pay-code-change`
  - `safe-bug-fixing`
  - `neon-migrations`
  - `github-archive`
  - `production-audit`
- **Hybrid Neon + 5-Repository GitHub Archival Architecture**:
  - Partitioned 11 historical datasets across 5 private GitHub repositories (`aeros-archive-ledger`, `aeros-archive-contracts`, `aeros-archive-market`, `aeros-archive-economy`, `aeros-archive-audit`).
  - 12-Step resumable 24-hour archival state machine (`run24HourGithubArchivalCycle`).
  - Remote read-back SHA-256 checksum verification before clearing any source records from Neon.
  - Storage threshold monitoring (400 MB soft warning / 750 MB hard shard rotation).
- **Trading Chart Enhancements (Defect 6.A Fix)**:
  - Interactive SVG candlestick chart with Zoom In (`+`), Zoom Out (`-`), Mouse-wheel zoom, and Pan (`<-`/`->`).
  - Window presets (`16c`, `32c`, `48c`, `96c`, `All`) and `Reset / Fit`.
  - Visible-window Y-axis auto-scaling (`computeVisibleYScale`) tightly bound to visible candle highs/lows.
  - Historical candle pagination (`Load Older`).
- **Collateralized Short Selling (Defect 6.B Fix)**:
  - Added `SHORT` and `COVER` order modes on `/aeros-market`.
  - Automatic routing from `SELL` to `SHORT` when `unitsHeld === 0`.
  - 100% collateral locking into Treasury reserves with non-negative payout clamping on price spikes.
- **Unified Transaction Ledger Archive Fallback**:
  - Added `+ Include GitHub Archive` toggle on `/transactions` querying `aeros-archive-ledger` transparently.
- **Download All Archive Bundle**: Single-click PKZIP bundle with manifest and SHA-256 proofs.
- **Citizen Economy Hub & Passport**: Quick-launch cards and milestone badges on `/dashboard` and `/profile`.

## [4.0.0] - 2026-09-15
### Added
- Aeros Exchange INR-to-Aeros fixed policy acquisitions with immutable policy snapshots.
- Internal deterministic Synthetic Market Index (`AMI`) and 5m/15m/1h OHLCV engine.
- Virtual Refund Center for transaction claims.
- Archive Center with local PKZIP generator and accounting checkpoints.

## [3.0.0] - 2026-08-01
### Added
- Decentralized Marketplace with escrow order locks (`ESCROW_LOCKED`).
- Milestone and bounty contracts (`marketplace_contracts`).
- Buyer wanted board (`marketplace_wanted_requests`).
- Company homepage promotions and CSV/JSON export tools.

## [2.0.0] - 2026-07-01
### Added
- Registered companies and corporate wallets.
- Itemized invoice billing system (`invoices`).
- Government business loans with structured instalment schedules (`loans`).
- Support ticketing and IP complaint dispute systems.

## [1.0.0] - 2026-06-01
### Added
- Initial closed-loop economy launch: Citizens, Government Treasury singleton.
- Peer-to-peer Aeros transfers with basis-point transfer tax.
- Single-use invite code registration system.
