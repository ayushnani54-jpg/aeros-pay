import { redirect } from "next/navigation";
import { getActingContext } from "@/lib/auth";
import { UserBottomNav, UserNavbar } from "@/components/user-nav";
import { getUnreadNotificationCount } from "@/lib/queries";
import { effectiveUserStatus, formatSuspensionRemaining } from "@/lib/status";
import { formatDateTime } from "@/lib/datetime";
import { GlobalActionFeedbackProvider } from "@/components/v5/action-feedback";
import { getV5RepositoriesStorageStatus } from "@/lib/archive";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const ctx = await getActingContext();
  if (!ctx) redirect("/login");

  const { user } = ctx;
  const status = effectiveUserStatus(user);

  // A banned account keeps its data but cannot use the app at all (spec §9).
  if (status === "BANNED") redirect("/banned");

  const [unreadCount, storageStatus] = await Promise.all([
    getUnreadNotificationCount(user.id),
    getV5RepositoriesStorageStatus().catch(() => null),
  ]);
  const hasCompany = ctx.availableCompanies.length > 0;

  const storageAlertNotice =
    storageStatus && storageStatus.hasStorageAlerts
      ? `System Notice: ${storageStatus.criticalCount + storageStatus.warningCount} historical archive repository is approaching the 900 MB storage threshold and is rolling over to a continuation shard.`
      : null;

  return (
    <div className="flex min-h-screen flex-col">
      <UserNavbar hasCompany={hasCompany} unreadCount={unreadCount} />

      <GlobalActionFeedbackProvider storageAlertNotice={storageAlertNotice}>
        {status === "SUSPENDED" && (
          <div className="bg-[#fff6e0] px-4 py-2 text-center text-sm font-medium text-[#8a5a00]">
            Your account is suspended
            {user.suspendedUntil
              ? ` for another ${formatSuspensionRemaining(user.suspendedUntil)} (until ${formatDateTime(user.suspendedUntil)})`
              : ""}
            . You can still receive Aeros and view your account, but not send.
            {user.suspensionReason ? ` Reason: ${user.suspensionReason}` : ""}
          </div>
        )}

        {user.mustChangePassword && (
          <div className="bg-[#fff6e0] px-4 py-2 text-center text-sm font-medium text-[#8a5a00]">
            You are using a temporary password. Please set a new one from your profile.
          </div>
        )}

        {ctx.company && (
          <div className="border-b border-border bg-surface px-4 py-2 text-center text-sm">
            Acting as <span className="font-medium">{ctx.company.name}</span> (@
            {ctx.company.username}) — company wallet
          </div>
        )}

        <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-24 pt-5 sm:px-6 sm:pb-12">
          {children}
        </main>
      </GlobalActionFeedbackProvider>

      <UserBottomNav hasCompany={hasCompany} unreadCount={unreadCount} />
    </div>
  );
}

