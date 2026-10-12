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
| 5 | `0004_configurable_policy.sql` (whole file) | Adds the editable policy settings + clearing settings |

Block 5 is one single file — no PART split, paste the whole thing at once.

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

### Settings you can now change yourself (Government → Tax & Economy)
- **Company approval funding** — how many Aeros a company gets when you approve
  it. Now **3,000** by default, and you can still type a different one-off
  amount on any single approval.
- **Maximum issuance amount** — now **10,000** Aeros per issuance request
  (was a fixed 5,000 you could not change).
- **Issuance frequency** — now **once per calendar day, India time** (was once
  per 7 days). Set it to 0 to remove the daily limit, or higher to space
  issuances further apart.

These three are enforced on the server, inside the same locked transaction that
moves the money, so nothing typed into a browser can get around them.

### Everything now shows India time
Every timestamp in the app — transactions, receipts, audit logs,
notifications, invoices, loan instalments, sale records, issuance — is
displayed in **IST (Asia/Kolkata)** for everyone, wherever they are. The
day-based rules use IST day boundaries too: the daily issuance limit, the
7-day company-sale eligibility window and loan due dates/reminders.

### Closing the browser now logs you out
The login cookie is no longer a permanent one. Close the browser and reopen
the site and you get the **login page**, not the old dashboard. Moving between
pages during a session works exactly as before, and closing a single tab while
the browser stays open does not sign you out.

### Clearing old data (Government → Retention)
Neon's free plan has a storage limit, so you can now shrink the heavy parts
without losing anything that matters:

- **Transaction notes** can be cleared after an age you set. The transaction
  itself — amount, tax, sender, receiver, TX number, date — stays **forever**.
  Only the free-text reason is replaced with `[cleared]`.
- **Invoice descriptions/notes**, **loan purpose and decision notes**, and
  **issuance notes** work the same way: the text goes, the numbers and dates
  stay.
- **Updates, announcements and notifications** can be deleted outright after
  an age you set — these are the disposable ones.
- **Never touched by any of this:** passwords, usernames, user and company
  balances, the treasury, total supply, transaction amounts/IDs/dates,
  ownership and sale records, loan principal and schedules. The ledger cannot
  be cleared — by design, there is no code path that can do it.

Every clearing run is written to the audit log first, and running it twice is
harmless.

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
- **Invoice tax comes out of the company's proceeds.** An 800-Aeros invoice at
  5% means the buyer pays 800, the tax is 40 and the company receives 760.
  (Earlier versions added the tax on top - buyer paid 840 - and invoices
  issued back then are still payable exactly as quoted.) Direct payments work
  the same way: tax comes out of the amount sent.
- **A loan never creates Aeros.** The principal comes out of the treasury and
  repayments go back into it, so total supply is untouched by the entire loan
  lifecycle. Only an approved issuance ever increases supply.
- **A Government acquisition doesn't delete the old owner.** The company is
  marked as Government-held; the previous owner's record stays for history.
- **Reminders are generated when pages load**, not by a background scheduler —
  there is no cron on this hosting. Opening the loans page or the Government
  dashboard brings overdue flags and reminders up to date.
