# Aeros Pay — Future Development Process

This guide outlines the precise development procedures for future engineering tasks on Aeros Pay. Each task type maps directly to a specialized agent skill and appropriate level of verification.

---

## Task-Specific Workflows

### 1. Bug Fixes
- **Relevant Skill**: `.agents/skills/safe-bug-fixing/SKILL.md`
- **Workflow**:
  1. Reproduce the bug using an automated script or test case in `scripts/test/`.
  2. Perform root-cause analysis (identify schema, concurrency, integer rounding, or validator cause).
  3. Implement the minimal fix. Avoid symptom-masking or cosmetic patches.
  4. Convert the reproduction script into a permanent automated regression test.
  5. Run verification gates (`npm.cmd run test:v4:1`, `npx.cmd tsc --noEmit`).

### 2. New Features
- **Relevant Skill**: `.agents/skills/aeros-pay-code-change/SKILL.md`
- **Workflow**:
  1. Inspect existing routes, Server Actions, and UI components.
  2. Maintain whole-number integer math and the monetary supply invariant.
  3. Validate all inputs using Zod in `src/lib/validators.ts`.
  4. Implement Server Actions with `db.transaction(...)` and row-level locks where balances change.
  5. Build responsive UI using Tailwind CSS v4 and React 19 Server Components.
  6. Update relevant documentation in `docs/` and add entries to `docs/CHANGELOG.md`.

### 3. Architecture & High-Risk Changes
- **Relevant Skills**: `aeros-pay-code-change`, `production-audit`
- **Workflow**:
  1. Perform deep impact analysis on accounting invariants, database locks, and performance.
  2. Ensure backward compatibility with existing operational state.
  3. Update `docs/ARCHITECTURE.md` and `docs/BUSINESS_INVARIANTS.md`.
  4. Run full test suites (`test:v4`, `test:v4:1`) and Next.js production build (`npm.cmd run build`).

### 4. Database Schema Migrations
- **Relevant Skill**: `.agents/skills/neon-migrations/SKILL.md`
- **Workflow**:
  1. Inspect current schema in `src/db/schema.ts` and migration history in `drizzle/`.
  2. Modify `src/db/schema.ts` using additive, non-destructive alterations.
  3. Run `npm.cmd run db:generate` to produce the sequential migration file.
  4. Never execute destructive operations (`DROP`, `TRUNCATE`) against production.
  5. Provide manual SQL execution and rollback scripts in documentation.

### 5. Security-Sensitive Changes
- **Relevant Skills**: `production-audit`, `security-and-secrets` rules
- **Workflow**:
  1. Review session handling (`src/lib/session.ts`), auth guards (`src/lib/auth.ts`), and password hashing (`src/lib/crypto.ts`).
  2. Verify session epoch revocation is preserved.
  3. Ensure sensitive files retain `import "server-only";`.
  4. Ensure `sanitizeRecordForArchive` continues scrubbing all secrets before archival.
  5. Verify no credentials or `.env` files are tracked in version control.

### 6. Archival Maintenance
- **Relevant Skill**: `.agents/skills/github-archive/SKILL.md`
- **Workflow**:
  1. Maintain mapping across the 11 datasets and 5 private GitHub repositories.
  2. Never relax the remote read-back SHA-256 verification requirement prior to Neon row deletion.
  3. Respect repository size limits (400 MB warning, 750 MB rotation).
  4. Test offline and failure-mode recovery via `setGithubArchiveTransportForTest`.

### 7. Production Audits & Release Preparation
- **Relevant Skill**: `.agents/skills/production-audit/SKILL.md`
- **Workflow**:
  1. Execute all 5 local quality gates.
  2. Perform comprehensive code and dependency review.
  3. Verify `.gitignore` coverage.
  4. Produce an audit report detailing gate results and readiness assessment.

---

## Deployment & Production Safeguards
- **Never Automatically Deploy**: Do not push to remote repositories, trigger production builds on Vercel, or alter production environment variables without explicit user instruction.
- **Vercel Hobby Invariants**: Preserve the existing daily cleanup schedule in `vercel.json` (`schedule: "30 18 * * *"`).
- **Documentation Hygiene**: Every significant change must update `docs/CHANGELOG.md` and, for major version milestones, `docs/versions/VERSION_HISTORY.md`.
