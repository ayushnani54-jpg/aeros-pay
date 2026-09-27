# Aeros Pay — V1 → V2 upgrade

Your live site keeps running the whole time. Nothing is deleted, no database
is reset, and every existing user, balance and transaction stays exactly as it
is.

There are **two things to do**: run some SQL in Neon, then push the new code.

---

## Step 1 — Run the database upgrade in Neon

Go to **neon.com → your project → SQL Editor**.

You will paste **four blocks, one at a time**, waiting for each to finish
before starting the next. They are in the `drizzle/` folder of the project:

| Order | File | What it does |
|-------|------|--------------|
| 1 | `0002_v2_upgrade.sql` → **PART 1** | Adds new data types |
| 2 | `0002_v2_upgrade.sql` → **PART 2** | Adds companies, invoices, support, IP tables |
| 3 | `0003_v2_sales_loans.sql` → **PART 1** | Adds sale/loan data types |
| 4 | `0003_v2_sales_loans.sql` → **PART 2** | Adds company-sale and loan tables |

Each file is clearly split with a big comment line saying `PART 1` and
`PART 2`. Copy everything from one PART marker to the next.

**Why split?** PostgreSQL will not let a brand-new data type be *used* in the
same run that creates it. Running the parts separately avoids that entirely.

### If something goes wrong
Every statement is guarded, so **running a block twice is completely safe** —
it just prints "already exists, skipping" notices. If a block half-fails, fix
the problem and run the same block again from the top.

### What this SQL does and does not do
- **Does:** create new tables, add new columns, add new indexes.
- **Does NOT:** drop anything, empty anything, or change a single existing row.

This was rehearsed on a copy of a V1-shaped database: every user, balance,
transaction, code, issuance record, audit entry and update came out
byte-identical afterwards.

---

## Step 2 — Push the new code

1. Replace the contents of your `aeros-pay` folder with the new files
   (keep your own `.env` if you have one locally — it is not in the zip).
2. Open **GitHub Desktop**. It will show the changed files.
3. Type a summary like `V2 upgrade` and click **Commit to main**.
4. Click **Push origin**.

Vercel redeploys automatically. Nothing to configure — the environment
variables you already set (`DATABASE_URL`, `AUTH_SECRET`) are all V2 needs.

---

## Step 3 — Check it worked

1. Open your site and log in to `/government/login` as usual.
2. The dashboard should show new panels: **Companies, Loans, Sales, Support,
   IP, Control Room, Retention**.
3. Go to **Treasury**. At the bottom it should say:
   > **Balanced — the ledger reconciles exactly.**

That line is the important one. It means every Aeros in existence is
accounted for: treasury + all user balances + all company balances = total
supply. If it ever says MISMATCH, stop and investigate before doing anything
else.

---

## What's new in V2

### For your members
- **Pay** replaces Send, and can now pay a person, a company, or the Government.
- **People** and **Companies** directories to find who to pay.
- **Companies** — apply for one, get approved and funded by the Government,
  and run it from a separate wallet using the same login.
- **Invoices** — companies bill people, who pay with one click.
- **Marketplace** — companies for sale. "Not interested" hides a listing for
  **you only**; it stays live for everyone else.
- **Notifications** separated from **Updates**.
- **Contact Government** — a private conversation with you.
- Timed suspensions now lift themselves automatically.

### For you (Government)
- **Companies** — review applications, approve (auto-funds 5,000 Aeros),
  reject, edit, suspend, revoke, set per-company tax, adjust balances, and
  offer to buy a company.
- **Loans** — a full lending system. Set the policy (rate, instalments,
  interval, limits, eligibility), review applications, approve, and watch
  repayments. Companies get escalating reminders and a payment notice per
  instalment. You can warn, restrict, demand, restructure or declare default —
  all audited, and none of them ever seize a wallet or take ownership.
- **Sales** — set the valuation multiplier and minimum age, see live listings
  and every completed sale.
- **Payments** — send Aeros from the treasury to anyone.
- **Support** — inbox of private conversations.
- **IP** — company copyright complaints, reviewed on evidence.
- **Control Room** — search everything by username, TX/invoice/loan/complaint
  number, plus a live reconciliation check.
- **Retention** — set how long updates, notifications and support messages are
  kept. Transactions and the ledger are deliberately **never** deletable.
- **Timed suspension** and **permanent ban** (ban needs you to type the
  username to confirm).
- **Password reset** — issues a one-time temporary password and signs the user
  out everywhere. You still cannot *see* anyone's password; they are stored as
  irreversible hashes.

### One rule that changed
Aeros issuance used to need **every** eligible user to approve. V2 uses a
**simple majority** (more than half). People who do not vote count as neither
approval nor rejection. This was an explicit V2 requirement, and it applies to
requests that are already open as well as new ones.

---

## Things worth knowing

- **Company sales are tax-free.** The listing advertises a price and the seller
  receives exactly that. Taxing it would have meant the seller quietly got less
  than the advertised figure.
- **Invoice tax is added on top.** An 800-Aeros invoice at 5% means the buyer
  pays 840 and the company receives the full 800. Direct payments still work
  the old way (tax comes out of the amount sent).
- **A loan never creates Aeros.** The principal comes out of the treasury and
  repayments go back into it, so total supply is untouched by the entire loan
  lifecycle. Only an approved issuance ever increases supply.
- **A Government acquisition doesn't delete the old owner.** The company is
  marked as Government-held; the previous owner's record stays for history.
- **Reminders are generated when pages load**, not by a background scheduler —
  there is no cron on this hosting. Opening the loans page or the Government
  dashboard brings overdue flags and reminders up to date.
