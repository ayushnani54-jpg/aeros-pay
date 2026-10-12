"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  createJobAction,
  applyForJobAction,
  reviewJobApplicationAction,
  completeAndPayJobAction,
} from "@/actions/v5";
import { V5ActionForm } from "./action-feedback";
import { CURRENCY_NAME } from "@/lib/constants";

export interface SerializedPublicJob {
  id: string;
  jobNumber: string;
  employerType: "GOVERNMENT" | "COMPANY";
  employerCompanyId: string | null;
  employerName: string;
  employerHandle: string;
  title: string;
  category: string;
  description: string;
  requirements: string;
  compensationAeros: number;
  status: "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "CLOSED";
  hiredUserId: string | null;
  createdAt: string;
}

export interface SerializedUserApplication {
  id: string;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  compensationAeros: number;
  jobStatus: string;
  coverNote: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";
  createdAt: string;
}

export interface SerializedEmployerApplication {
  id: string;
  jobId: string;
  jobNumber: string;
  jobTitle: string;
  jobStatus: string;
  compensationAeros: number;
  employerCompanyId: string | null;
  applicantUsername: string;
  applicantDisplayName: string;
  coverNote: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "WITHDRAWN";
  createdAt: string;
}

export function JobsAndMarketplaceTabs({
  publicListingsNode,
  publicJobs,
  myApplications,
  employerApplications,
  ownedCompanies,
  currentUserId,
}: {
  publicListingsNode: React.ReactNode;
  publicJobs: SerializedPublicJob[];
  myApplications: SerializedUserApplication[];
  employerApplications: SerializedEmployerApplication[];
  ownedCompanies: Array<{ id: string; name: string; username: string; balance: number }>;
  currentUserId: string;
}) {
  const [sectionTab, setSectionTab] = useState<"PUBLIC_GOODS" | "JOBS" | "MY_ACTIVITY">(
    "PUBLIC_GOODS",
  );
  const [applyingJobId, setApplyingJobId] = useState<string | null>(null);

  const openJobs = publicJobs.filter((j) => j.status === "OPEN");
  const myAppliedJobIds = new Set(myApplications.map((a) => a.jobId));
  const myCompanyIds = new Set(ownedCompanies.map((c) => c.id));
  void currentUserId;

  return (
    <div className="space-y-5">
      {/* V5 Marketplace & Jobs Coordinated Banner */}
      <div className="theme-marketplace-banner rounded-xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-blue-400/20 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-blue-200">
                V5 Commerce &amp; Employment Hub
              </span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/90">
                {openJobs.length} Open Citizen Jobs
              </span>
            </div>
            <h1 className="mt-1.5 text-xl font-semibold sm:text-2xl">
              Marketplace Listings, Citizen Jobs &amp; My Activity
            </h1>
            <p className="mt-0.5 text-xs text-blue-100/85">
              Public goods &amp; services, Government and Company jobs for Citizens, and a dedicated
              workspace for your own orders and applications.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Link
              href="/market/orders"
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
            >
              My Orders
            </Link>
            <Link
              href="/market/contracts"
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
            >
              Contracts
            </Link>
            <Link
              href="/market/wanted"
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
            >
              Wanted Board
            </Link>
            <Link
              href="/market/leaderboard"
              className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/25"
            >
              Leaderboard
            </Link>
          </div>
        </div>

        {/* Primary Section Switcher: Public Listings vs Citizen Jobs vs My Activity */}
        <div className="mt-4 flex flex-wrap gap-2 border-t border-white/15 pt-3">
          <button
            type="button"
            onClick={() => setSectionTab("PUBLIC_GOODS")}
            className={`rounded-lg px-3.5 py-2 text-xs font-bold transition-all ${
              sectionTab === "PUBLIC_GOODS"
                ? "bg-white text-blue-950 shadow-xs"
                : "bg-white/10 text-white hover:bg-white/20"
            }`}
          >
            Public Goods &amp; Services
          </button>
          <button
            type="button"
            onClick={() => setSectionTab("JOBS")}
            className={`rounded-lg px-3.5 py-2 text-xs font-bold transition-all ${
              sectionTab === "JOBS"
                ? "bg-white text-blue-950 shadow-xs"
                : "bg-white/10 text-white hover:bg-white/20"
            }`}
          >
            Citizen Jobs Board ({openJobs.length})
          </button>
          <button
            type="button"
            onClick={() => setSectionTab("MY_ACTIVITY")}
            className={`rounded-lg px-3.5 py-2 text-xs font-bold transition-all ${
              sectionTab === "MY_ACTIVITY"
                ? "bg-white text-blue-950 shadow-xs"
                : "bg-white/10 text-white hover:bg-white/20"
            }`}
          >
            My Activity ({myApplications.length + employerApplications.length})
          </button>
        </div>
      </div>

      {/* SECTION 1: PUBLIC MARKETPLACE LISTINGS */}
      {sectionTab === "PUBLIC_GOODS" && <div className="space-y-5">{publicListingsNode}</div>}

      {/* SECTION 2: CITIZEN JOBS & EMPLOYMENT BOARD */}
      {sectionTab === "JOBS" && (
        <div className="space-y-5">
          <div className="card border-blue-200 bg-blue-50/50 p-4 text-xs">
            <p className="font-semibold text-blue-950">
              Citizen Employment Rules (Aeros Pay V5)
            </p>
            <p className="mt-0.5 text-blue-900">
              Both the <strong>Government</strong> and <strong>Registered Companies</strong> can
              offer paid jobs to Citizens (Users). Companies can never offer employment jobs to
              other Companies (for inter-company collaboration, use{" "}
              <Link href="/companies" className="font-semibold underline">
                Company-to-Company Partnerships
              </Link>
              ).
            </p>
          </div>

          {ownedCompanies.length > 0 && (
            <div className="card p-4 sm:p-5">
              <h2 className="font-semibold">Post a New Job for Citizens (Company Employer)</h2>
              <p className="mt-0.5 text-xs text-muted">
                Hire a Citizen to complete work for your company and settle compensation atomically
                in whole {CURRENCY_NAME}.
              </p>

              <V5ActionForm
                action={createJobAction}
                operationKey="create-company-job"
                operationTitle="Posting Citizen Job"
                processingDetail="Verifying company funds and publishing job listing..."
                className="mt-3 space-y-3"
                onSuccessReset
              >
                {(pending) => (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div>
                        <label className="text-xs font-medium">Hiring Company</label>
                        <select name="companyId" className="input mt-1 text-xs" required>
                          {ownedCompanies.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name} (@{c.username} · {c.balance.toLocaleString("en-IN")} A)
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium">Job Title</label>
                        <input
                          name="title"
                          placeholder="e.g. Market Research Analyst"
                          required
                          minLength={3}
                          maxLength={160}
                          className="input mt-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium">Category</label>
                        <input
                          name="category"
                          placeholder="e.g. Operations, Design, Finance"
                          required
                          minLength={2}
                          maxLength={64}
                          className="input mt-1 text-xs"
                        />
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="sm:col-span-2">
                        <label className="text-xs font-medium">Job Description</label>
                        <textarea
                          name="description"
                          rows={2}
                          required
                          minLength={10}
                          placeholder="Describe the deliverables and scope of work..."
                          className="input mt-1 text-xs"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium">
                          Compensation ({CURRENCY_NAME})
                        </label>
                        <input
                          name="compensationAeros"
                          type="number"
                          min={1}
                          step={1}
                          placeholder="500"
                          required
                          className="input mt-1 font-mono text-xs"
                        />
                        <label className="mt-2 block text-xs font-medium">Requirements</label>
                        <input
                          name="requirements"
                          placeholder="Skills or timeline required..."
                          required
                          minLength={5}
                          className="input mt-1 text-xs"
                        />
                      </div>
                    </div>

                    <button type="submit" disabled={pending} className="btn btn-primary text-xs">
                      {pending ? "Publishing Job..." : "Publish Citizen Job"}
                    </button>
                  </>
                )}
              </V5ActionForm>
            </div>
          )}

          {/* Open Jobs Grid */}
          <div className="space-y-3">
            <h2 className="font-semibold">Open Jobs for Citizens ({openJobs.length})</h2>
            {openJobs.length === 0 ? (
              <div className="card p-6 text-center text-sm text-muted">
                No open jobs are posted right now. Check back soon or post a job from your company.
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {openJobs.map((job) => {
                  const alreadyApplied = myAppliedJobIds.has(job.id);
                  const isMyOwnCompanyJob =
                    job.employerCompanyId !== null && myCompanyIds.has(job.employerCompanyId);

                  return (
                    <div key={job.id} className="card flex flex-col justify-between p-4 sm:p-5">
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[11px] font-bold text-muted">
                                {job.jobNumber}
                              </span>
                              <span
                                className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                                  job.employerType === "GOVERNMENT"
                                    ? "bg-black text-white"
                                    : "bg-blue-100 text-blue-900"
                                }`}
                              >
                                {job.employerType === "GOVERNMENT"
                                  ? "GOVERNMENT EMPLOYER"
                                  : "COMPANY EMPLOYER"}
                              </span>
                              <span className="rounded bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
                                {job.category}
                              </span>
                            </div>
                            <h3 className="mt-1.5 text-base font-semibold">{job.title}</h3>
                            <p className="text-xs text-muted">
                              Offered by <strong>{job.employerName}</strong> (@{job.employerHandle})
                            </p>
                          </div>

                          <div className="shrink-0 text-right">
                            <p className="font-mono text-lg font-bold text-[#146c2e]">
                              {job.compensationAeros.toLocaleString("en-IN")} A
                            </p>
                            <p className="text-[10px] text-muted">On completion</p>
                          </div>
                        </div>

                        <p className="mt-2.5 text-xs leading-relaxed text-foreground">
                          {job.description}
                        </p>
                        <p className="mt-1.5 text-[11px] text-muted">
                          <strong>Requirements:</strong> {job.requirements}
                        </p>
                      </div>

                      <div className="mt-4 border-t border-border pt-3">
                        {alreadyApplied ? (
                          <span className="badge badge-active">
                            ✓ Application Submitted (See My Activity)
                          </span>
                        ) : isMyOwnCompanyJob ? (
                          <span className="text-xs text-muted">
                            Posted by your company — manage applicants in My Activity.
                          </span>
                        ) : applyingJobId === job.id ? (
                          <V5ActionForm
                            action={applyForJobAction}
                            operationKey={`apply-job-${job.id}`}
                            operationTitle={`Applying for ${job.jobNumber}`}
                            className="space-y-2"
                          >
                            {(pending) => (
                              <>
                                <input type="hidden" name="jobId" value={job.id} />
                                <textarea
                                  name="coverNote"
                                  rows={2}
                                  required
                                  minLength={5}
                                  placeholder="Briefly explain why you are a great fit for this role..."
                                  className="input text-xs"
                                />
                                <div className="flex gap-2">
                                  <button
                                    type="submit"
                                    disabled={pending}
                                    className="btn btn-primary text-xs"
                                  >
                                    {pending ? "Submitting..." : "Submit Application"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setApplyingJobId(null)}
                                    className="btn btn-secondary text-xs"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </>
                            )}
                          </V5ActionForm>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setApplyingJobId(job.id)}
                            className="btn btn-primary w-full text-xs"
                          >
                            Apply as Citizen ({job.compensationAeros.toLocaleString("en-IN")} A)
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* SECTION 3: MY ACTIVITY (APPLICATIONS, HIRING & QUICK LINKS) */}
      {sectionTab === "MY_ACTIVITY" && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <Link href="/market/orders" className="card p-4 hover:border-black">
              <p className="text-xs font-semibold uppercase text-muted">Marketplace Orders</p>
              <p className="mt-1 font-semibold">View My Buyer &amp; Seller Orders →</p>
            </Link>
            <Link href="/market/contracts" className="card p-4 hover:border-black">
              <p className="text-xs font-semibold uppercase text-muted">Contracts</p>
              <p className="mt-1 font-semibold">View My Awarded Contracts →</p>
            </Link>
            <Link href="/market/wanted" className="card p-4 hover:border-black">
              <p className="text-xs font-semibold uppercase text-muted">Wanted Requests</p>
              <p className="mt-1 font-semibold">Manage My Wanted Posts →</p>
            </Link>
          </div>

          {/* Citizen's Own Job Applications */}
          <div className="card p-4 sm:p-5">
            <h2 className="font-semibold">
              My Citizen Job Applications ({myApplications.length})
            </h2>
            {myApplications.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                You haven&apos;t applied to any jobs yet. Browse the Citizen Jobs Board to apply.
              </p>
            ) : (
              <div className="mt-3 divide-y divide-border">
                {myApplications.map((app) => (
                  <div
                    key={app.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs"
                  >
                    <div>
                      <span className="font-mono font-bold">{app.jobNumber}</span> ·{" "}
                      <span className="font-semibold">{app.jobTitle}</span> (
                      {app.compensationAeros.toLocaleString("en-IN")} A)
                      <p className="mt-0.5 text-muted">Cover Note: {app.coverNote}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="badge bg-surface text-[10px]">Job: {app.jobStatus}</span>
                      <span
                        className={`badge ${
                          app.status === "ACCEPTED"
                            ? "badge-active"
                            : app.status === "REJECTED"
                              ? "badge-banned"
                              : "badge-suspended"
                        }`}
                      >
                        {app.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Employer View: Applications to My Company's Jobs */}
          {ownedCompanies.length > 0 && (
            <div className="card p-4 sm:p-5">
              <h2 className="font-semibold">
                Applicants for Your Company Jobs ({employerApplications.length})
              </h2>
              {employerApplications.length === 0 ? (
                <p className="mt-2 text-xs text-muted">
                  No citizen applications received for your company jobs yet.
                </p>
              ) : (
                <div className="mt-3 divide-y divide-border">
                  {employerApplications.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 text-xs"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold">{item.jobNumber}</span>
                          <span className="font-semibold">{item.jobTitle}</span>
                          <span className="font-mono text-[#146c2e]">
                            {item.compensationAeros.toLocaleString("en-IN")} A
                          </span>
                        </div>
                        <p className="mt-0.5">
                          Applicant: <strong>{item.applicantDisplayName}</strong> (@
                          {item.applicantUsername}) — &ldquo;{item.coverNote}&rdquo;
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {item.status === "PENDING" && item.jobStatus === "OPEN" && (
                          <>
                            <V5ActionForm
                              action={reviewJobApplicationAction}
                              operationKey={`hire-app-${item.id}`}
                              operationTitle={`Hiring @${item.applicantUsername}`}
                              className="inline-block"
                            >
                              {(pending) => (
                                <>
                                  <input type="hidden" name="applicationId" value={item.id} />
                                  <input type="hidden" name="decision" value="ACCEPT" />
                                  <input
                                    type="hidden"
                                    name="companyId"
                                    value={item.employerCompanyId ?? ""}
                                  />
                                  <button
                                    type="submit"
                                    disabled={pending}
                                    className="btn btn-primary px-3 py-1 text-xs"
                                  >
                                    {pending ? "Hiring..." : "Hire Citizen"}
                                  </button>
                                </>
                              )}
                            </V5ActionForm>
                            <V5ActionForm
                              action={reviewJobApplicationAction}
                              operationKey={`reject-app-${item.id}`}
                              operationTitle={`Rejecting @${item.applicantUsername}`}
                              className="inline-block"
                            >
                              {(pending) => (
                                <>
                                  <input type="hidden" name="applicationId" value={item.id} />
                                  <input type="hidden" name="decision" value="REJECT" />
                                  <input
                                    type="hidden"
                                    name="companyId"
                                    value={item.employerCompanyId ?? ""}
                                  />
                                  <button
                                    type="submit"
                                    disabled={pending}
                                    className="btn btn-danger px-3 py-1 text-xs"
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                            </V5ActionForm>
                          </>
                        )}

                        {item.status === "ACCEPTED" && item.jobStatus === "IN_PROGRESS" && (
                          <V5ActionForm
                            action={completeAndPayJobAction}
                            operationKey={`complete-job-${item.jobId}`}
                            operationTitle={`Completing & Paying ${item.jobNumber}`}
                            processingDetail={`Transferring ${item.compensationAeros} A to @${item.applicantUsername}...`}
                            className="inline-block"
                          >
                            {(pending) => (
                              <>
                                <input type="hidden" name="jobId" value={item.jobId} />
                                <input
                                  type="hidden"
                                  name="companyId"
                                  value={item.employerCompanyId ?? ""}
                                />
                                <button
                                  type="submit"
                                  disabled={pending}
                                  className="btn btn-primary px-3 py-1 text-xs"
                                >
                                  {pending
                                    ? "Paying..."
                                    : `Complete & Pay (${item.compensationAeros.toLocaleString("en-IN")} A)`}
                                </button>
                              </>
                            )}
                          </V5ActionForm>
                        )}

                        <span
                          className={`badge ${
                            item.jobStatus === "COMPLETED" || item.status === "ACCEPTED"
                              ? "badge-active"
                              : item.status === "REJECTED"
                                ? "badge-banned"
                                : "badge-suspended"
                          }`}
                        >
                          {item.jobStatus === "COMPLETED" ? "COMPLETED & PAID" : item.status}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
