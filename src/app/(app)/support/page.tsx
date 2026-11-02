import { getCurrentUser } from "@/lib/auth";
import { SupportForm } from "@/components/support/support-form";
import { getPublicCommunityContent } from "@/lib/public-content";

export default async function SupportPage() {
  const user = await getCurrentUser();
  const communityContent = await getPublicCommunityContent();
  const supportEmail = communityContent.support_email || "aerospay.official@gmail.com";

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-8 sm:px-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
          Aeros Pay Support & Bug Desk
        </h1>
        <p className="text-sm text-muted">
          Submit technical bug reports, account inquiries, or feature suggestions directly to the platform engineering desk.
        </p>
      </div>

      <SupportForm
        defaultEmail={user?.authEmail || user?.publicContactEmail || ""}
        username={user?.username || ""}
      />

      <div className="card p-5 bg-surface/50 border-border space-y-2">
        <h4 className="text-sm font-semibold text-foreground">Direct Email Dispatch</h4>
        <p className="text-xs text-muted leading-relaxed">
          In addition to this in-app ticket form, you can email our support operations directly at{" "}
          <a href={`mailto:${supportEmail}`} className="font-semibold text-foreground underline">
            {supportEmail}
          </a>
          . All tickets are assigned a permanent cryptographic reference code for tracking.
        </p>
      </div>
    </div>
  );
}
