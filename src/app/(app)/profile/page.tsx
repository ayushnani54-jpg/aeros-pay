import Link from "next/link";
import { getActingContext, getOwnedCompanies } from "@/lib/auth";
import { ProfileForm } from "@/components/forms/profile-form";
import { ChangePasswordForm } from "@/components/forms/change-password-form";
import { StatusBadge, UserBadges, CompanyStatusBadge } from "@/components/status-badge";
import { badgesOf } from "@/lib/badges";
import { PaymentSoundToggle } from "@/components/payment-sound";
import { getMyCompanyAllowance } from "@/lib/companies";
import { getTransactionsForWallet } from "@/lib/queries";
import { getUserMarketPortfolio } from "@/lib/synthetic-market";
import { effectiveUserStatus, formatSuspensionRemaining } from "@/lib/status";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/datetime";

export default async function ProfilePage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { user } = ctx;
  const [companies, allowance, recentTx, marketPortfolio] = await Promise.all([
    getOwnedCompanies(user.id),
    getMyCompanyAllowance(user.id),
    getTransactionsForWallet(user.id, "USER", 50),
    getUserMarketPortfolio(user.id).catch(() => null),
  ]);

  const status = effectiveUserStatus(user);
  const badges = badgesOf(user);

  const liveTxVolume = recentTx.reduce((sum, tx) => sum + tx.grossAmount, 0);
  const totalHistoricalVolume =
    liveTxVolume + user.archivedCredits + user.archivedDebits;
  const activeCompaniesCount = companies.filter((c) => c.status === "APPROVED").length;
  const totalMarketTradedUnits =
    (marketPortfolio?.position.totalBoughtUnits ?? 0) +
    (marketPortfolio?.position.totalSoldUnits ?? 0) +
    (marketPortfolio?.position.totalShortedUnits ?? 0) +
    (marketPortfolio?.position.totalCoveredUnits ?? 0);

  // Verifiable activity milestones (derived strictly from real database records — zero arbitrary Aeros minting)
  const milestones = [
    {
      code: "CITIZEN_VERIFIED",
      title: "Registered Citizen",
      description: "Active personal wallet in the Aeros sovereign economy",
      unlocked: status === "ACTIVE",
    },
    {
      code: "FIRST_SETTLEMENT",
      title: "First Ledger Settlement",
      description: "Completed at least 1 immutable ledger transaction",
      unlocked: recentTx.length > 0 || user.archivedCredits + user.archivedDebits > 0,
    },
    {
      code: "ENTERPRISE_FOUNDER",
      title: "Enterprise Founder",
      description: "Registered and operated an approved company in Aeros Pay",
      unlocked: activeCompaniesCount > 0,
    },
    {
      code: "AMI_TRADER",
      title: "Synthetic Market Participant",
      description: "Executed long or collateralized short trades on the AMI index",
      unlocked: totalMarketTradedUnits > 0,
    },
    {
      code: "SHORT_STRATEGIST",
      title: "Collateralized Short Strategist",
      description: "Opened or covered a 100%-collateralized short position on AMI",
      unlocked: (marketPortfolio?.position.totalShortedUnits ?? 0) > 0,
    },
    {
      code: "HIGH_VOLUME_ACTOR",
      title: "10,000+ Aeros Economic Volume",
      description: "Processed over 10,000 Aeros in cumulative verified volume",
      unlocked: totalHistoricalVolume >= 10_000,
    },
  ];

  const unlockedCount = milestones.filter((m) => m.unlocked).length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Profile &amp; Economic Standing</h1>

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted">
              Aeros Pay Sovereign Citizen Passport
            </p>
            <h2 className="mt-0.5 text-xl font-semibold">{user.displayName}</h2>
            <p className="font-mono text-xs text-muted">@{user.username}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={status} />
            {(badges.official || badges.member) && (
              <UserBadges official={badges.official} member={badges.member} />
            )}
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 rounded-md bg-surface p-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Personal Balance</dt>
            <dd className="mt-0.5 font-mono font-semibold">
              {user.balance.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Cumulative Volume</dt>
            <dd className="mt-0.5 font-mono font-semibold">
              {totalHistoricalVolume.toLocaleString()} {CURRENCY_NAME}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Market Traded Units</dt>
            <dd className="mt-0.5 font-mono font-semibold">
              {totalMarketTradedUnits.toLocaleString()} AMI
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Registered Since</dt>
            <dd className="mt-0.5 font-medium">{formatDate(user.createdAt)}</dd>
          </div>
        </dl>

        {status === "SUSPENDED" && user.suspendedUntil && (
          <p className="mt-3 text-sm text-muted">
            Suspension ends in {formatSuspensionRemaining(user.suspendedUntil)} (
            {formatDateTime(user.suspendedUntil)}).
          </p>
        )}
        <p className="mt-3 text-xs text-muted">
          Your username is permanent and cannot be changed. Cumulative volume includes both live
          Neon transactions and preserved GitHub-archived checkpoints.
        </p>
      </section>

      {/* Verifiable Activity Milestones */}
      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-medium">
              Verifiable Activity Milestones ({unlockedCount}/{milestones.length})
            </h2>
            <p className="text-xs text-muted">
              Derived directly from your verified ledger, company, and market activity.
            </p>
          </div>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {milestones.map((m) => (
            <div
              key={m.code}
              className={`rounded-md border p-3 text-xs ${
                m.unlocked
                  ? "border-[#111111] bg-surface"
                  : "border-border opacity-60"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{m.title}</span>
                <span
                  className={`badge text-[10px] ${
                    m.unlocked ? "badge-active" : "badge-pending"
                  }`}
                >
                  {m.unlocked ? "VERIFIED" : "LOCKED"}
                </span>
              </div>
              <p className="mt-1 text-muted">{m.description}</p>
            </div>
          ))}
        </div>
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
        <h2 className="mb-3 font-medium">Sound</h2>
        <PaymentSoundToggle />
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
        {companies.length > 0 && allowance.canCreate && !companies.some((c) => c.status === "PENDING") && (
          <p className="mt-3 text-sm">
            <Link href="/my-company/new" className="underline">
              Create another company
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
