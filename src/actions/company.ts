"use server";

import { requireUser, requireActingContext } from "@/lib/auth";
import {
  applyForCompany,
  CompanyError,
  countWords,
  getCompanyById,
  requireOwnedCompany,
} from "@/lib/companies";
import {
  cancelListing,
  createListing,
  dismissListing,
  makeOffer,
  purchaseListing,
  respondToOffer,
  SaleError,
  undismissListing,
  withdrawOffer,
} from "@/lib/sales";
import {
  acceptLoan,
  applyForLoan,
  cancelLoanApplication,
  LoanError,
  payInstalment,
  runLoanMaintenance,
} from "@/lib/loans";
import {
  createCompanySchema,
  createInvoiceSchema,
  invoiceIdSchema,
  ipComplaintSchema,
} from "@/lib/validators";
import { cancelInvoice, createInvoice, InvoiceError } from "@/lib/invoices";
import { submitComplaint, IpError } from "@/lib/ip";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { setCompanyContext } from "@/lib/session";
import type { ActionResult } from "./auth";

function errMsg(e: unknown, fallback: string): string {
  if (
    e instanceof CompanyError ||
    e instanceof SaleError ||
    e instanceof LoanError ||
    e instanceof InvoiceError ||
    e instanceof IpError
  ) {
    return e.message;
  }
  return fallback;
}

function refreshCompanyViews() {
  revalidatePath("/my-company");
  revalidatePath("/companies");
  revalidatePath("/dashboard");
  revalidatePath("/gov/companies");
}

// ---------------------------------------------------------------------------
// Company application
// ---------------------------------------------------------------------------

