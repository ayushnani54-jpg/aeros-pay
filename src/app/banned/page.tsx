import { getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { logoutAction } from "@/actions/auth";
import { AerosLogo } from "@/components/logo";
import { effectiveUserStatus } from "@/lib/status";

/**
 * Shown to a banned account.
 *
 * The account, its balance and its full history are all preserved — a ban
 * blocks participation, it never deletes anything (spec §9).
 */
export default async function BannedPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (effectiveUserStatus(user) !== "BANNED") redirect("/dashboard");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm text-center">
        <div className="mb-6 flex justify-center">
          <AerosLogo size={40} />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Account banned</h1>
        <p className="mt-3 text-sm text-muted">
          Your account has been permanently banned by the Government, so you cannot send or
          receive Aeros.
        </p>
        {user.banReason && (
          <p className="mt-3 rounded-md bg-surface p-3 text-sm">Reason: {user.banReason}</p>
        )}
        <p className="mt-4 text-xs text-muted">
          Your account and its full transaction history are preserved. If you believe this is a
          mistake, speak to the Government directly.
        </p>
        <form action={logoutAction} className="mt-6">
          <button type="submit" className="btn btn-secondary w-full">
            Log out
          </button>
        </form>
      </div>
    </div>
  );
}
