import Link from "next/link";
import { adminSearch, getEconomicOverview } from "@/lib/queries";
import { CURRENCY_NAME } from "@/lib/constants";

/**
 * Control Room — the deepest administrative view (spec §10, §11).
 *
 * Its separation from the rest of the panel is organisational only. Access is
 * enforced by the same server-side Government check as every other /gov page
 * (see src/app/gov/layout.tsx); being harder to find is never treated as a
 * security measure.
 */
export default async function ControlRoomPage({ searchParams }: PageProps<"/gov/control-room">) {
  const params = await searchParams;
  const q = typeof params.q === "string" ? params.q : "";

  const [results, overview] = await Promise.all([
    q ? adminSearch(q) : null,
    getEconomicOverview(),
  ]);

  const totalHits = results
    ? results.users.length +
      results.companies.length +
      results.transactions.length +
      results.invoices.length +
      results.loans.length +
      results.complaints.length
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Control Room</h1>
        <p className="mt-1 text-sm text-muted">
          Search every record in the system by username, name, transaction reference, invoice,
          loan or complaint number.
        </p>
      </div>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          className="input"
          placeholder="@username, TX-…, INV-…, LN-…, IP-…"
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {results && (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {totalHits} result{totalHits === 1 ? "" : "s"} for &ldquo;{q}&rdquo;
          </p>

          <ResultGroup title="Users" empty={results.users.length === 0}>
            {results.users.map((u) => (
              <Link
                key={u.id}
                href={`/gov/users/${u.id}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <div>
                  <p className="font-medium">{u.displayName}</p>
                  <p className="text-xs text-muted">@{u.username}</p>
                </div>
                <span className="text-xs text-muted">{u.status}</span>
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup title="Companies" empty={results.companies.length === 0}>
            {results.companies.map((c) => (
              <Link
                key={c.id}
                href={`/gov/companies/${c.id}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted">@{c.username}</p>
                </div>
                <span className="text-xs text-muted">{c.status}</span>
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup title="Transactions" empty={results.transactions.length === 0}>
            {results.transactions.map((t) => (
              <Link
                key={t.id}
                href={`/gov/transactions?txRef=${t.txRef}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <p className="font-mono">{t.txRef}</p>
                <span className="text-xs text-muted">
                  {t.grossAmount.toLocaleString()} {CURRENCY_NAME}
                </span>
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup title="Invoices" empty={results.invoices.length === 0}>
            {results.invoices.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <p className="font-mono">{i.invoiceNumber}</p>
                <span className="text-xs text-muted">
                  {i.total.toLocaleString()} {CURRENCY_NAME} · {i.status}
                </span>
              </div>
            ))}
          </ResultGroup>

          <ResultGroup title="Loans" empty={results.loans.length === 0}>
            {results.loans.map((l) => (
              <Link
                key={l.id}
                href={`/gov/loans/${l.id}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <p className="font-mono">{l.loanNumber}</p>
                <span className="text-xs text-muted">{l.status}</span>
              </Link>
            ))}
          </ResultGroup>

          <ResultGroup title="IP complaints" empty={results.complaints.length === 0}>
            {results.complaints.map((c) => (
              <Link
                key={c.id}
                href={`/gov/ip/${c.id}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <p className="font-mono">{c.complaintNumber}</p>
                <span className="text-xs text-muted">{c.status}</span>
              </Link>
            ))}
          </ResultGroup>
        </div>
      )}

      {overview && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Economic reconciliation</h2>
          <dl className="space-y-1 text-sm">
            <Row label="Treasury" value={overview.treasury} />
            <Row label="User-held" value={overview.userHeld} />
            <Row label="Company-held" value={overview.companyHeld} />
            <div className="flex justify-between border-t border-border pt-1 font-medium">
              <dt>Accounted for</dt>
              <dd>
                {overview.accounted.toLocaleString()} {CURRENCY_NAME}
              </dd>
            </div>
            <div className="flex justify-between font-medium">
              <dt>Total supply</dt>
              <dd>
                {overview.totalSupply.toLocaleString()} {CURRENCY_NAME}
              </dd>
            </div>
          </dl>
          <p className={`mt-3 text-sm ${overview.balanced ? "text-success" : "text-danger"}`}>
            {overview.balanced
              ? "Balanced — every Aeros in existence is accounted for."
              : "MISMATCH — investigate immediately."}
          </p>
        </section>
      )}

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Administrative areas</h2>
        <div className="flex flex-wrap gap-2">
          <Link href="/gov/users" className="btn btn-secondary text-sm">
            Users
          </Link>
          <Link href="/gov/companies" className="btn btn-secondary text-sm">
            Companies
          </Link>
          <Link href="/gov/loans" className="btn btn-secondary text-sm">
            Loans
          </Link>
          <Link href="/gov/ip" className="btn btn-secondary text-sm">
            IP complaints
          </Link>
          <Link href="/gov/audit" className="btn btn-secondary text-sm">
            Audit log
          </Link>
          <Link href="/gov/retention" className="btn btn-secondary text-sm">
            Data retention
          </Link>
        </div>
      </section>
    </div>
  );
}

function ResultGroup({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  if (empty) return null;
  return (
    <section className="card p-5">
      <h2 className="mb-2 font-medium">{title}</h2>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd>
        {value.toLocaleString()} {CURRENCY_NAME}
      </dd>
    </div>
  );
}