export async function createCompanyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = createCompanySchema.safeParse({
    name: formData.get("name"),
    username: formData.get("username"),
    category: formData.get("category"),
    reason: formData.get("reason"),
    description: formData.get("description"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await applyForCompany({
      ownerUserId: user.id,
      name: parsed.data.name,
      username: parsed.data.username,
      category: parsed.data.category,
      reason: parsed.data.reason,
      description: parsed.data.description,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not submit your company application.") };
  }

  refreshCompanyViews();
  return { ok: true, data: undefined };
}

/** Server-side word count, used by the live counter on the form. */
export async function countDescriptionWordsAction(text: string): Promise<number> {
  return countWords(text);
}

// ---------------------------------------------------------------------------
// Invoices (company context)
// ---------------------------------------------------------------------------

export async function createInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company to issue an invoice." };
  }

  const parsed = createInvoiceSchema.safeParse({
    buyerUsername: formData.get("buyerUsername"),
    itemName: formData.get("itemName"),
    description: formData.get("description") ?? "",
    quantity: formData.get("quantity"),
    unitPrice: formData.get("unitPrice"),
    note: formData.get("note") ?? "",
    dueDate: formData.get("dueDate") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await createInvoice({
      company,
      buyerUsername: parsed.data.buyerUsername,
      itemName: parsed.data.itemName,
      description: parsed.data.description || null,
      quantity: parsed.data.quantity,
      unitPrice: parsed.data.unitPrice,
      note: parsed.data.note || null,
      dueAt: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not create the invoice.") };
  }

  revalidatePath("/my-company/invoices");
  revalidatePath("/invoices");
  return { ok: true, data: undefined };
}

export async function cancelInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company first." };
  }

  const parsed = invoiceIdSchema.safeParse({ invoiceId: formData.get("invoiceId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await cancelInvoice({
      invoiceId: parsed.data.invoiceId,
      companyId: company.id,
      actorLabel: company.name,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not cancel the invoice.") };
  }

  revalidatePath("/my-company/invoices");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Company sale — listing
// ---------------------------------------------------------------------------

const listForSaleSchema = z.object({
  companyId: z.string().uuid(),
  reason: z.string().trim().min(1, "Please give a reason for selling.").max(1000),
});

export async function listCompanyForSaleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = listForSaleSchema.safeParse({
    companyId: formData.get("companyId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await getCompanyById(parsed.data.companyId);
    if (!company || company.ownerUserId !== user.id) {
      return { ok: false, error: "Company not found." };
    }
    await createListing({
      company,
      sellerUserId: user.id,
      reason: parsed.data.reason,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not list this company for sale.") };
  }

  revalidatePath("/my-company/sale");
  revalidatePath("/companies");
  revalidatePath("/marketplace");
  return { ok: true, data: undefined };
}

const listingIdSchema = z.object({ listingId: z.string().uuid() });

export async function cancelListingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = listingIdSchema.safeParse({ listingId: formData.get("listingId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await cancelListing({
      listingId: parsed.data.listingId,
      actorUserId: user.id,
      reason: (formData.get("reason") as string) || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not cancel the listing.") };
  }

  revalidatePath("/my-company/sale");
  revalidatePath("/marketplace");
  return { ok: true, data: undefined };
}

/**
 * Hides a listing for the current viewer only. The listing stays OPEN and
 * fully visible to every other user.
 */
export async function dismissListingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = listingIdSchema.safeParse({ listingId: formData.get("listingId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  await dismissListing(parsed.data.listingId, user.id);
  revalidatePath("/marketplace");
  return { ok: true, data: undefined };
}

export async function undismissListingAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = listingIdSchema.safeParse({ listingId: formData.get("listingId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  await undismissListing(parsed.data.listingId, user.id);
  revalidatePath("/marketplace");
  return { ok: true, data: undefined };
}

export async function purchaseCompanyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = listingIdSchema.safeParse({ listingId: formData.get("listingId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await purchaseListing({ listingId: parsed.data.listingId, buyerUserId: user.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "The purchase could not be completed.") };
  }

  // The buyer now owns a company; clear any stale context.
  await setCompanyContext(null);
  refreshCompanyViews();
  revalidatePath("/marketplace");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Company sale — offers
// ---------------------------------------------------------------------------

const makeOfferSchema = z.object({
  companyId: z.string().uuid(),
  amount: z.coerce.number().int().positive("Offer must be greater than zero."),
  message: z.string().trim().max(500).optional().or(z.literal("")),
});

export async function makeOfferAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = makeOfferSchema.safeParse({
    companyId: formData.get("companyId"),
    amount: formData.get("amount"),
    message: formData.get("message") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    await makeOffer({
      companyId: parsed.data.companyId,
      offerorUserId: user.id,
      amount: parsed.data.amount,
      message: parsed.data.message || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not send the offer.") };
  }

  revalidatePath("/marketplace");
  revalidatePath("/companies");
  return { ok: true, data: undefined };
}

const respondOfferSchema = z.object({
  offerId: z.string().uuid(),
  accept: z.enum(["yes", "no"]),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

export async function respondToOfferAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = respondOfferSchema.safeParse({
    offerId: formData.get("offerId"),
    accept: formData.get("accept"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await respondToOffer({
      offerId: parsed.data.offerId,
      ownerUserId: user.id,
      accept: parsed.data.accept === "yes",
      note: parsed.data.note || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not respond to the offer.") };
  }

  if (parsed.data.accept === "yes") await setCompanyContext(null);
  refreshCompanyViews();
  revalidatePath("/my-company/sale");
  return { ok: true, data: undefined };
}

export async function withdrawOfferAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const offerId = String(formData.get("offerId") ?? "");
  if (!offerId) return { ok: false, error: "Invalid request." };

  try {
    await withdrawOffer({ offerId, offerorUserId: user.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not withdraw the offer.") };
  }

  revalidatePath("/marketplace");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Loans (company side)
// ---------------------------------------------------------------------------

const applyLoanSchema = z.object({
  companyId: z.string().uuid(),
  amount: z.coerce.number().int().positive("Amount must be greater than zero."),
  purpose: z.string().trim().min(1, "Please describe what the loan is for.").max(1000),
});

export async function applyForLoanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = applyLoanSchema.safeParse({
    companyId: formData.get("companyId"),
    amount: formData.get("amount"),
    purpose: formData.get("purpose"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(user.id, parsed.data.companyId);
    await applyForLoan({
      company,
      appliedByUserId: user.id,
      amount: parsed.data.amount,
      purpose: parsed.data.purpose,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not submit the loan application.") };
  }

  revalidatePath("/my-company/loans");
  revalidatePath("/gov/loans");
  return { ok: true, data: undefined };
}

const loanIdSchema = z.object({ loanId: z.string().uuid() });

export async function acceptLoanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = loanIdSchema.safeParse({ loanId: formData.get("loanId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await acceptLoan({ loanId: parsed.data.loanId, acceptingUserId: user.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not accept the loan.") };
  }

  revalidatePath("/my-company/loans");
  revalidatePath("/my-company");
  revalidatePath("/gov/loans");
  return { ok: true, data: undefined };
}

export async function cancelLoanAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const parsed = loanIdSchema.safeParse({ loanId: formData.get("loanId") });
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  try {
    await cancelLoanApplication({ loanId: parsed.data.loanId, actorUserId: user.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not cancel the application.") };
  }

  revalidatePath("/my-company/loans");
  revalidatePath("/gov/loans");
  return { ok: true, data: undefined };
}

export async function payInstalmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }

  const instalmentId = String(formData.get("instalmentId") ?? "");
  if (!instalmentId) return { ok: false, error: "Invalid request." };

  try {
    await payInstalment({ instalmentId, payingUserId: user.id });
  } catch (e) {
    return { ok: false, error: errMsg(e, "The repayment could not be completed.") };
  }

  await runLoanMaintenance();
  revalidatePath("/my-company/loans");
  revalidatePath("/my-company");
  revalidatePath("/gov/loans");
  return { ok: true, data: undefined };
}

// ---------------------------------------------------------------------------
// IP complaints (company side)
// ---------------------------------------------------------------------------

export async function submitIpComplaintAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  let ctx;
  try {
    ctx = await requireActingContext();
  } catch {
    return { ok: false, error: "You must be logged in." };
  }
  if (!ctx.company) {
    return { ok: false, error: "Switch to your company to file a complaint." };
  }

  const parsed = ipComplaintSchema.safeParse({
    accusedCompanyUsername: formData.get("accusedCompanyUsername"),
    reason: formData.get("reason"),
    description: formData.get("description"),
    evidence: formData.get("evidence"),
    referenceMaterial: formData.get("referenceMaterial") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    const company = await requireOwnedCompany(ctx.user.id, ctx.company.id);
    await submitComplaint({
      complainant: company,
      accusedCompanyUsername: parsed.data.accusedCompanyUsername,
      reason: parsed.data.reason,
      description: parsed.data.description,
      evidence: parsed.data.evidence,
      referenceMaterial: parsed.data.referenceMaterial || null,
    });
  } catch (e) {
    return { ok: false, error: errMsg(e, "Could not submit the complaint.") };
  }

  revalidatePath("/my-company/complaints");
  revalidatePath("/gov/ip");
  return { ok: true, data: undefined };
}

export async function clearCompanyContextAction(): Promise<ActionResult> {
  await setCompanyContext(null);
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}
