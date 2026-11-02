import "server-only";

export const WEB3FORMS_ACCESS_KEY = "7e4e8509-dade-44e5-b3b3-62fbc0ad4796";
export const OFFICIAL_PLATFORM_EMAIL = "aerospay.official@gmail.com";
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";

export interface EmailDispatchOptions {
  toEmail: string;
  code: string;
  username?: string | null;
}

export interface EmailDispatchResult {
  delivered: boolean;
  channel: "RESEND" | "WEB3FORMS" | "CONSOLE";
  detail?: string;
}

/**
 * Dispatches an 8-digit verification code via configured email transports:
 * 1. Resend API (if RESEND_API_KEY is configured in Vercel environment).
 * 2. Web3Forms Dispatch (if client/Pro plan allows).
 * 3. Secure Console / Smart Fallback when external email provider is not yet configured.
 */
export async function dispatchVerificationEmail(opts: EmailDispatchOptions): Promise<EmailDispatchResult> {
  const { toEmail, code, username } = opts;
  const userGreeting = username ? `@${username}` : toEmail;

  // 1. Direct Resend API transport (Native Vercel standard, 3,000 free emails/mo)
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && resendKey.trim().length > 0) {
    try {
      const fromEmail = process.env.RESEND_FROM_EMAIL || "Aeros Pay <onboarding@resend.dev>";
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [toEmail],
          subject: `Aeros Pay — Verification Code: ${code}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px; border: 1px solid #27272a; border-radius: 12px; background: #09090b; color: #f4f4f5;">
              <h2 style="margin-top: 0; color: #f4f4f5; font-size: 20px;">Aeros Pay Identity Verification</h2>
              <p style="color: #a1a1aa; font-size: 14px;">Hello ${userGreeting},</p>
              <p style="color: #a1a1aa; font-size: 14px;">Your 8-digit security verification code for your Aeros Pay citizen account is:</p>
              <div style="background: #18181b; padding: 18px; border-radius: 8px; text-align: center; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #f4f4f5; font-family: monospace; border: 1px solid #27272a; margin: 20px 0;">
                ${code}
              </div>
              <p style="color: #71717a; font-size: 12px; line-height: 1.5;">This code expires in 10 minutes. If you did not request this verification code, please ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #27272a; margin: 24px 0;" />
              <p style="color: #52525b; font-size: 11px; margin: 0;">Aeros Pay Sovereign Virtual Economy • <a href="mailto:${OFFICIAL_PLATFORM_EMAIL}" style="color: #a1a1aa;">${OFFICIAL_PLATFORM_EMAIL}</a></p>
            </div>
          `,
        }),
      });

      const resData = await res.json().catch(() => null);
      if (res.ok && resData?.id) {
        console.log(`[email-dispatch] Code dispatched via Resend to ${toEmail} (ID: ${resData.id})`);
        return { delivered: true, channel: "RESEND", detail: `Delivered via Resend (ID: ${resData.id})` };
      } else {
        console.warn("[email-dispatch] Resend API returned error:", resData);
      }
    } catch (err) {
      console.warn("[email-dispatch] Resend API fetch failed:", err);
    }
  }

  // 2. Web3Forms Delivery Attempt
  try {
    const payload = {
      access_key: WEB3FORMS_ACCESS_KEY,
      subject: `[Aeros Pay Security] 8-Digit Verification Code for ${userGreeting}`,
      from_name: "Aeros Pay Verification Service",
      email: toEmail,
      replyto: OFFICIAL_PLATFORM_EMAIL,
      message: `Citizen: ${userGreeting}\nDestination Email: ${toEmail}\nVerification Code: ${code}\nExpiration: 10 minutes\nIssued At: ${new Date().toISOString()}`,
    };

    const res = await fetch(WEB3FORMS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      console.log(`[email-dispatch] Code dispatched via Web3Forms for ${toEmail}`);
      return { delivered: true, channel: "WEB3FORMS", detail: "Delivered via Web3Forms" };
    } else {
      console.warn(`[email-dispatch] Web3Forms rejected request: ${data?.message || res.statusText}`);
    }
  } catch (err) {
    console.warn("[email-dispatch] Web3Forms attempt failed:", err);
  }

  // 3. Fallback: Log to server stdout
  console.log(`[AEROS-EMAIL-DISPATCH-FALLBACK] Target: ${toEmail} | Code: ${code} (expires in 10m)`);
  return {
    delivered: false,
    channel: "CONSOLE",
    detail: "No active email provider (RESEND_API_KEY) configured in environment.",
  };
}
