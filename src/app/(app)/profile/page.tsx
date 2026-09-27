import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { ProfileForm } from "@/components/forms/profile-form";
import { ChangePasswordForm } from "@/components/forms/change-password-form";
import { StatusBadge } from "@/components/status-badge";
import { CompanyStatusBadge } from "@/components/status-badge";
import { getOwnedCompanies } from "@/lib/auth";
import { effectiveUserStatus, formatSuspensionRemaining } from "@/lib/status";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/datetime";

export default async function ProfilePage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user } = ctx;
  const companies = await getOwnedCompanies(user.id);
  const status = effectiveUserStatus(user);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>

      <section className="card p-5">
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Username</dt>
          <dd className="font-mono">@{user.username}</dd>
          <dt className="text-muted">Personal balance</dt>
          <dd>
            {user.balance.toLocaleString()} {CURRENCY_NAME}
          </dd>
          <dt className="text-muted">Status</dt>
          <dd>
            <StatusBadge status={status} />
          </dd>
          <dt className="text-muted">Registered</dt>
          <dd>{formatDate(user.createdAt)}</dd>
        </dl>
        {status === "SUSPENDED" && user.suspendedUntil && (
          <p className="mt-3 text-sm text-muted">
            Suspension ends in {formatSuspensionRemaining(user.suspendedUntil)} (
            {formatDateTime(user.suspendedUntil)}).
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          Your username is permanent and cannot be changed.
        </p>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Display name</h2>
        <ProfileForm currentDisplayName={user.displayName} />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Password</h2>
        <ChangePasswordForm mustChange={user.mustChangePassword} />
      </section>

      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Companies</h2>
          <Link href="/my-company" className="text-sm font-medium text-muted hover:text-foreground">
            Manage
          </Link>
        </div>
        {companies.length === 0 ? (
          <p className="text-sm text-muted">
            You do not own a company yet.{" "}
            <Link href="/my-company" className="underline">
              Apply for one
            </Link>
            .
          </p>
        ) : (
          <div className="divide-y divide-border">
            {companies.map((company) => (
              <div key={company.id} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="font-medium">{company.name}</p>
                  <p className="text-xs text-muted">@{company.username}</p>
                </div>
                <CompanyStatusBadge status={company.status} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
