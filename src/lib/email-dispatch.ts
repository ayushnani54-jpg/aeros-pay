import "server-only";
import nodemailer from "nodemailer";

export const OFFICIAL_PLATFORM_EMAIL = "aerospay.official@gmail.com";

export interface EmailDispatchOptions {
  toEmail: string;
  code: string;
  username?: string | null;
}

export interface EmailDispatchResult {
  delivered: boolean;
  channel: "GMAIL_SMTP" | "RESEND" | "CONSOLE";
  detail?: string;
  devCode?: string;
}

/**
 * Generates the clean, dark-mode-styled HTML email verification template.
 */
function getEmailHtml(userGreeting: string, code: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; border: 1px solid #27272a; border-radius: 12px; background: #09090b; color: #f4f4f5;">
      <div style="margin-bottom: 24px;">
        <span style="font-family: monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: #10b981; background: #064e3b; padding: 4px 8px; border-radius: 4px;">Aeros Pay Identity</span>
      </div>
      <h2 style="margin: 0 0 12px; color: #f4f4f5; font-size: 22px; font-weight: 600;">Citizen Email Verification</h2>
      <p style="color: #a1a1aa; font-size: 14px; margin: 0 0 8px;">Hello <strong style="color: #f4f4f5;">${userGreeting}</strong>,</p>
      <p style="color: #a1a1aa; font-size: 14px; line-height: 1.5; margin: 0 0 24px;">
        Your 8-digit verification code to activate your citizen account in the Aeros Pay sovereign economic network is:
      </p>
      <div style="background: #18181b; padding: 20px; border-radius: 8px; text-align: center; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #f4f4f5; font-family: monospace; border: 1px solid #27272a; margin: 0 0 24px;">
        ${code}
      </div>
      <p style="color: #71717a; font-size: 12px; line-height: 1.5; margin: 0 0 24px;">
        This security code expires in 10 minutes. For your protection, never share this code with anyone.
      </p>
      <hr style="border: none; border-top: 1px solid #27272a; margin: 0 0 20px;" />
      <p style="color: #52525b; font-size: 11px; margin: 0;">
        Aeros Pay Sovereign Virtual Economy • <a href="mailto:${OFFICIAL_PLATFORM_EMAIL}" style="color: #a1a1aa; text-decoration: none;">${OFFICIAL_PLATFORM_EMAIL}</a>
      </p>
    </div>
  `;
}

/**
 * Dispatches an 8-digit verification code via configured transports in priority order:
 * 1. Gmail SMTP (Nodemailer) -> 100% works for ANY email address, no domain setup needed!
 * 2. Resend API -> If domain verified or matching account.
 * 3. Secure Fallback -> Console + devCode in message so users are never locked out.
 */
export async function dispatchVerificationEmail(opts: EmailDispatchOptions): Promise<EmailDispatchResult> {
  const { toEmail, code, username } = opts;
  const userGreeting = username ? `@${username}` : toEmail;
  const htmlContent = getEmailHtml(userGreeting, code);

  // 1. Direct Gmail or Generic SMTP (Google App Password, Brevo, Mailgun, etc.)
  const smtpPass = (process.env.GMAIL_APP_PASSWORD || process.env.SMTP_PASS || "").replace(/\s+/g, "");
  const smtpUser = process.env.GMAIL_USER || process.env.SMTP_USER || OFFICIAL_PLATFORM_EMAIL;
  const smtpHost = process.env.SMTP_HOST;

  if (smtpPass && smtpPass.length > 0) {
    try {
      const transporter = smtpHost
        ? nodemailer.createTransport({
            host: smtpHost,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: {
              user: smtpUser,
              pass: smtpPass,
            },
          })
        : nodemailer.createTransport({
            service: "gmail",
            auth: {
              user: smtpUser,
              pass: smtpPass,
            },
          });

      const info = await transporter.sendMail({
        from: `"Aeros Pay Official" <${smtpUser}>`,
        to: toEmail,
        subject: `Aeros Pay — Verification Code: ${code}`,
        html: htmlContent,
      });

      console.log(`[email-dispatch] Code successfully delivered via SMTP to ${toEmail} (MsgID: ${info.messageId})`);
      return { delivered: true, channel: "GMAIL_SMTP", detail: `Delivered via SMTP (${info.messageId})` };
    } catch (err) {
      console.warn("[email-dispatch] SMTP dispatch failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // 2. Resend API
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
          html: htmlContent,
        }),
      });

      const resData = await res.json().catch(() => null);
      if (res.ok && resData?.id) {
        console.log(`[email-dispatch] Code successfully delivered via Resend to ${toEmail} (ID: ${resData.id})`);
        return { delivered: true, channel: "RESEND", detail: `Delivered via Resend (ID: ${resData.id})` };
      } else {
        console.warn("[email-dispatch] Resend API error:", resData?.message || resData);
      }
    } catch (err) {
      console.warn("[email-dispatch] Resend API fetch failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Fallback: Log to server stdout
  console.log(`[AEROS-EMAIL-DISPATCH-FALLBACK] Target: ${toEmail} | Code: ${code} (expires in 10m)`);
  return {
    delivered: false,
    channel: "CONSOLE",
    detail: "No active email service configured (requires GMAIL_APP_PASSWORD or verified domain in RESEND).",
    devCode: code,
  };
}
