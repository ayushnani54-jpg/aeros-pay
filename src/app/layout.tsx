import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME } from "@/lib/constants";
import { PwaRegister } from "@/components/offline/pwa-register";

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description:
    "Aeros Pay is a private, closed-loop virtual economy for a small community — hold and transfer Aeros digitally.",
  // PWA shell: installable, with the last-synchronized dashboard state
  // available offline. See public/manifest.json and public/sw.js.
  //
  // Deliberately NOT setting `icons` here: this app already has its real
  // favicon/app-icon defined via Next's file convention (src/app/icon.svg,
  // src/app/favicon.ico, src/app/apple-icon.tsx) — an explicit `icons` field
  // in metadata takes precedence over those, and public/pwa-icon.svg (the
  // PWA install/home-screen icon referenced from manifest.json) is a
  // separate, additive concern that must never override the site's actual
  // favicon.
  manifest: "/manifest.json",
};

export const viewport = {
  themeColor: "#111111",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
