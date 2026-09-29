import Link from "next/link";
import { getAllUsers } from "@/lib/queries";
import { StatusBadge, UserBadges } from "@/components/status-badge";
import { badgesOf } from "@/lib/badges";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

export default async function GovUsersPage() {
  const allUsers = await getAllUsers();

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Users</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Display name</th>
              <th className="px-4 py-3">Balance</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Labels</th>
              <th className="px-4 py-3">Registered</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {allUsers.map((u) => (
              <tr key={u.id} className="hover:bg-surface">
                <td className="px-4 py-3">
                  <Link href={`/gov/users/${u.id}`} className="font-mono font-medium underline">
                    @{u.username}
                  </Link>
                </td>
                <td className="px-4 py-3">{u.displayName}</td>
                <td className="px-4 py-3">
                  {u.balance.toLocaleString()} {CURRENCY_NAME}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={u.effectiveStatus} />
                </td>
                <td className="px-4 py-3">
                  <UserBadges {...badgesOf(u)} />
                </td>
                <td className="px-4 py-3 text-muted">
                  {formatDate(u.createdAt)}
                </td>
              </tr>
            ))}
            {allUsers.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted">
                  No users registered yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
