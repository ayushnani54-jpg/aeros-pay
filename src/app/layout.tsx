import type { Metadata } from "next";
import "./globals.css";
import { APP_NAME } from "@/lib/constants";
import { PwaRegister } from "@/components/offline/pwa-register";
import { ThemeProvider } from "@/components/theme/theme-provider";

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description:
    "Aeros Pay is a private, closed-loop virtual economy for a small community — hold and transfer Aeros digitally.",
  manifest: "/manifest.json",
};

export const viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('aeros-theme');
    var isDark = false;
    if (stored === 'dark') {
      isDark = true;
    } else if (stored === 'light') {
      isDark = false;
    } else {
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    if (isDark) {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.removeAttribute('data-theme');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground transition-colors duration-150">
        <ThemeProvider>
          <PwaRegister />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
