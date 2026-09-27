import {
  getRetentionSettings,
  getStorageCounts,
  previewCleanup,
} from "@/lib/retention";
import {
  ArchiveAuditForm,
  ClearUpdatesForm,
  RetentionSettingsForm,
  RunCleanupForm,
} from "@/components/forms/gov-forms";

/**
 * Data retention & cleanup (spec §49–52).
 *
 * Only disposable data can ever be deleted here. The transactions table is
 * deliberately absent from this whole feature — deleting ledger rows would
 * corrupt balances, supply and tax totals.
 */
export default async function GovRetentionPage() {
  const [settings, preview, counts] = await Promise.all([
    getRetentionSettings(),
    previewCleanup(),
    getStorageCounts(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Data retention & cleanup</h1>
        <p className="mt-1 text-sm text-muted">
          Control how long disposable data is kept. Financial records are never covered by
          retention.
        </p>
      </div>

      <section className="card border-[#111111] p-5">
        <h2 className="font-medium">What can and cannot be deleted</h2>
        <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">Can be cleaned up</p>
            <ul className="mt-1 space-y-1 text-muted">
              <li>• Updates / announcements</li>
              <li>• Personal notifications</li>
              <li>• Support messages</li>
            </ul>
          </div>
          <div>
            <p className="font-medium">Never deleted</p>
            <ul className="mt-1 space-y-1 text-muted">
              <li>• Transactions and the ledger</li>
              <li>• Users, balances and companies</li>
              <li>• Invoices, loans and issuance records</li>
              <li>• Audit log (archive only, never delete)</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Updates" value={counts.updates} />
        <Stat label="Notifications" value={counts.notifications} />
        <Stat label="Support messages" value={counts.supportMessages} />
        <Stat
          label="Audit entries"
          value={counts.auditLogs}
          sub={`${counts.auditLogsArchived} archived`}
        />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Retention periods</h2>
        <RetentionSettingsForm
          updatesDays={settings.updatesRetentionDays}
          notificationsDays={settings.notificationsRetentionDays}
          supportDays={settings.supportRetentionDays}
        />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Cleanup</h2>
        <dl className="mb-4 space-y-1 text-sm">
          <PreviewRow
            label="Updates eligible for removal"
            eligible={preview.updates.eligible}
            total={preview.updates.total}
            days={preview.updates.retentionDays}
          />
          <PreviewRow
            label="Notifications eligible for removal"
            eligible={preview.notifications.eligible}
            total={preview.notifications.total}
            days={preview.notifications.retentionDays}
          />
          <PreviewRow
            label="Support messages eligible for removal"
            eligible={preview.supportMessages.eligible}
            total={preview.supportMessages.total}
            days={preview.supportMessages.retentionDays}
          />
        </dl>

        <p className="mb-3 text-sm text-muted">
          Last cleanup:{" "}
          {preview.lastCleanupAt ? new Date(preview.lastCleanupAt).toLocaleString() : "never"}.{" "}
          {preview.nextCleanupHint}
        </p>

        <RunCleanupForm />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Clear all updates</h2>
        <p className="mb-3 text-sm text-muted">
          Removes every announcement regardless of the retention period. Does not touch any
          financial data.
        </p>
        <ClearUpdatesForm />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Audit log archiving</h2>
        <p className="mb-3 text-sm text-muted">
          Audit entries are never deleted. Archiving simply hides older entries from the active
          view while keeping them permanently in the database.
        </p>
        <ArchiveAuditForm />
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

function PreviewRow({
  label,
  eligible,
  total,
  days,
}: {
  label: string;
  eligible: number;
  total: number;
  days: number | null;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd>
        {days === null ? (
          <span className="text-muted">no policy — kept forever</span>
        ) : (
          <>
            {eligible.toLocaleString()} of {total.toLocaleString()}{" "}
            <span className="text-muted">(older than {days} days)</span>
          </>
        )}
      </dd>
    </div>
  );
}
