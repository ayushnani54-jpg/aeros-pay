# Aeros Pay — V2 → V3 upgrade

Same deal as always: your live site keeps running, nothing is deleted, no
database is reset. This is the big one — a full marketplace, universal
invoices, exports, and automatic cleanup — but it goes in the same three
steps as every upgrade before it.

---

## Step 1 — Run the database upgrade in Neon

Go to **neon.com → your project → SQL Editor**.

Paste **one more block** after the five you already ran for V2/V2.1 — split
into two parts because of a Postgres rule (a brand-new data type can't be used
in the same run that creates it):

| Order | File | What it does |
|-------|------|--------------|
| 6 | `6_migration_0005_PART1.sql` | Adds new data types for the marketplace |
| 7 | `6_migration_0005_PART2.sql` | Adds the marketplace, invoices upgrade, exports and cleanup tables |

Run PART 1, wait for it to finish, then run PART 2. If you're not sure
whether you already ran blocks 1–5 (the V2/V2.1 ones), it's completely safe
to paste them again first — every block just says "already exists, skipping"
for anything already done.

## Step 2 — Push the new code

Same as always:
1. Replace the contents of your `aeros-pay` folder with the new files (keep
   your own `.env` — it's not in the zip).
2. Open **GitHub Desktop** → it shows the changed files → type a summary like
   `V3 upgrade` → **Commit to main** → **Push origin**.

Vercel redeploys automatically.

## Step 3 — One new setting in Vercel (for automatic cleanup)

V3 adds a daily automatic cleanup job (old notifications, expired listings,
that kind of thing — never your money, never the ledger). For it to run, add
one environment variable:

1. Go to **vercel.com → your project → Settings → Environment Variables**.
2. Add a new one: Name = `CRON_SECRET`, Value = any long random text (mash
   your keyboard for 20+ characters, or use a password generator).
3. Save, then redeploy (Vercel usually prompts you to).

If you skip this step, nothing breaks — the site still cleans itself up
automatically whenever a Government page is opened, just not on the silent
daily schedule.

## Step 4 — Check it worked

1. Log in as Government.
2. You should see new panels: **Market, Contracts, Promotions, Health,
   Exports**, alongside everything from before.
3. Go to **Health** (in the Government nav) → **Run health check**. It
   should report every check passing. If anything fails, stop and send me
   the exact wording before doing anything else.
4. Go to **Treasury** → should still say **Balanced**.

---

## What's new in V3

### For your members
- **Market** — a real goods/services marketplace, separate from the existing
  "companies for sale" page (that one's still there, just renamed slightly
  and linked from the new one so nobody confuses the two). Companies list
  items, people browse/search and order, pay by invoice.
- **Wanted** — post "I need X, budget Y" requests; others respond.
- **Contracts** — Government or companies post work, others apply, it ends
  in an invoice and payment like everything else.
- **Ratings** — only the actual buyer of a completed order can rate it, once.
  Star stays forever; any comment clears itself after 30 days.
- **Leaderboard** — last 30 days of activity only, nothing stored specially
  for it.
- **Company QR codes** — every approved company gets one automatically,
  pointing at its public page. Stops working if the company is revoked.
- **Universal invoices** — a company can now invoice a person, another
  company, or the Government, not just people.
- **Voice input** — a dictation button on longer text fields (support
  requests, Wanted descriptions, etc.), using the browser's own speech
  recognition. Nothing is ever recorded or stored — it's typed text or
  nothing.
- **Payment sound** — a short confirmation chime after a payment actually
  succeeds (never before, never on failure). Can be turned off per-device.
- Closing the browser still logs you out (from V2.1) — that's unchanged.

### For you (Government)
- **Market / Contracts / Promotions panels** — approve, configure, monitor.
- **Promotions** — one company ad slot at a time, Government sets the daily
  price, charged automatically from the company's wallet. If they can't
  afford it, the ad pauses itself — never a negative balance.
- **Health** — one button that checks the whole economy end to end: supply
  math, no negative balances, no orphaned records, no double payments, no
  impossible states. Green means everything reconciles.
- **Exports** — download transactions, invoices, loans, companies, users
  and more as CSV or JSON, with date/type/amount filters. Works for huge
  datasets without timing out.
- **Retention (extended)** — old notifications, expired listings, old
  support tickets and rating comments now clear themselves automatically
  every day (once you've set `CRON_SECRET` in Step 3) as well as whenever
  you open a Government page. Your ledger, balances, passwords and
  ownership records can never be touched by this — there's no code path
  that can reach them.
- Everything from V2/V2.1 (companies, loans, sales, suspension/ban, tax
  configuration, control room) works exactly as before.

### The rule that mattered most
A company's income can never be quietly redirected to its owner's personal
wallet to dodge company tax. This isn't just a check somewhere — no invoice,
order or contract payment in the whole system can even *name* a different
destination; the money's destination is worked out from the company record
itself, at the last possible moment, by the one piece of code that's allowed
to do it. I tried to break this several different ways while testing and
couldn't.

### Testing
Before sending this to you: 988 automated checks (money math, tax, security,
retention, exports, edge cases) plus 152 real-browser checks driving actual
signups, purchases, payments and Government actions — all passing. The
database migration was rehearsed on a copy of your data shape first; nothing
existing changed, and running it twice is harmless.

That said — "988 tests passed" is not the same as "impossible to ever find a
bug." If something looks wrong after you upgrade, tell me exactly what you
see and I'll fix it.

### One thing to know about your Neon storage
I can't see your actual live database from here (no access to it). I've
included `scripts/db-size-check.sql` in the project — paste it into Neon's
SQL Editor any time and it'll show you exactly what's using space: total
size, biggest tables, biggest indexes, row counts. Nothing in V3 stores
anything unnecessary (no click tracking, no view counts, no search history),
and the new automatic cleanup keeps the temporary stuff from piling up.
