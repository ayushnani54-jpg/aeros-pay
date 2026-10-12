"use server";

import { revalidatePath } from "next/cache";
import { requireGovernment, requireUser, getCurrentActor, getActingContext } from "@/lib/auth";
import {
  MarketError,
  openHedgePosition,
  closeHedgePosition,
  requestLeverageUpgrade,
  reviewLeverageRequest,
  updateMarketIntervalSetting,
} from "@/lib/synthetic-market";
import {
  JobError,
  createJobPosting,
  applyForJob,
  reviewJobApplication,
  completeAndPayJob,
} from "@/lib/jobs";
import {
  PartnershipError,
  proposeCompanyPartnership,
  respondToCompanyPartnership,
  reviewPartnershipByGovernment,
  executePartnershipSettlement,
} from "@/lib/partnerships";
import {
  MediaError,
  createMediaPost,
  toggleMediaLike,
  createMediaComment,
  shareMediaPost,
  moderateMediaPost,
} from "@/lib/media";
import {
  ArchiveError,
  startOrResumeV5ArchiveJob,
} from "@/lib/archive";
import {
  placeHedgePositionSchema,
  closeHedgePositionSchema,
  requestLeverageSchema,
  reviewLeverageRequestSchema,
  marketIntervalConfigSchema,
  createJobSchema,
  applyForJobSchema,
  reviewJobApplicationSchema,
  completeJobSchema,
  proposePartnershipSchema,
  respondPartnershipSchema,
  reviewGovernmentPartnershipSchema,
  settlePartnershipSchema,
  createMediaPostSchema,
  createMediaCommentSchema,
  moderateMediaPostSchema,
  startManualArchiveJobSchema,
} from "@/lib/validators";
import type { ActionResult } from "./auth";

