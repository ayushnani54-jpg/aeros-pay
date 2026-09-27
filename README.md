# Aeros Pay

Aeros Pay is a private, closed-loop virtual economy for a small group of
friends or family. Members hold a virtual currency called **Aeros**, funded
initially by a fixed Government treasury, and send it to each other by
username. Every transaction is recorded in an immutable ledger.

**This is a game, not a financial product.** Aeros Pay is not a bank, not a
payment processor, not crypto, and not a blockchain. Aeros has no real-world
monetary value, cannot be exchanged for real currency inside the app, and
nothing here should be treated as financial infrastructure.

---

## Contents

1. [Tech stack](#tech-stack)
2. [Project structure](#project-structure)
3. [Database schema](#database-schema)
4. [Environment variables](#environment-variables)
5. [Local setup](#local-setup)
6. [Initializing the Government account](#initializing-the-government-account)
7. [Deploying to Vercel](#deploying-to-vercel)
8. [Core rules reference](#core-rules-reference)
9. [Security decisions](#security-decisions)
10. [Testing summary](#testing-summary)
11. [Known limitations](#known-limitations)

---

## Tech stack

- **Next.js 16** (App Router, Turbopack, Server Actions) — frontend + all
  server-side logic in one deployable app, no separate backend.
- **React 19**, **TypeScript**, **Tailwind CSS v4**.
- **PostgreSQL** — the single relational database, accessed through
  **Drizzle ORM** (`drizzle-orm` + `pg`).
- **jose** — stateless, signed JWT sessions (httpOnly cookies).
- **bcryptjs** — password / security-code hashing.
- **Zod** — server-side input validation on every mutation.

No microservices, no blockchain, no crypto libraries, no queue/worker
infrastructure. Everything runs as a single Next.js deployment plus one
Postgres database, matching the "GitHub → Vercel, nothing extra" deployment
target.

## Project structure

```
aeros-pay/
├── drizzle/                      Generated SQL migrations + snapshots
│   ├── 0000_previous_ares.sql
│   └── 0001_tx_ref_seq.sql       Adds the tx_ref_seq sequence
├── scripts/
│   ├── seed-government.ts        One-time Government account initializer
│   └── test/                     Dev-only manual test scripts (see Testing summary)
├── src/
│   ├── actions/                  Server Actions ("use server") — the only
│   │   ├── auth.ts                 way the UI mutates data
│   │   ├── government.ts
│   │   └── user.ts
│   ├── app/
│   │   ├── (public)/              Landing, login, register, gov login
│   │   ├── (app)/                 User-facing app (dashboard, send, …)
│   │   ├── gov/                   Government panel (its own layout/guard)
│   │   ├── icon.svg, apple-icon.tsx
│   │   ├── globals.css            Design tokens + minimal component classes
│   │   └── layout.tsx
│   ├── components/                UI components, split into forms/ (client,
│   │                               "use client") and presentational pieces
│   ├── db/
│   │   ├── schema.ts               Drizzle schema — source of truth for the DB
│   │   └── client.ts                Pooled pg connection
│   ├── lib/
│   │   ├── auth.ts                  requireUser / requireGovernment
│   │   ├── session.ts                JWT session helpers (user + gov, separate)
│   │   ├── password.ts               bcrypt hash/verify
│   │   ├── payments.ts               sendAeros, fundUserFromTreasury — the
│   │   │                              core money-movement engine
│   │   ├── issuance.ts               Community-approved Aeros issuance flow
│   │   ├── tax.ts                    computeTax()
│   │   ├── txref.ts                  Atomic human-readable transaction refs
│   │   ├── codes.ts                  Registration code generation
│   │   ├── db-errors.ts              Unique-violation detection helper
│   │   ├── audit.ts / notify.ts      Audit log + notifications/updates
│   │   ├── validators.ts             Zod schemas for every mutation
│   │   └── constants.ts              All economic + security constants
│   └── proxy.ts                    Fast cookie-presence redirect (not the
│                                     security boundary — see Security below)
├── drizzle.config.ts
├── .env.example
└── package.json
```

## Database schema

One Postgres database, nine tables, defined in `src/db/schema.ts` (Drizzle
is the source of truth; `drizzle/*.sql` are the generated migrations).

| Table                      | Purpose                                                                 |
|-----------------------------|--------------------------------------------------------------------------|
| `government`                | Singleton row: credentials, treasury balance, total supply, tax rate    |
| `registration_codes`        | One-time 4-digit codes (`UNUSED` / `USED` / `REVOKED`)                  |
| `users`                     | Username (unique, lowercase-enforced), password hash, balance, status   |
| `transactions`              | Immutable ledger — every Aeros movement, with tax breakdown             |
| `issuance_requests`         | Government-proposed new-Aeros requests (max 5,000 each)                 |
| `issuance_eligible_voters`  | Immutable snapshot of who was ACTIVE when a request was opened          |
| `issuance_votes`            | One vote per eligible user per request                                  |
| `audit_logs`                | Every administrative/system action, actor, target, metadata             |
| `updates`                   | Public announcement feed                                                |
| `notifications`             | Per-user in-app notifications                                           |

Integrity is enforced at the database level, not just in application code:
`CHECK` constraints on non-negative balances, tax-rate bounds (0–10000 bp),
issuance amount bounds (1–5000), 4-digit registration-code format, and
lowercase usernames; unique constraints on username, registration code,
transaction reference, and (request, user) pairs for both eligible-voter
snapshots and votes.

## Environment variables

See `.env.example` for the full annotated list. Summary:

| Variable             | Required | Purpose                                                        |
|-----------------------|----------|------------------------------------------------------------------|
| `DATABASE_URL`        | always   | Postgres connection string                                      |
| `AUTH_SECRET`         | always   | ≥32-char secret signing all session JWTs                        |
| `GOV_USERNAME`        | seed only| Government login username, read once by `seed:government`       |
| `GOV_PASSWORD`        | seed only| Government login password (≥8 chars), read once                 |
| `GOV_SECURITY_CODE`   | seed only| Government 2nd factor, ≥5 uppercase alphanumeric, read once     |

The three `GOV_*` variables are only ever read by the one-time seed script —
nothing else in the app reads them, and they can be removed from the
environment after seeding a deployment.

## Local setup

Prerequisites: Node 20+, a running PostgreSQL instance.

```bash
npm install

cp .env.example .env
# edit .env: set DATABASE_URL, AUTH_SECRET, and the three GOV_* values

npx drizzle-kit migrate        # creates all tables, enums, constraints, the tx_ref_seq sequence

npm run seed:government        # one-time: creates the Government account (see below)

npm run dev                    # http://localhost:3000
```

Government generates registration codes from the Government panel
(`/government/login` → Codes), and shares each 4-digit code with one person
to register with.

## Initializing the Government account

`npm run seed:government` (wraps `tsx scripts/seed-government.ts`) is the
only way to create the Government account:

- Reads `GOV_USERNAME`, `GOV_PASSWORD`, `GOV_SECURITY_CODE` from the
  environment.
- **Idempotent**: if a Government row already exists, it prints a message
  and exits without changes — safe to include in a deploy pipeline.
- Seeds the treasury and total supply to `10,000` Aeros, tax rate to the
  default `5.00%`, records a `GOVERNMENT_INITIALIZED` audit log entry, and
  publishes a "Aeros Pay launched" update.
- Passwords/security codes are bcrypt-hashed (12 rounds) before being
  written — the plaintext values are never stored.

Run it once per deployment, right after migrating:

```bash
GOV_USERNAME=government GOV_PASSWORD='...' GOV_SECURITY_CODE='G7K2P' \
  npm run seed:government
```

(Or simply have those three variables set in the environment already, e.g.
in `.env` locally or your platform's env settings for a one-off remote run.)

## Deploying to Vercel

1. Push this repository to GitHub.
2. In Vercel, "Import Project" from that GitHub repo. Framework preset
   `Next.js` is auto-detected — no build command changes needed.
3. Provision a Postgres database (Vercel Postgres, Neon, Supabase, Railway,
   or any reachable Postgres instance) and set `DATABASE_URL` in the
   Vercel project's Environment Variables.
4. Set `AUTH_SECRET` in Vercel's Environment Variables (generate with
   `openssl rand -base64 48`).
5. Run the migration against the production database once, from your local
   machine (with `DATABASE_URL` pointed at production) or a one-off Vercel
   deploy/CI step:
   ```bash
   DATABASE_URL="<production-url>" npx drizzle-kit migrate
   ```
6. Run the Government seed once, the same way:
   ```bash
   DATABASE_URL="<production-url>" GOV_USERNAME=... GOV_PASSWORD=... \
     GOV_SECURITY_CODE=... npx tsx scripts/seed-government.ts
   ```
7. Deploy. Log in to `/government/login` with the seeded credentials and
   start generating registration codes for your group.

No other infrastructure is required — no separate API server, no queue, no
cron, no blockchain node.

## Core rules reference

These are the rules from the original specification, as implemented. Where
a genuine technical conflict required a decision, it's called out below.

- **Currency name**: always "Aeros" (`CURRENCY_NAME` constant used
  everywhere in the UI — never "Eros"/"Aros").
- **Initial treasury**: 10,000 Aeros, minted once at Government seed time.
  This is the entire initial money supply.
- **New-user funding**: Government sends exactly 2,000 Aeros from the
  treasury to each newly registered user (a manual action from the
  Government panel — Government chooses when to fund a new registrant).
- **Registration codes**: 4-digit, cryptographically random
  (`crypto.randomInt`), globally unique, one-time use, generated only by
  Government. Status is `UNUSED → USED` (permanently, tied to the user who
  used it) or `→ REVOKED`.
- **Usernames**: chosen at registration, normalized to lowercase, globally
  unique, permanent — there is no rename/change-username feature.
- **Passwords**: bcrypt-hashed (12 salt rounds), minimum 8 characters,
  never logged or returned by any query.
- **Government login**: username + password + a separate security code
  (≥5 uppercase alphanumeric characters), all three required. A wrong
  guess in any field returns the same generic "Invalid Government
  credentials." message — no field-level enumeration.
- **Minimum transaction**: 1 Aeros. Amounts are always whole numbers (no
  fractional Aeros).
- **Tax**: configurable rate (0–100%, stored in basis points), applied to
  every user→user transfer, credited to the Government treasury. A
  transaction of **exactly 1 Aeros is always tax-free** — enforced in
  `computeTax()` regardless of the configured rate. Each transaction stores
  the tax rate that was actually applied (`taxRateBpApplied`), so changing
  the rate later never rewrites history — verified in testing (see below).
- **Double-spend protection**: every transfer runs inside a single database
  transaction that row-locks (`SELECT ... FOR UPDATE`) sender, receiver, and
  (when relevant) the Government row, then applies a conditional atomic
  `UPDATE ... WHERE balance >= amount`. A balance can never go negative, and
  concurrent requests against the same sender cannot both succeed against
  insufficient funds — verified with a real concurrent test (see below).
- **Aeros issuance (new supply)**: Government proposes an amount (1–5,000)
  with a reason. Every user who was `ACTIVE` at that moment is snapshotted
  as an eligible voter (immutable — Government cannot add/remove voters
  from an open request after the fact). Execution requires **100%
  approval** from every eligible voter (a single reject permanently blocks
  it), at most **one execution per rolling 7-day period** system-wide, and
  a request can only ever be executed once.
- **Active user definition**: a user with `status = ACTIVE` at the moment
  an issuance request is created (not at vote time or execute time) — this
  is what gets snapshotted into `issuance_eligible_voters`.
- **Suspend / ban**: Government can suspend (reversible) or ban
  (reversible via "Restore to Active") a user. A suspended user cannot send
  Aeros; a banned user cannot send or receive. Full transaction history is
  preserved regardless of status — nothing is deleted or hidden.
- **Administrative balance adjustments**: Government can credit or debit
  any user's balance directly, with a required reason, recorded as its own
  transaction type and audit-logged with before/after balances. **Design
  decision**: adjustments move Aeros to/from the Government treasury (a
  credit debits the treasury, a debit credits the treasury) rather than
  minting/burning out of thin air, so `total_supply` is only ever changed
  by the issuance system — the total-supply invariant holds even for manual
  corrections. This was not explicitly specified either way; conserving
  supply through the treasury was the simplest rule consistent with "the
  Government treasury is the sole source of new Aeros outside issuance."
- **Updates & notifications**: Government publishes announcements
  (visible to everyone); the system also generates per-user notifications
  for payments received, issuance votes requested/executed, etc.
- **Audit log**: every administrative and system action (account creation,
  status changes, balance adjustments, tax changes, issuance lifecycle,
  code generation/revocation, Government initialization) is recorded with
  actor, target, and metadata — visible read-only in the Government panel.

## Security decisions

- **Stateless JWT sessions** (`jose`, HS256), not database-backed sessions.
  Simpler to run on Vercel's serverless model (no session store to
  provision), and sufficient for a small closed-group app. Cookies are
  `httpOnly`, `secure`, `sameSite=lax`.
- **Separate session scopes for User and Government**: different cookie
  names (`aeros_session` / `aeros_gov_session`) and independent session
  logic, so a compromised user session can never be replayed against the
  Government panel or vice versa. Government sessions also expire sooner
  (8 hours vs. 7 days for users), reflecting the higher privilege level.
- **`proxy.ts` is a fast pre-check, not the security boundary.** It only
  checks cookie *presence* to redirect obviously-unauthenticated requests
  early. The actual enforcement — verifying the JWT signature, loading the
  current user/Government row, checking status — happens in
  `requireUser()` / `requireGovernment()` (`src/lib/auth.ts`), called at
  the top of every protected layout and every Server Action that mutates
  state. This matters because Next.js Server Actions are directly callable
  HTTP endpoints; route-level middleware alone would not protect them.
- **Passwords and the Government security code are bcrypt-hashed** (12
  rounds), never stored or logged in plaintext, and never included in any
  query result returned to the client.
- **Double-spend protection** is enforced at the database level (row locks
  + conditional atomic updates), not just checked in application code
  before a write — so it holds even under concurrent requests, not only
  under the assumption of single-threaded execution. See the concurrency
  test in the next section.
- **Unique-constraint races** (e.g. two people racing to register the same
  chosen username at the same instant) are handled with a pre-check for a
  fast, friendly error in the common case, and a database unique-constraint
  catch as the actual source of truth — so correctness never depends on
  the pre-check winning the race.
- **No user enumeration**: login failures (wrong username vs. wrong
  password) and Government login failures (wrong username, password, or
  security code) all return the same generic error message.
- **Banned/suspended users**: a suspended user is blocked from *sending*
  but can still receive (so a paused account doesn't strand funds owed to
  it); a banned user is blocked from both sending and receiving. This
  interpretation wasn't pinned down explicitly in the spec's rule list —
  it's what "suspend vs. ban" most naturally means and what the tests
  below verify.

## Testing summary

This section is a factual account of what was tested and how — not a claim
that the application is bug-free. Two independent testing approaches were
used, both against a real local Postgres database and a real `next dev`
server (Turbopack), because that's the only way to exercise Server Actions,
database transactions, and route protection as they actually behave in
production, rather than mocking them.

**1. Business-logic layer** (`scripts/test/test_payments.ts`,
`test_issuance.ts`, `test_codes.ts`, `test_fund.ts`) — direct-import Node
scripts calling the same library functions (`sendAeros`, `executeIssuance`,
etc.) the Server Actions call, run with real assertions and PASS/FAIL
output. Covered, all passing:
- Valid payment with correct tax math; a payment of exactly 1 Aeros is
  tax-free; insufficient balance rejected; nonexistent recipient rejected;
  self-payment rejected; zero/negative amount rejected; suspended sender
  rejected; banned sender/receiver rejected.
- **Concurrent double-spend attempt**: two simultaneous transfers issued
  against a sender with only enough balance for one, via `Promise.allSettled`
  — exactly one succeeds, balance integrity holds afterward.
- Issuance: 5,000 cap enforced; request creation and voter snapshot; first
  vote recorded; duplicate vote rejected; execution before 100% approval
  rejected; 100% approval correctly detected; successful execution
  increases treasury and total supply by exactly the requested amount;
  double-execution rejected; 7-day cooldown enforced; a single reject vote
  permanently blocks 100% approval.
- Registration code generation, uniqueness, and retry-on-collision.

**2. HTTP / Server Action layer** — a Python harness
(`scripts/test/submit.py`) that replicates exactly what a browser does
when submitting a `<form action={serverAction}>` with JavaScript disabled
(the progressive-enhancement wire protocol: hidden `$ACTION_*` fields,
multipart POST, cookie-based sessions, following the 303 redirect
manually to inspect `Set-Cookie`), plus real browser automation
(Playwright + Chromium) for flows that require client-side state. Verified
end-to-end against the running app, all passing:
- Registration: invalid/nonexistent/already-used/revoked codes rejected;
  duplicate username rejected; username lowercase-normalization confirmed.
- Login: wrong password and nonexistent username both return the same
  generic error; correct login succeeds.
- Government login: wrong credentials (any field) return the same generic
  error; correct login succeeds; session cookie confirmed `httpOnly`,
  `secure`, `sameSite=lax`, 8-hour expiry.
- Route protection: every protected page in both the user area
  (`/dashboard`, `/send`, `/transactions`, `/profile`) and the Government
  panel (`/gov/*`) redirects an unauthenticated request to the correct
  login page.
- Logout (both user and Government): session cookie cleared, subsequent
  requests to protected pages redirect to login again.
- Government funding a new user from the treasury: treasury debited,
  user credited, `GOVERNMENT_FUNDING` transaction recorded.
- Suspend → account blocked from sending; Unsuspend restores to `ACTIVE`;
  Ban → blocks send + receive, UI correctly collapses to a single
  "Restore to Active" action; Restore from banned → back to `ACTIVE`.
- Balance adjustments: credit and debit both move Aeros to/from the
  Government treasury correctly; oversized debit rejected
  ("insufficient Aeros"); oversized credit rejected when it would exceed
  the treasury.
- Tax rate change: takes effect on the *next* transaction; a transaction
  made before the change permanently retains the tax rate that was active
  when it happened (confirmed by inspecting stored `tax_rate_bp_applied`
  on old vs. new transactions).
- Full issuance lifecycle through the actual Government-panel/Server
  Action layer (not just the library): create request → two eligible
  users vote APPROVE via their own sessions → Government executes →
  treasury and total supply both increase by exactly the requested amount
  → the Execute action correctly disappears from the UI afterward
  (defense-in-depth on top of the already-tested server-side "already
  executed" rejection) → re-attempting execution changes nothing.
- Publishing an update: appears in the Government panel and on every
  user's Updates feed.
- **Full "Send Aeros" flow via real browser automation** (Playwright):
  fill recipient/amount → confirm screen shows correct tax breakdown →
  submit → success screen with correct amounts and transaction reference.
  This flow's confirm step only renders after client-side state changes,
  so it cannot be reached by a no-JS HTTP POST — real browser automation
  was used specifically to close that gap.
- Visual/layout spot-check via Playwright screenshots at both desktop
  (1280px) and mobile (390px) viewports: top navbar (desktop) and bottom
  tab bar (mobile) render correctly, logo and favicon load, mobile content
  correctly clears the fixed bottom nav (verified by scrolling to the true
  bottom of a real viewport, not just a full-page screenshot, which
  renders fixed-position elements misleadingly), notifications/updates
  feed, and the Government dashboard/users/audit-log views.

**Not covered**: automated/CI test suite (all testing above was manual,
run once against a live dev server, not wired into a repeatable test
command); load/performance testing; cross-browser testing (Chromium only);
accessibility audit beyond basic semantic HTML.

## Known limitations

- **No literal `favicon.ico`.** Next.js's file-based metadata convention is
  used instead: `src/app/icon.svg` (vector favicon) and
  `src/app/apple-icon.tsx` (a 180×180 PNG generated at build time via
  `next/og`). Verified served correctly with correct content types; this
  is the modern Next.js equivalent, but callers out there expecting a
  literal `/favicon.ico` file won't find a hand-authored one.
- **No automated/CI test suite ships with the app.** The scripts under
  `scripts/test/` are real, assertion-based tests that were run manually
  against a live database and dev server during development (see Testing
  summary) — they are not wired into `npm test` or CI, and a couple of
  them (`test_issuance.ts`, the concurrent-payment test) mutate real rows,
  so they're development tooling, not a regression suite. They're
  reasonable to delete, or to adapt into a real CI-friendly suite, later.
- **No literal rate-limiting/anti-bruteforce throttling** on login or
  Government login beyond bcrypt's inherent hashing cost. Acceptable for a
  small closed group behind a private Vercel URL, but worth adding
  (e.g. an IP/username attempt counter) before wider use.
- **System font stack, not a custom webfont.** `next/font/google` was
  dropped because the build environment used during development couldn't
  reach `fonts.googleapis.com`; the app uses the OS's default UI font
  stack instead, which also keeps things lighter, in the spirit of the
  "no unnecessary complexity" instruction.
- **Single Government account (singleton row).** The schema doesn't
  prevent multiple Government rows at the type level, but every code path
  assumes and queries for exactly one. Fine for the specified use case (one
  Government), but not a multi-admin system.
- **Registration codes are 4 digits (10,000 possible values), by spec.**
  For a small private group this is a non-issue (codes are single-use and
  Government-distributed out of band), but it's worth naming explicitly:
  this is not a high-entropy secret and shouldn't be treated as one at a
  larger scale.
- **No email/phone recovery flow.** There is no "forgot password" — losing
  a password means asking Government for help (which, per spec, has no
  built-in mechanism beyond direct database access). This matches the
  spec's minimal-scope instructions but is worth knowing going in.

---

Built end-to-end per the original specification; where a genuine
implementation decision wasn't pinned down explicitly (administrative
adjustments and the treasury, suspended-vs-banned receive behavior), the
choice made and its reasoning are called out above rather than applied
silently.
