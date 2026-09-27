import Link from "next/link";
import { notFound } from "next/navigation";
import { getUserAdminProfile } from "@/lib/queries";
import { UserStatusActions } from "@/components/forms/user-status-actions";
import { FundUserForm } from "@/components/forms/fund-user-form";
import { AdjustBalanceForm } from "@/components/forms/adjust-balance-form";
import {
  BanUserForm,
  ResetPasswordForm,
  TimedSuspendForm,
} from "@/components/forms/gov-forms";
import { CompanyStatusBadge, StatusBadge } from "@/components/status-badge";
import { TransactionRow } from "@/components/transaction-row";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatSuspensionRemaining } from "@/lib/status";
import { formatDateTime } from "@/lib/datetime";

export default async function GovUserDetail({ params }: PageProps<"/gov/users/[id]">) {
  const { id } = await params;
  const profile = await getUserAdminProfile(id);
  if (!profile) notFound();

  const { user } = profile;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/gov/users" className="text-sm text-muted hover:text-foreground">
          ← Users
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{user.displayName}</h1>
            <p className="mt-1 font-mono text-sm text-muted">@{user.username}</p>
          </div>
          <StatusBadge status={user.effectiveStatus} />
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Balance" value={user.balance} />
        <Stat label="Received from Government" value={profile.totalReceivedFromGovernment} />
        <Stat label="Companies" value={profile.companies.length} plain />
        <Stat label="Transactions" value={profile.transactions.length} plain />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Account</h2>
        <dl className="space-y-1 text-sm">
          <Row label="Registered" value={formatDateTime(user.createdAt)} />
          <Row label="Stored status" value={user.status} />
          <Row label="Effective status" value={user.effectiveStatus} />
          {user.suspendedUntil && (
            <Row
              label="Suspended until"
              value={`${formatDateTime(user.suspendedUntil)} (${formatSuspensionRemaining(user.suspendedUntil)} left)`}
            />
          )}
          {user.suspensionReason && <Row label="Suspension reason" value={user.suspensionReason} />}
          {user.bannedAt && (
            <Row
              label="Banned"
              value={`${formatDateTime(user.bannedAt)} by ${user.bannedBy ?? "—"}`}
            />
          )}
          {user.banReason && <Row label="Ban reason" value={user.banReason} />}
          <Row
            label="Password last changed"
            value={
              user.passwordUpdatedAt
                ? formatDateTime(user.passwordUpdatedAt)
                : "never"
            }
          />
          <Row
            label="Using temporary password"
            value={user.mustChangePassword ? "yes" : "no"}
          />
        </dl>
        <p className="mt-3 text-xs text-muted">
          Passwords are stored only as irreversible hashes and can never be viewed — only reset.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Status</h2>
        <UserStatusActions userId={user.id} status={user.status} />
        <div className="mt-5 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-medium">Suspend until a set time</h3>
          <TimedSuspendForm userId={user.id} />
        </div>
        <div className="mt-5 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-medium">Permanent ban</h3>
          <BanUserForm userId={user.id} username={user.username} />
        </div>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Password</h2>
        <ResetPasswordForm userId={user.id} />
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="card p-5">
          <h2 className="mb-3 font-medium">Fund from treasury</h2>
          <FundUserForm userId={user.id} />
        </div>
        <div className="card p-5">
          <h2 className="mb-3 font-medium">Balance adjustment</h2>
          <AdjustBalanceForm userId={user.id} />
        </div>
      </section>

      {profile.companies.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-medium">Companies</h2>
          <div className="divide-y divide-border">
            {profile.companies.map((company) => (
              <Link
                key={company.id}
                href={`/gov/companies/${company.id}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:underline"
              >
                <div>
                  <p className="font-medium">{company.name}</p>
                  <p className="text-xs text-muted">
                    @{company.username} · {company.balance.toLocaleString()} {CURRENCY_NAME}
                  </p>
                </div>
                <CompanyStatusBadge status={company.status} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {profile.supportThread && (
        <section className="card p-5">
          <h2 className="mb-2 font-medium">Support</h2>
          <Link
            href={`/gov/support/${profile.supportThread.id}`}
            className="text-sm underline"
          >
            Open conversation
          </Link>
          {profile.supportThread.unreadForGovernment > 0 && (
            <span className="badge badge-suspended ml-2">
              {profile.supportThread.unreadForGovernment} unread
            </span>
          )}
        </section>
      )}

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Transactions</h2>
        {profile.transactions.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet.</p>
        ) : (
          <div className="divide-y divide-border">
            {profile.transactions.map((tx) => (
              <TransactionRow
                key={tx.id}
                tx={tx}
                viewerId={user.id}
                viewerUsername={user.username}
              />
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Government actions on this account</h2>
        {profile.governmentActions.length === 0 ? (
          <p className="text-sm text-muted">None recorded.</p>
        ) : (
          <div className="divide-y divide-border">
            {profile.governmentActions.map((log) => (
              <div key={log.id} className="py-3 text-sm">
                <p className="font-medium">{log.action.replace(/_/g, " ")}</p>
                <p className="text-xs text-muted">
                  {log.actorLabel} · {formatDateTime(log.createdAt)}
                  {log.previousValue || log.newValue
                    ? ` · ${log.previousValue ?? "—"} → ${log.newValue ?? "—"}`
                    : ""}
                </p>
                {log.reason && <p className="mt-1 text-xs text-muted">{log.reason}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Recent notifications</h2>
        {profile.notifications.length === 0 ? (
          <p className="text-sm text-muted">None.</p>
        ) : (
          <div className="divide-y divide-border">
            {profile.notifications.map((n) => (
              <div key={n.id} className="py-2 text-sm">
                <p>{n.message}</p>
                <p className="text-xs text-muted">
                  {formatDateTime(n.createdAt)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function Stat({ label, value, plain = false }: { label: string; value: number; plain?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold">
        {value.toLocaleString()}
        {!plain && <span className="ml-1 text-xs font-medium text-muted">{CURRENCY_NAME}</span>}
      </p>
    </div>
  );
}
