import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getOpenIssuanceRequestsForUser, getRecentTransactionsForUser } from "@/lib/queries";
import { CURRENCY_NAME } from "@/lib/constants";
import { TransactionRow } from "@/components/transaction-row";
import { StatusBadge } from "@/components/status-badge";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const [recentTx, openIssuances] = await Promise.all([
    getRecentTransactionsForUser(user.id, 5),
    getOpenIssuanceRequestsForUser(user.id),
  ]);

  const pendingVotes = openIssuances.filter((row) => !row.myVote);

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <p className="text-sm text-muted">Your balance</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight">
          {user.balance.toLocaleString()} <span className="text-xl font-medium text-muted">{CURRENCY_NAME}</span>
        </p>
        <div className="mt-3">
          <StatusBadge status={user.status} />
        </div>
      </section>

      {pendingVotes.length > 0 && (
        <section className="card border-[#111111] p-5">
          <h2 className="font-medium">Aeros issuance vote requested</h2>
          <p className="mt-1 text-sm text-muted">
            The Government has proposed new Aeros issuance and needs your vote.
          </p>
          <Link href="/updates" className="mt-3 inline-block btn btn-primary text-sm">
            Review and vote
          </Link>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <QuickAction href="/send" label="Send Aeros" />
        <QuickAction href="/transactions" label="Transactions" />
        <QuickAction href="/profile" label="Profile" />
        <QuickAction href="/updates" label="Updates" />
      </section>

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Recent transactions</h2>
          <Link href="/transactions" className="text-sm font-medium text-muted hover:text-foreground">
            View all
          </Link>
        </div>
        {recentTx.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {recentTx.map((tx) => (
              <TransactionRow key={tx.id} tx={tx} viewerUsername={user.username} />
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="font-medium">Account</h2>
        <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Display name</dt>
          <dd>{user.displayName}</dd>
          <dt className="text-muted">Username</dt>
          <dd className="font-mono">@{user.username}</dd>
          <dt className="text-muted">Status</dt>
          <dd>
            <StatusBadge status={user.status} />
          </dd>
          <dt className="text-muted">Registered</dt>
          <dd>{new Date(user.createdAt).toLocaleDateString()}</dd>
        </dl>
      </section>
    </div>
  );
}

function QuickAction({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="card flex items-center justify-center p-4 text-center text-sm font-medium hover:bg-surface">
      {label}
    </Link>
  );
}
