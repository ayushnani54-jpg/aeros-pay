import {
  PROTECTED_TABLE_NAMES,
  getRetentionSettings,
  getStorageCounts,
  previewFullCleanup,
  previewTextScrub,
  runDueCleanupLazily,
} from "@/lib/retention";
import {
  ArchiveAuditForm,
  ClearUpdatesForm,
  RetentionSettingsForm,
  RunCleanupForm,
  RunTextScrubForm,
  TextScrubSettingsForm,
  V3RetentionSettingsForm,
} from "@/components/forms/gov-forms";
import { formatDateTime } from "@/lib/datetime";

/**
 * Data retention & cleanup (spec §§31, 36, 37, 49–52, 58).
 *
 * Opening this page is also the LAZY FALLBACK for the scheduled job: it claims
 * at most one automatic cleanup per IST calendar day, so the app stays tidy
 * and correct even if the nightly cron never fires. The claim is a single
 * conditional UPDATE, so two Government tabs opened at once still produce one
 * run, and it is deliberately given a small budget because it is happening
 * inside somebody's page load.
 */
export default async function GovRetentionPage() {
  await runDueCleanupLazily().catch(() => undefined);

  const [settings, preview, counts, textScrubPreview] = await Promise.all([
    getRetentionSettings(),
    previewFullCleanup(),
    getStorageCounts(),
    previewTextScrub(),
  ]);

  const summary = preview.lastSummary;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Data retention & cleanup</h1>
        <p className="mt-1 text-sm text-muted">
          Control how long temporary data is kept. Financial records are never covered by
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
              <li>• Paused market listings (closed, not deleted)</li>
              <li>• Rating comments (the star always survives)</li>
              <li>• Lapsed wanted requests and their replies</li>
              <li>• Lapsed orders that never produced a payment</li>
              <li>• Applications to closed contracts</li>
              <li>• Rejected promotions that were never charged</li>
              <li>• Payment replay keys past their expiry</li>
            </ul>
          </div>
          <div>
            <p className="font-medium">Never deleted</p>
            <ul className="mt-1 space-y-1 text-muted">
              <li>• Transactions, taxes and the ledger</li>
              <li>• Users, balances and companies</li>
              <li>• Invoices, loans, repayments and issuance</li>
              <li>• Treasury movements and company funding</li>
              <li>• Company ownership, transfers and sale records</li>
              <li>• Paid or completed orders</li>
              <li>• Audit log (archive only, never delete)</li>
            </ul>
            <p className="mt-2 text-xs text-muted">
              This is structural, not a rule someone has to remember:{" "}
              {PROTECTED_TABLE_NAMES.size} of the {PROTECTED_TABLE_NAMES.size + 11} tables in the
              database are unreachable from any cleanup path, because cleanup can only act on the
              tables named in its allowlist.
            </p>
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
        <h2 className="mb-1 font-medium">Scheduled cleanup</h2>
        <p className="mb-3 text-sm text-muted">
          A single job runs once a day and does exactly what the button below does. Opening this
          page also runs it, at most once per day, so nothing depends on the schedule firing.
        </p>
        <dl className="space-y-1 text-sm">
          <Row label="Last run">
            {preview.lastCleanupAt ? formatDateTime(preview.lastCleanupAt) : "never"}
          </Row>
          <Row label="Last successful run">
            {preview.lastCleanupSuccessAt
              ? formatDateTime(preview.lastCleanupSuccessAt)
              : "never"}
          </Row>
          {summary && (
            <>
              <Row label="Records removed or cleared last run">
                {summary.totalAffected.toLocaleString()}
              </Row>
              <Row label="Started by">
                {summary.source === "GOVERNMENT"
                  ? "you"
                  : summary.source === "CRON"
                    ? "the daily schedule"
                    : "opening a Government page"}
              </Row>
              <Row label="Finished the whole backlog">
                {summary.completed ? "yes" : "no — the rest is picked up next run"}
              </Row>
              {summary.failures.length > 0 && (
                <Row label="Failures">
                  <span className="text-danger">{summary.failures.join("; ")}</span>
                </Row>
              )}
            </>
          )}
        </dl>
        <p className="mt-3 text-xs text-muted">
          A cleanup writes no record of what it deleted — only this summary. Deleting data and
          then keeping a list of what was deleted would not be deleting it.
        </p>
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
        <h2 className="mb-1 font-medium">Market &amp; V3 retention periods</h2>
        <p className="mb-3 text-sm text-muted">
          The temporary records the marketplace creates. Each period is measured from the moment
          the record became temporary — when a listing was paused, when an order lapsed, when a
          contract closed.
        </p>
        <V3RetentionSettingsForm
          pausedOfferRetentionDays={settings.pausedOfferRetentionDays}
          ratingCommentRetentionDays={settings.ratingCommentRetentionDays}
          expiredWantedRetentionDays={settings.expiredWantedRetentionDays}
          expiredOrderRetentionDays={settings.expiredOrderRetentionDays}
          expiredContractRetentionDays={settings.expiredContractRetentionDays}
          promotionCampaignRetentionDays={settings.promotionCampaignRetentionDays}
          idempotencyKeyRetentionDays={settings.idempotencyKeyRetentionDays}
        />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Cleanup</h2>
        <dl className="mb-4 space-y-2 text-sm">
          {preview.targets.map((t) => (
            <div key={t.key} className="flex flex-wrap justify-between gap-2">
              <dt>
                <span className="text-muted">{t.label}</span>
                <span className="ml-2 text-xs text-muted">
                  {t.op === "DELETE_ROWS"
                    ? "deleted"
                    : t.op === "CLEAR_COLUMNS"
                      ? "cleared"
                      : "closed"}
                </span>
              </dt>
              <dd>
                {t.retentionDays === null ? (
                  <span className="text-muted">no policy — never</span>
                ) : (
                  <>
                    {t.eligible.toLocaleString()} of {t.total.toLocaleString()}{" "}
                    <span className="text-muted">(after {t.retentionDays} days)</span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>

        <RunCleanupForm />
      </section>

      <section className="card border-[#111111] p-5">
        <h2 className="font-medium">Text-field scrubbing</h2>
        <p className="mt-1 mb-3 text-sm text-muted">
          A separate, narrower capability: this never deletes a row and never touches an amount,
          balance, id, party or timestamp. It only clears specific free-text notes/reasons on
          transactions, invoices, loans and issuance records once they are older than the
          configured age.
        </p>
        <dl className="mb-4 space-y-1 text-sm">
          <ScrubRow
            label="Transaction reasons eligible"
            eligible={textScrubPreview.transactions.eligible}
            days={textScrubPreview.transactions.maxAgeDays}
          />
          <ScrubRow
            label="Invoice text eligible"
            eligible={textScrubPreview.invoices.eligible}
            days={textScrubPreview.invoices.maxAgeDays}
          />
          <ScrubRow
            label="Loan text eligible"
            eligible={textScrubPreview.loans.eligible}
            days={textScrubPreview.loans.maxAgeDays}
          />
          <ScrubRow
            label="Issuance notes eligible"
            eligible={textScrubPreview.issuanceNotes.eligible}
            days={textScrubPreview.issuanceNotes.maxAgeDays}
          />
        </dl>
        <p className="mb-3 text-sm text-muted">
          Last scrub:{" "}
          {textScrubPreview.lastScrubAt ? formatDateTime(textScrubPreview.lastScrubAt) : "never"}.
        </p>

        <div className="mb-4">
          <TextScrubSettingsForm
            transactionReasonMaxAgeDays={settings.transactionReasonMaxAgeDays}
            invoiceTextMaxAgeDays={settings.invoiceTextMaxAgeDays}
            loanTextMaxAgeDays={settings.loanTextMaxAgeDays}
            issuanceNoteMaxAgeDays={settings.issuanceNoteMaxAgeDays}
          />
        </div>

        <RunTextScrubForm />
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ScrubRow({
  label,
  eligible,
  days,
}: {
  label: string;
  eligible: number;
  days: number | null;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd>
        {days === null ? (
          <span className="text-muted">no policy — never</span>
        ) : (
          <>
            {eligible.toLocaleString()}{" "}
            <span className="text-muted">(older than {days} days)</span>
          </>
        )}
      </dd>
    </div>
  );
}
