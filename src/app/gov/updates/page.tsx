import { getAllUpdates } from "@/lib/queries";
import { PublishUpdateForm } from "@/components/forms/publish-update-form";

export default async function GovUpdatesPage() {
  const updates = await getAllUpdates();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Updates</h1>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Publish a new update</h2>
        <PublishUpdateForm />
      </section>

      <section className="space-y-3">
        {updates.map((u) => (
          <div key={u.id} className="card p-5">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">{u.title}</h3>
              <span className="text-xs text-muted">{new Date(u.createdAt).toLocaleString()}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{u.content}</p>
          </div>
        ))}
        {updates.length === 0 && <p className="text-sm text-muted">No updates published yet.</p>}
      </section>
    </div>
  );
}
