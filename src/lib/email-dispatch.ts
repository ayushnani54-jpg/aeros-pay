import "server-only";

export const WEB3FORMS_ACCESS_KEY = "7e4e8509-dade-44e5-b3b3-62fbc0ad4796";
export const OFFICIAL_PLATFORM_EMAIL = "aerospay.official@gmail.com";
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";

export interface EmailDispatchOptions {
  toEmail: string;
  code: string;
  username?: string | null;
}

/**
 * Dispatches an 8-digit verification code via configured email transports:
 * 1. Resend API (if RESEND_API_KEY is configured in environment).
 * 2. Web3Forms Dispatch (using verified access key 7e4e8509-dade-44e5-b3b3-62fbc0ad4796).
 * 3. Secure Server Console fallback for local development without external credentials.
 *
 * CRITICAL SECURITY INVARIANT:
 * The verification code is NEVER exposed to HTTP response payloads or client DOM.
 */
export async function dispatchVerificationEmail(opts: EmailDispatchOptions): Promise<{
  delivered: boolean;
  channel: "RESEND" | "WEB3FORMS" | "CONSOLE";
}> {
  const { toEmail, code, username } = opts;
  const userGreeting = username ? `@${username}` : toEmail;

  // 1. Direct Resend API transport if key provided
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `Aeros Pay <${process.env.RESEND_FROM_EMAIL || "no-reply@aerospay.com"}>`,
          to: [toEmail],
          subject: `Aeros Pay Verification Code: ${code}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e4e4e7; border-radius: 12px; background: #ffffff;">
              <h2 style="margin-top: 0; color: #09090b;">Aeros Pay Identity Verification</h2>
              <p style="color: #52525b; font-size: 14px;">Hello ${userGreeting},</p>
              <p style="color: #52525b; font-size: 14px;">Your 8-digit security verification code for your Aeros Pay account is:</p>
              <div style="background: #f4f4f5; padding: 16px; border-radius: 8px; text-align: center; font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #09090b; font-family: monospace;">
                ${code}
              </div>
              <p style="color: #71717a; font-size: 12px; margin-top: 20px;">This code expires in 10 minutes. If you did not request this code, please ignore this email.</p>
              <hr style="border: none; border-top: 1px solid #e4e4e7; margin: 20px 0;" />
              <p style="color: #a1a1aa; font-size: 11px;">Aeros Pay Sovereign Virtual Economy • <a href="mailto:${OFFICIAL_PLATFORM_EMAIL}" style="color: #71717a;">${OFFICIAL_PLATFORM_EMAIL}</a></p>
            </div>
          `,
        }),
      });

      if (res.ok) {
        console.log(`[email-dispatch] Code dispatched via Resend to ${toEmail}`);
        return { delivered: true, channel: "RESEND" };
      }
    } catch (err) {
      console.warn("[email-dispatch] Resend dispatch attempt failed, falling back to Web3Forms:", err);
    }
  }

  // 2. Web3Forms Delivery
  try {
    const payload = {
      access_key: WEB3FORMS_ACCESS_KEY,
      subject: `[Aeros Pay Security] 8-Digit Verification Code for ${userGreeting}`,
      from_name: "Aeros Pay Official Verification Service",
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
      return { delivered: true, channel: "WEB3FORMS" };
    } else {
      console.warn(`[email-dispatch] Web3Forms response status ${res.status}:`, data);
    }
  } catch (err) {
    console.warn("[email-dispatch] Web3Forms dispatch failed:", err);
  }

  // 3. Fallback: log to server console for local testing
  console.log(`[AEROS-EMAIL-DISPATCH-FALLBACK] Target: ${toEmail} | Code: ${code} (expires in 10m)`);
  return { delivered: false, channel: "CONSOLE" };
}

