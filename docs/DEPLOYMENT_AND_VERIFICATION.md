# Aeros Pay — Deployment & Verification Guide

## 1. Hosting Platform & Environment Configuration

Aeros Pay is configured for deployment on **Vercel** with Next.js 16 and **Neon Serverless PostgreSQL**.

### Required Environment Variables

```env
# 1. Database (Neon Serverless PostgreSQL)
DATABASE_URL="postgres://user:password@ep-sample.us-east-2.aws.neon.tech/neondb?sslmode=require"

# 2. Authentication & Session Secrets (HMAC-SHA256, 32+ characters)
SESSION_SECRET="your-32-char-random-secret-for-citizen-sessions"
GOV_SESSION_SECRET="your-32-char-random-secret-for-government-sessions"

# 3. GitHub Archival Integration (5 Private Repositories)
GITHUB_ARCHIVE_TOKEN="ghp_yourPersonalAccessTokenWithRepoScope"
GITHUB_ARCHIVE_OWNER="your-github-org-or-username"
GITHUB_ARCHIVE_BRANCH="main"
GITHUB_ARCHIVE_ENABLED="true"

# Repository Overrides (Optional — defaults to repoKey names)
GITHUB_REPO_LEDGER="aeros-archive-ledger"
GITHUB_REPO_CONTRACTS="aeros-archive-contracts"
GITHUB_REPO_MARKET="aeros-archive-market"
GITHUB_REPO_ECONOMY="aeros-archive-economy"
GITHUB_REPO_AUDIT="aeros-archive-audit"

# 4. Scheduled Retention Cron
CRON_SECRET="your-vercel-cron-bearer-token"
```

---

## 2. Vercel Cron & Hobby Plan Constraints

- Configuration is specified in `vercel.json`:
  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "crons": [
      {
        "path": "/api/cron/cleanup",
        "schedule": "30 18 * * *"
      }
    ]
  }
  ```
- **Hobby Plan Invariant**: Vercel Hobby allows only **one cron execution per day**. Do not change the cron schedule to hourly or per-minute expressions on Hobby plans.
- **Fail-Safe Design**: If the cron is skipped or delayed, the retention and archival routines are idempotent and catch up on the subsequent run.

---

## 3. Standard Verification Suite (Local Quality Gates)

Run these five commands from the workspace root before any commit or release:

```powershell
# Gate 1: Strict TypeScript Compilation (0 errors)
npx.cmd tsc --noEmit

# Gate 2: ESLint Static Analysis (0 errors, 0 warnings)
npm.cmd run lint

# Gate 3: V4 Financial & Invariants Test Suite
npm.cmd run test:v4

# Gate 4: V4.1 5-Repo GitHub Archival & Market Suite
npm.cmd run test:v4:1

# Gate 5: Production Next.js Build (64 routes)
npm.cmd run build
```

---

## 4. Post-Deployment Verification Checklist

1. **Government Portal**: Log into `/government/login`, access `/gov/control-room`, verify Treasury balance.
2. **Citizen Registration**: Generate invite code at `/gov/codes`, register new user at `/register`, verify initial grant (2,000 Aeros).
3. **P2P Transfer**: Execute transfer at `/send`, verify transfer tax deduction credited to Treasury.
4. **Synthetic Market**: Navigate to `/aeros-market`, verify interactive chart zoom/pan, place BUY and SHORT orders.
5. **Archival System**: Navigate to `/gov/archive`, verify healthy connectivity across all 5 repositories.
