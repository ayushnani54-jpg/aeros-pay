<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AEROS PAY — PERMANENT PROJECT INSTRUCTIONS & WORKSPACE RULES

## 1. PROJECT IDENTITY & SCOPE
- **Product Name**: **Aeros Pay** (strictly permanent; never rename to Aerospace, Eros Pay, or any variant).
- **Virtual Currency**: **Aeros** (strictly whole-number integers `integer` in PostgreSQL; zero floating-point or fractional units anywhere in the application).
- **Current Version**: **V5.0** (Next.js 16 App Router, Neon Serverless PostgreSQL + Drizzle ORM, 15-Repository GitHub Historical Archival Architecture with 900 MB Rollover Cap).
- **Project Purpose**: A closed-loop sovereign virtual economy platform with **Citizens (Users)**, **Registered Companies**, and a central **Government (Treasury)** authority. It is designed to be a robust, secure, multi-user financial application, prioritizing correctness, data integrity, auditability, and failure recovery.

## 2. WORKSPACE BOUNDARY & SOURCE OF TRUTH
- **Permanent Workspace**: The opened project root (`d:\vscode projects\antigravity-Projects\Aeros Pay`) is the sole canonical workspace. All code, instructions, tests, migrations, and documentation must reside here.
- **Single Source of Truth**:
  1. The actual runtime source code (`src/`), database schema (`src/db/schema.ts`), migration history (`drizzle/`), and reproducible test scripts (`scripts/`).
  2. The Master Architecture Blueprint at `docs/architecture/AEROS_PAY_V5_MASTER_BLUEPRINT.md` (alongside `docs/architecture/AEROS_PAY_V4_1_MASTER_BLUEPRINT.md`) and version archive under `docs/versions/` provide intended architectural behavior.
  3. If a discrepancy exists between documentation and implementation, investigate and verify before modifying code. Never guess or fabricate behavior.

## 3. CORE ECONOMIC & ARCHITECTURAL INVARIANTS
1. **Monetary Supply Invariant**:
   $$\text{Total Circulating Supply} = \sum \text{User Balances} + \sum \text{Company Balances} + \text{Government Treasury Balance}$$
   - P2P transfers, invoices, marketplace escrow, citizen jobs, company partnerships, loans, refunds, and synthetic market trading **never** create or destroy Aeros.
   - Only authorized Government monetary issuance (`ISSUANCE_CREDIT`) increases total supply.
2. **Atomic Financial Operations**:
   - Every balance transfer, tax deduction, escrow lock/release, synthetic market order, partnership funding/settlement, and refund credit settles atomically inside `db.transaction(...)` with row-level locks and idempotency keys (`idempotency_key`).
3. **Hybrid Neon + 15-Repository GitHub Architecture**:
   - **Neon PostgreSQL**: Holds active operational state (users, active balances, open loans/contracts/jobs/partnerships/positions, active `<7d` media, and hot `<24h` activity). Live size is kept lean.
   - **15 Private GitHub Repositories**: Serve as permanent append-only historical storage across 15 dedicated categories (`aeros-archive-market-index`, `aeros-archive-trading`, `aeros-archive-payments`, `aeros-archive-wallets`, `aeros-archive-marketplace-listings`, `aeros-archive-marketplace-orders`, `aeros-archive-jobs`, `aeros-archive-contracts`, `aeros-archive-partnerships`, `aeros-archive-company-finance`, `aeros-archive-loans`, `aeros-archive-media`, `aeros-archive-governance`, `aeros-archive-audit`, `aeros-archive-system-ops`) with a **900 MB operating cap** and automatic `<repo>-2` overflow provisioning.
   - **24-Hour Archival Rule (7-Day for Media)**: Terminal/closed records become candidates after `>= 24 hours` (`>= 7 days` for Aeros Media). Neon records are **never** deleted merely because retention elapsed. Deletion only occurs after deterministic `.jsonl` upload, monthly index update, and **remote read-back SHA-256 checksum verification** from GitHub.
4. **Security & Credential Protection**:
   - Zero sensitive credentials, `.env` variables, tokens, password hashes, or security code hashes may be exposed, committed to git, or sent to GitHub archives (`sanitizeRecordForArchive` must be used).

## 4. 10-STEP ENGINEERING WORKFLOW
Every agent working on this codebase must follow this disciplined workflow:
1. **Inspect**: Read the relevant files in `src/`, database schema, and existing tests.
2. **Trace**: Follow the exact data and control flow across client, server actions, and database.
3. **Root Cause**: Identify the exact issue, invariant requirement, or constraint.
4. **Invariants Check**: Verify impact on the monetary supply invariant, idempotency, and database constraints.
5. **Plan**: Formulate the minimal safe, coherent modification.
6. **Implement**: Apply edits directly to the real application codebase.
7. **Verify**: Execute the full verification suite (TypeScript, ESLint, unit/integration tests).
8. **Diff Audit**: Review the change diff for regressions, unintended side effects, or security gaps.
9. **Document**: Update affected documentation in `docs/` and log entries in `docs/CHANGELOG.md`.
10. **Report**: Accurately describe what was changed, verification results, and any remaining risks.

## 5. STANDARD VERIFICATION COMMANDS
From the workspace root, run:
```powershell
# 1. Full TypeScript Typecheck (0 errors)
npx.cmd tsc --noEmit

# 2. ESLint (0 errors, 0 warnings)
npm.cmd run lint

# 3. V4 Verification Suite (Exchange, Market Engine, Core Accounting Invariants)
npm.cmd run test:v4

# 4. V4.1 Verification Suite (5-Repo Legacy Alias Mapping, Chart Zoom/Pan, Short Selling)
npm.cmd run test:v4:1

# 5. V5 Verification Suite (15-Repo GitHub Archive, 900 MB Rollover, Hedge Trading, Jobs, Partnerships, Media, Live Neon DB Audit)
npm.cmd run test:v5

# 6. Production Next.js Build (65 routes)
npm.cmd run build
```

## 6. PROJECT RULES & SPECIALIZED SKILLS
The project maintains focused workspace rules and specialized skills:
- **Rules (`.agents/rules/`)**:
  - [aeros-pay-core.md](file:///d:/vscode%20projects/antigravity-Projects/Aeros%20Pay/.agents/rules/aeros-pay-core.md): Core platform philosophy, naming, and architectural conventions.
  - [data-integrity.md](file:///d:/vscode%20projects/antigravity-Projects/Aeros%20Pay/.agents/rules/data-integrity.md): Strict accounting invariants, transaction atomicity, and archive verification.
  - [security-and-secrets.md](file:///d:/vscode%20projects/antigravity-Projects/Aeros%20Pay/.agents/rules/security-and-secrets.md): Auth session rules, credential handling, sanitization, and environment protection.
  - [testing-and-release.md](file:///d:/vscode%20projects/antigravity-Projects/Aeros%20Pay/.agents/rules/testing-and-release.md): Verification gates, zero regression tolerance, and deployment readiness.
- **Specialized Skills (`.agents/skills/`)**:
  - `aeros-pay-code-change`: End-to-end safe application feature modification and documentation updates.
  - `safe-bug-fixing`: Systematic bug reproduction, root-cause isolation, and regression test authoring.
  - `neon-migrations`: Safe Drizzle/PostgreSQL migrations without production data loss.
  - `github-archive`: Maintaining the 5-repository GitHub archive lifecycle, checksums, and recovery.
  - `production-audit`: Security, accounting invariant, and deployment audit workflows.
