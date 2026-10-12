"use client";

import Link from "next/link";
import { V5ActionForm } from "@/components/v5/action-feedback";
import {
  createJobAction,
  reviewJobApplicationAction,
  completeAndPayJobAction,
  moderateMediaPostAction,
} from "@/actions/v5";
import { CURRENCY_NAME } from "@/lib/constants";
import type { Job, JobApplication, MediaPost } from "@/db/schema";

interface GovJobApplicationRow {
  application: JobApplication;
  job: Job;
  applicantUsername: string;
  applicantDisplayName: string;
}

interface GovMediaItem {
  post: MediaPost;
  authorUsername: string;
  authorDisplayName: string;
}

export function GovControlRoomV5Panel({
  govJobs,
  govApplications,
  recentMediaPosts,
}: {
  govJobs: Job[];
  govApplications: GovJobApplicationRow[];
  recentMediaPosts: GovMediaItem[];
}) {
  const pendingApps = govApplications.filter((a) => a.application.status === "PENDING");
  const inProgressJobs = govJobs.filter((j) => j.status === "IN_PROGRESS");

  return (
    <div className="space-y-6">
      {/* Government Citizen Job Postings & Hiring Controls */}
      <section className="card border-emerald-200 bg-gradient-to-br from-emerald-50/40 via-white to-white p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-emerald-900 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
                Public Employment
              </span>
              <h2 className="text-base font-semibold">
                Government Citizen Jobs &amp; Treasury Compensation
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted">
              Post public employment opportunities for Citizens, review Citizen applications, hire
              workers, and execute atomic Treasury completion payouts.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-semibold text-emerald-900">
              {govJobs.filter((j) => j.status === "OPEN").length} Open Gov Jobs
            </span>
            <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-900">
              {pendingApps.length} Pending Applicants
            </span>
          </div>
        </div>

        {/* Post a Government Job Form */}
        <V5ActionForm
          action={createJobAction}
          operationKey="gov-post-citizen-job"
          operationTitle="Posting Government Citizen Job"
          processingDetail="Creating public job listing for Citizens..."
          onSuccessReset
          className="mt-4 rounded-xl border border-border bg-white p-4"
        >
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Post a New Government Job for Citizens
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="label text-xs">Job Title</label>
              <input
                name="title"
                required
                placeholder="e.g. Economic Archive Auditor"
                className="input text-xs"
              />
            </div>
            <div>
              <label className="label text-xs">Category</label>
              <input
                name="category"
                required
                defaultValue="Public Administration"
                placeholder="e.g. Public Administration"
                className="input text-xs"
              />
            </div>
            <div>
              <label className="label text-xs">Compensation ({CURRENCY_NAME})</label>
              <input
                type="number"
                name="compensationAeros"
                min={1}
                max={1000000}
                required
                defaultValue={500}
                className="input font-mono text-xs"
              />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label text-xs">Role Description</label>
              <textarea
                name="description"
                rows={2}
                required
                placeholder="Describe responsibilities and deliverables..."
                className="input text-xs"
              />
            </div>
            <div>
              <label className="label text-xs">Citizen Requirements</label>
              <textarea
                name="requirements"
                rows={2}
                required
                placeholder="Minimum skills or verification criteria..."
                className="input text-xs"
              />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="submit" className="btn btn-primary text-xs">
              Publish Government Job
            </button>
          </div>
        </V5ActionForm>

        {/* Active In-Progress Gov Jobs Ready for Completion & Payout */}
        {inProgressJobs.length > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-emerald-900">
              In-Progress Government Jobs ({inProgressJobs.length})
            </h3>
            {inProgressJobs.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-300 bg-emerald-50/60 p-3 text-xs"
              >
                <div>
                  <span className="font-mono font-semibold">{job.jobNumber}</span> ·{" "}
                  <span className="font-semibold text-sm">{job.title}</span> ·{" "}
                  <span className="font-mono font-semibold text-emerald-900">
                    {job.compensationAeros.toLocaleString("en-IN")} {CURRENCY_NAME}
                  </span>
                </div>
                <V5ActionForm
                  action={completeAndPayJobAction}
                  operationKey={`gov-complete-job-${job.id}`}
                  operationTitle={`Paying Citizen for ${job.jobNumber}`}
                  processingDetail="Executing atomic Treasury transfer to hired Citizen..."
                >
                  <input type="hidden" name="jobId" value={job.id} />
                  <button
                    type="submit"
                    className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                  >
                    Mark Completed &amp; Pay {job.compensationAeros.toLocaleString("en-IN")}{" "}
                    {CURRENCY_NAME}
                  </button>
                </V5ActionForm>
              </div>
            ))}
          </div>
        )}

        {/* Pending Citizen Applications for Government Jobs */}
        {pendingApps.length > 0 && (
          <div className="mt-4 space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-900">
              Pending Citizen Job Applications ({pendingApps.length})
            </h3>
            {pendingApps.map(({ application: app, job, applicantUsername, applicantDisplayName }) => (
              <div
                key={app.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50/50 p-3 text-xs"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold">{job.jobNumber}</span>
                    <span className="font-semibold">{job.title}</span>
                    <span className="font-mono text-emerald-800">
                      ({job.compensationAeros.toLocaleString("en-IN")} {CURRENCY_NAME})
                    </span>
                  </div>
                  <p className="mt-1">
                    Applicant:{" "}
                    <Link
                      href={`/gov/users/${app.userId}`}
                      className="font-semibold hover:underline"
                    >
                      {applicantDisplayName} (@{applicantUsername})
                    </Link>
                  </p>
                  <p className="mt-1 rounded bg-white/80 p-2 text-foreground">{app.coverNote}</p>
                </div>
                <div className="flex items-center gap-2">
                  <V5ActionForm
                    action={reviewJobApplicationAction}
                    operationKey={`gov-hire-app-${app.id}`}
                    operationTitle={`Hiring @${applicantUsername} for ${job.jobNumber}`}
                  >
                    <input type="hidden" name="applicationId" value={app.id} />
                    <input type="hidden" name="decision" value="ACCEPT" />
                    <button
                      type="submit"
                      className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                    >
                      Accept &amp; Hire Citizen
                    </button>
                  </V5ActionForm>
                  <V5ActionForm
                    action={reviewJobApplicationAction}
                    operationKey={`gov-reject-app-${app.id}`}
                    operationTitle={`Rejecting application from @${applicantUsername}`}
                  >
                    <input type="hidden" name="applicationId" value={app.id} />
                    <input type="hidden" name="decision" value="REJECT" />
                    <button
                      type="submit"
                      className="rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-100"
                    >
                      Reject
                    </button>
                  </V5ActionForm>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Aeros Media Moderation Overview */}
      <section className="card border-purple-200 bg-gradient-to-br from-purple-50/40 via-white to-white p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-purple-900 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
                Aeros Media
              </span>
              <h2 className="text-base font-semibold">
                Aeros Media Moderation &amp; 7-Day Public Retention Queue
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted">
              Monitor text-only Citizen posts, flag or hide policy violations, or restore hidden
              posts. Public posts automatically expire after 7 days and archive to{" "}
              <span className="font-mono">aeros-archive-media</span>.
            </p>
          </div>
          <Link href="/media" className="btn btn-secondary text-xs">
            Open Aeros Media Feed →
          </Link>
        </div>

        {recentMediaPosts.length === 0 ? (
          <p className="mt-4 text-xs text-muted">No Aeros Media posts recorded yet.</p>
        ) : (
          <div className="mt-4 divide-y divide-border text-xs">
            {recentMediaPosts.slice(0, 15).map(({ post, authorUsername, authorDisplayName }) => (
              <div
                key={post.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold text-muted">{post.postNumber}</span>
                    <span className="font-semibold">
                      {authorDisplayName} (@{authorUsername})
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        post.moderationStatus === "ACTIVE"
                          ? "bg-emerald-50 text-emerald-800"
                          : post.moderationStatus === "FLAGGED"
                            ? "bg-amber-100 text-amber-900"
                            : "bg-red-100 text-red-800"
                      }`}
                    >
                      {post.moderationStatus}
                    </span>
                    {post.isExpired && (
                      <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-muted">
                        EXPIRED (&gt;7d)
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 text-foreground">{post.content}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    ♥ {post.likesCount} · 💬 {post.commentsCount} · ↻ {post.sharesCount}
                    {post.moderatorReason ? ` · Mod note: ${post.moderatorReason}` : ""}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {post.moderationStatus !== "ACTIVE" && (
                    <V5ActionForm
                      action={moderateMediaPostAction}
                      operationKey={`cr-restore-${post.id}`}
                      operationTitle={`Restoring ${post.postNumber}`}
                    >
                      <input type="hidden" name="postId" value={post.id} />
                      <input type="hidden" name="action" value="RESTORE" />
                      <button
                        type="submit"
                        className="rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-900 hover:bg-emerald-100"
                      >
                        Restore
                      </button>
                    </V5ActionForm>
                  )}
                  {post.moderationStatus !== "FLAGGED" && (
                    <V5ActionForm
                      action={moderateMediaPostAction}
                      operationKey={`cr-flag-${post.id}`}
                      operationTitle={`Flagging ${post.postNumber}`}
                    >
                      <input type="hidden" name="postId" value={post.id} />
                      <input type="hidden" name="action" value="FLAG" />
                      <input
                        type="hidden"
                        name="reason"
                        value="Flagged by Government Control Room"
                      />
                      <button
                        type="submit"
                        className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                      >
                        Flag
                      </button>
                    </V5ActionForm>
                  )}
                  {post.moderationStatus !== "MODERATED_HIDDEN" && (
                    <V5ActionForm
                      action={moderateMediaPostAction}
                      operationKey={`cr-hide-${post.id}`}
                      operationTitle={`Hiding ${post.postNumber}`}
                    >
                      <input type="hidden" name="postId" value={post.id} />
                      <input type="hidden" name="action" value="HIDE" />
                      <input
                        type="hidden"
                        name="reason"
                        value="Hidden by Government Control Room"
                      />
                      <button
                        type="submit"
                        className="rounded border border-red-300 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-800 hover:bg-red-100"
                      >
                        Hide
                      </button>
                    </V5ActionForm>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