function v5ErrMsg(e: unknown, fallback: string): string {
  if (
    e instanceof MarketError ||
    e instanceof JobError ||
    e instanceof PartnershipError ||
    e instanceof MediaError ||
    e instanceof ArchiveError
  ) {
    return e.message;
  }
  if (e instanceof Error && e.message) {
    if (e.message === "NOT_AUTHENTICATED") return "You must be signed in.";
    if (e.message === "ACCOUNT_BANNED") return "Banned accounts cannot perform this action.";
    if (e.message === "NOT_AUTHENTICATED_GOVERNMENT") {
      return "Government authorization required.";
    }
    return e.message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// 1. HEDGE TRADING (BUY = LONG, SELL = SHORT) & LEVERAGE PROGRESSION
// ---------------------------------------------------------------------------

export async function openHedgePositionAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Authentication required.") };
  }

  const rawSide = String(formData.get("side") ?? formData.get("direction") ?? "BUY");
  const direction = rawSide === "SELL" || rawSide === "SHORT" ? "SHORT" : "LONG";

  const parsed = placeHedgePositionSchema.safeParse({
    direction,
    quantity: formData.get("quantity"),
    leverage: formData.get("leverage") || "2",
    expectedPrice: formData.get("expectedPrice"),
    maxSlippageBp: formData.get("maxSlippageBp") || "500",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid trade parameters." };
  }

  try {
    const pos = await openHedgePosition({
      userId: u.id,
      direction: parsed.data.direction,
      quantity: parsed.data.quantity,
      leverage: parsed.data.leverage,
      expectedPrice: parsed.data.expectedPrice,
      maxSlippageBp: parsed.data.maxSlippageBp,
    });

    revalidatePath("/aeros-market");
    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    revalidatePath("/gov/market");

    const dirLabel = pos.direction === "LONG" ? "LONG (BUY)" : "SHORT (SELL)";
    return {
      ok: true,
      message: `${dirLabel} position ${pos.positionNumber} opened: ${pos.quantity} units @ ${pos.entryPrice.toLocaleString("en-IN")} A (${pos.leverage}x leverage, margin locked: ${pos.marginLocked.toLocaleString("en-IN")} A).`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to open hedge position.") };
  }
}

export async function closeHedgePositionAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Authentication required.") };
  }

  const parsed = closeHedgePositionSchema.safeParse({
    positionId: formData.get("positionId"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid close parameters." };
  }

  try {
    const closed = await closeHedgePosition({
      userId: u.id,
      positionId: parsed.data.positionId,
    });

    revalidatePath("/aeros-market");
    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    revalidatePath("/gov/market");

    const pnlSign = closed.realizedPnl >= 0 ? "+" : "";
    return {
      ok: true,
      message: `Closed ${closed.direction} position ${closed.positionNumber} @ ${(closed.closePrice ?? closed.entryPrice).toLocaleString("en-IN")} A. Realized P&L: ${pnlSign}${closed.realizedPnl.toLocaleString("en-IN")} A.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to close hedge position.") };
  }
}

export async function requestLeverageUpgradeAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Authentication required.") };
  }

  const parsed = requestLeverageSchema.safeParse({
    requestedLeverage: formData.get("requestedLeverage"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid leverage request." };
  }

  try {
    const req = await requestLeverageUpgrade({
      userId: u.id,
      requestedLeverage: parsed.data.requestedLeverage,
    });

    revalidatePath("/aeros-market");
    revalidatePath("/gov/market");

    return {
      ok: true,
      message: `Leverage upgrade request (${req.currentLeverage}x → ${req.requestedLeverage}x) submitted for Government review.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to submit leverage upgrade request.") };
  }
}

export async function reviewLeverageRequestAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = reviewLeverageRequestSchema.safeParse({
    requestId: formData.get("requestId"),
    decision: formData.get("decision"),
    rejectionReason: formData.get("rejectionReason") || undefined,
    adminNotes: formData.get("adminNotes") || formData.get("reviewNote") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid review input." };
  }

  try {
    const updated = await reviewLeverageRequest({
      govId: g.id,
      govUsername: g.username,
      requestId: parsed.data.requestId,
      decision: parsed.data.decision,
      rejectionReason: parsed.data.rejectionReason,
      adminNotes: parsed.data.adminNotes,
    });

    revalidatePath("/gov/market");
    revalidatePath("/aeros-market");

    return {
      ok: true,
      message: `Leverage request ${updated.status.toLowerCase()} (${updated.requestedLeverage}x).`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to review leverage request.") };
  }
}

export async function updateMarketIntervalAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = marketIntervalConfigSchema.safeParse({
    marketUpdateIntervalMinutes: formData.get("marketUpdateIntervalMinutes"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid market interval." };
  }

  try {
    const interval = parsed.data.marketUpdateIntervalMinutes === 5 ? 5 : 1;
    await updateMarketIntervalSetting({
      govId: g.id,
      govUsername: g.username,
      intervalMinutes: interval,
    });

    revalidatePath("/gov/market");
    revalidatePath("/gov/control-room");
    revalidatePath("/aeros-market");

    return {
      ok: true,
      message: `Market update interval set to ${interval} minute(s). 5m, 15m, and 1h candles will aggregate deterministically on interval boundaries.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to update market interval.") };
  }
}

// ---------------------------------------------------------------------------
// 2. CITIZEN JOBS & EMPLOYMENT ACTIONS
// ---------------------------------------------------------------------------

export async function createJobAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getCurrentActor();
  if (!actor) {
    return { ok: false, error: "You must be signed in to post a job." };
  }

  const parsed = createJobSchema.safeParse({
    title: formData.get("title"),
    category: formData.get("category"),
    description: formData.get("description"),
    requirements: formData.get("requirements"),
    compensationAeros: formData.get("compensationAeros") ?? formData.get("payAmountAeros"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid job details." };
  }

  try {
    if (actor.type === "GOVERNMENT") {
      const job = await createJobPosting({
        employerType: "GOVERNMENT",
        actorId: actor.government.id,
        actorLabel: actor.government.username,
        title: parsed.data.title,
        category: parsed.data.category,
        description: parsed.data.description,
        requirements: parsed.data.requirements,
        compensationAeros: parsed.data.compensationAeros,
      });

      revalidatePath("/market");
      revalidatePath("/gov/control-room");
      return {
        ok: true,
        message: `Government job ${job.jobNumber} ("${job.title}") posted for Citizens at ${job.compensationAeros.toLocaleString("en-IN")} A.`,
      };
    } else {
      const ctx = await getActingContext();
      const companyId =
        String(formData.get("companyId") ?? "") ||
        ctx?.company?.id ||
        ctx?.availableCompanies?.[0]?.id;

      if (!companyId) {
        return {
          ok: false,
          error: "Only the Government or an approved Registered Company can post jobs for Citizens.",
        };
      }

      const job = await createJobPosting({
        employerType: "COMPANY",
        employerCompanyId: companyId,
        actorId: actor.user.id,
        actorLabel: actor.user.username,
        title: parsed.data.title,
        category: parsed.data.category,
        description: parsed.data.description,
        requirements: parsed.data.requirements,
        compensationAeros: parsed.data.compensationAeros,
      });

      revalidatePath("/market");
      revalidatePath("/my-company");
      return {
        ok: true,
        message: `Company job ${job.jobNumber} ("${job.title}") posted for Citizens at ${job.compensationAeros.toLocaleString("en-IN")} A.`,
      };
    }
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to post job.") };
  }
}

export async function applyForJobAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Sign in as a Citizen to apply for a job.") };
  }

  const parsed = applyForJobSchema.safeParse({
    jobId: formData.get("jobId"),
    coverNote: formData.get("coverNote"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid application." };
  }

  try {
    await applyForJob({
      jobId: parsed.data.jobId,
      userId: u.id,
      coverNote: parsed.data.coverNote,
    });

    revalidatePath("/market");
    revalidatePath("/my-company");

    return {
      ok: true,
      message: "Job application submitted! Track status under My Activity.",
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to apply for job.") };
  }
}

export async function reviewJobApplicationAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getCurrentActor();
  if (!actor) {
    return { ok: false, error: "Authentication required." };
  }

  const parsed = reviewJobApplicationSchema.safeParse({
    applicationId: formData.get("applicationId"),
    decision: formData.get("decision"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid review input." };
  }

  try {
    const companyId = String(formData.get("companyId") ?? "");
    const updated = await reviewJobApplication({
      applicationId: parsed.data.applicationId,
      decision: parsed.data.decision,
      actorType: actor.type === "GOVERNMENT" ? "GOVERNMENT" : "COMPANY",
      actorCompanyId: companyId || null,
      actorId: actor.type === "GOVERNMENT" ? actor.government.id : actor.user.id,
      actorLabel: actor.type === "GOVERNMENT" ? actor.government.username : actor.user.username,
    });

    revalidatePath("/market");
    revalidatePath("/my-company");
    revalidatePath("/gov/control-room");

    return {
      ok: true,
      message: `Application updated to ${updated.status}.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to review job application.") };
  }
}

export async function completeAndPayJobAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await getCurrentActor();
  if (!actor) {
    return { ok: false, error: "Authentication required." };
  }

  const parsed = completeJobSchema.safeParse({
    jobId: formData.get("jobId"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid completion parameters." };
  }

  try {
    const companyId = String(formData.get("companyId") ?? "");
    const res = await completeAndPayJob({
      jobId: parsed.data.jobId,
      actorType: actor.type === "GOVERNMENT" ? "GOVERNMENT" : "COMPANY",
      actorCompanyId: companyId || null,
      actorId: actor.type === "GOVERNMENT" ? actor.government.id : actor.user.id,
      actorLabel: actor.type === "GOVERNMENT" ? actor.government.username : actor.user.username,
    });

    revalidatePath("/market");
    revalidatePath("/my-company");
    revalidatePath("/dashboard");
    revalidatePath("/transactions");
    revalidatePath("/gov/control-room");

    return {
      ok: true,
      message: `Job ${res.job.jobNumber} completed and paid (${res.job.compensationAeros.toLocaleString("en-IN")} A, Tx: ${res.txRef}).`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to complete and pay job.") };
  }
}

// ---------------------------------------------------------------------------
// 3. COMPANY-TO-COMPANY PARTNERSHIPS & SETTLEMENTS
// ---------------------------------------------------------------------------

export async function proposePartnershipAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Authentication required.") };
  }

  const parsed = proposePartnershipSchema.safeParse({
    initiatorCompanyId: formData.get("initiatorCompanyId"),
    partnerCompanyUsername: formData.get("partnerCompanyUsername"),
    title: formData.get("title"),
    termsDescription: formData.get("termsDescription"),
    initiatorShareBp: formData.get("initiatorShareBp") || "5000",
    partnerShareBp: formData.get("partnerShareBp") || "5000",
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid partnership proposal." };
  }

  try {
    const p = await proposeCompanyPartnership({
      actorUserId: u.id,
      initiatorCompanyId: parsed.data.initiatorCompanyId,
      partnerCompanyUsername: parsed.data.partnerCompanyUsername,
      title: parsed.data.title,
      termsDescription: parsed.data.termsDescription,
      initiatorShareBp: parsed.data.initiatorShareBp,
      partnerShareBp: parsed.data.partnerShareBp,
    });

    revalidatePath("/my-company");
    revalidatePath("/companies");
    revalidatePath("/gov/companies");

    return {
      ok: true,
      message: `Partnership proposal ${p.partnershipNumber} ("${p.title}") sent to @${parsed.data.partnerCompanyUsername}.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to propose partnership.") };
  }
}

export async function respondToPartnershipAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Authentication required.") };
  }

  const parsed = respondPartnershipSchema.safeParse({
    partnershipId: formData.get("partnershipId"),
    decision: formData.get("decision"),
    rejectionReason: formData.get("rejectionReason") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid response." };
  }

  try {
    const updated = await respondToCompanyPartnership({
      actorUserId: u.id,
      partnershipId: parsed.data.partnershipId,
      decision: parsed.data.decision,
      rejectionReason: parsed.data.rejectionReason,
    });

    revalidatePath("/my-company");
    revalidatePath("/companies");
    revalidatePath("/gov/companies");

    return {
      ok: true,
      message:
        updated.status === "ACCEPTED_BY_PARTNER"
          ? `Partnership ${updated.partnershipNumber} accepted! Awaiting Government regulatory approval.`
          : `Partnership ${updated.partnershipNumber} updated to ${updated.status}.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to respond to partnership.") };
  }
}

export async function reviewPartnershipByGovAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = reviewGovernmentPartnershipSchema.safeParse({
    partnershipId: formData.get("partnershipId"),
    decision: formData.get("decision"),
    govTaxRateBp: formData.get("govTaxRateBp") || "500",
    rejectionReason: formData.get("rejectionReason") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid Government review." };
  }

  try {
    const updated = await reviewPartnershipByGovernment({
      govId: g.id,
      govUsername: g.username,
      partnershipId: parsed.data.partnershipId,
      decision: parsed.data.decision,
      govTaxRateBp: parsed.data.govTaxRateBp,
      rejectionReason: parsed.data.rejectionReason,
    });

    revalidatePath("/gov/companies");
    revalidatePath("/my-company");
    revalidatePath("/companies");

    return {
      ok: true,
      message: `Partnership ${updated.partnershipNumber} ${updated.status === "APPROVED_BY_GOVERNMENT" ? "approved and activated" : "rejected"}.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to review partnership.") };
  }
}

export async function executePartnershipSettlementAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Authentication required.") };
  }

  const parsed = settlePartnershipSchema.safeParse({
    partnershipId: formData.get("partnershipId"),
    grossAmount: formData.get("grossAmount"),
    referenceNote: formData.get("referenceNote"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid settlement input." };
  }

  try {
    const settlement = await executePartnershipSettlement({
      actorUserId: u.id,
      partnershipId: parsed.data.partnershipId,
      grossAmount: parsed.data.grossAmount,
      referenceNote: parsed.data.referenceNote,
    });

    revalidatePath("/my-company");
    revalidatePath("/companies");
    revalidatePath("/transactions");
    revalidatePath("/gov/companies");

    return {
      ok: true,
      message: `Partnership settlement ${settlement.settlementNumber} completed! Initiator retained: ${settlement.initiatorPayout.toLocaleString("en-IN")} A, Partner transferred: ${settlement.partnerPayout.toLocaleString("en-IN")} A, Tax: ${settlement.govTaxDeducted.toLocaleString("en-IN")} A (Tx: ${settlement.partnerTxRef}).`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to execute partnership settlement.") };
  }
}

// ---------------------------------------------------------------------------
// 4. AEROS MEDIA (TEXT-ONLY SOCIAL FEED, MENTIONS, LIKES, COMMENTS, SHARES)
// ---------------------------------------------------------------------------

export async function createMediaPostAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Sign in as a Citizen to post on Aeros Media.") };
  }

  const parsed = createMediaPostSchema.safeParse({
    content: formData.get("content"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid post content." };
  }

  try {
    const post = await createMediaPost({
      userId: u.id,
      content: parsed.data.content,
    });
    revalidatePath("/media");
    return {
      ok: true,
      message: `Post ${post.postNumber} published on Aeros Media! Visible in the public feed for 7 days.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to publish post.") };
  }
}

export async function toggleMediaLikeAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Sign in as a Citizen to like posts.") };
  }

  const postId = String(formData.get("postId") ?? "");
  if (!postId) return { ok: false, error: "Post ID is required." };

  try {
    const res = await toggleMediaLike({ postId, userId: u.id });
    revalidatePath("/media");
    return {
      ok: true,
      message: res.liked ? "Post liked!" : "Like removed.",
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to update like.") };
  }
}

export async function createMediaCommentAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Sign in to comment on Aeros Media.") };
  }

  const parsed = createMediaCommentSchema.safeParse({
    postId: formData.get("postId"),
    content: formData.get("content"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid comment." };
  }

  try {
    await createMediaComment({
      postId: parsed.data.postId,
      userId: u.id,
      content: parsed.data.content,
    });

    revalidatePath("/media");
    return { ok: true, message: "Comment posted!" };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to post comment.") };
  }
}

export async function recordMediaShareAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let u;
  try {
    u = await requireUser();
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Sign in to share posts.") };
  }

  const postId = String(formData.get("postId") ?? "");
  if (!postId) return { ok: false, error: "Post ID is required." };

  try {
    await shareMediaPost({ postId, userId: u.id });
    revalidatePath("/media");
    return { ok: true, message: "Post shared across Aeros Media!" };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to share post.") };
  }
}

export async function moderateMediaPostAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = moderateMediaPostSchema.safeParse({
    postId: formData.get("postId"),
    action: formData.get("action"),
    reason: formData.get("reason") || formData.get("moderationReason") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid moderation input." };
  }

  try {
    const updated = await moderateMediaPost({
      govId: g.id,
      govUsername: g.username,
      postId: parsed.data.postId,
      action: parsed.data.action,
      reason: parsed.data.reason,
    });

    revalidatePath("/media");
    revalidatePath("/gov/control-room");

    return {
      ok: true,
      message: `Post ${updated.postNumber} moderation status updated to ${updated.moderationStatus}.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to moderate post.") };
  }
}

// ---------------------------------------------------------------------------
// 5. MANUAL "START GITHUB ARCHIVE" JOB RUNNER ACTION
// ---------------------------------------------------------------------------

export async function startManualGithubArchiveJobAction(
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  let g;
  try {
    g = await requireGovernment();
  } catch {
    return { ok: false, error: "Government authorization required." };
  }

  const parsed = startManualArchiveJobSchema.safeParse({
    category: formData.get("category") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid archive job options." };
  }

  try {
    const olderThanHours = Number(formData.get("olderThanHours") || 24);
    const autoClearPrunable = formData.get("autoClearPrunable") !== "false";

    const jobRun = await startOrResumeV5ArchiveJob({
      triggerType: "MANUAL_GOV",
      olderThanHours: Number.isFinite(olderThanHours) && olderThanHours >= 0 ? olderThanHours : 24,
      autoClearPrunable,
      triggeredByGovId: g.id,
      triggeredByUsername: g.username,
    });

    revalidatePath("/gov/archive");
    revalidatePath("/gov/retention");
    revalidatePath("/gov");

    if (jobRun.status === "FAILED") {
      return {
        ok: false,
        error: `GitHub Archive Job ${jobRun.jobNumber} failed: ${jobRun.lastError ?? "Unknown error"}`,
      };
    }

    return {
      ok: true,
      message: `GitHub Archive Job ${jobRun.jobNumber} (${jobRun.status}): ${jobRun.recordsProcessed} uploaded, ${jobRun.recordsVerified} verified via SHA-256 read-back across the 15-repository architecture.`,
    };
  } catch (e) {
    return { ok: false, error: v5ErrMsg(e, "Failed to run GitHub archive job.") };
  }
}

