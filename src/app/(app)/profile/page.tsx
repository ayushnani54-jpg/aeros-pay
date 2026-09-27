import { getCurrentUser } from "@/lib/auth";
import { ProfileForm } from "@/components/forms/profile-form";
import { StatusBadge } from "@/components/status-badge";

export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) return null;

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="text-xl font-semibold">Profile</h1>

      <section className="card space-y-3 p-6">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Username</p>
          <p className="font-mono text-lg">@{user.username}</p>
          <p className="mt-1 text-xs text-muted">
            Your username is permanent and cannot be changed.
          </p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Status</p>
          <StatusBadge status={user.status} />
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted">Registered</p>
          <p>{new Date(user.createdAt).toLocaleDateString()}</p>
        </div>
      </section>

      <section className="card p-6">
        <h2 className="mb-3 font-medium">Edit display name</h2>
        <ProfileForm currentDisplayName={user.displayName} />
      </section>
    </div>
  );
}
