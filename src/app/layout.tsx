import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Genius Scout",
  description: "Find music producers and their Instagram handles",
  manifest: "/manifest.json",
  // Makes "Add to Home Screen" on iOS launch fullscreen with a real icon
  // instead of a Safari bookmark.
  appleWebApp: {
    capable: true,
    title: "Scout",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/icon-180.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Let the app paint under the notch / home indicator; padding is handled via
  // safe-area insets in globals.css.
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <nav className="border-b border-border bg-surface sticky top-0 z-50 pt-[env(safe-area-inset-top)]">
          <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-4 sm:gap-6 overflow-x-auto">
            <Link
              href="/"
              className="text-lg font-bold text-accent tracking-tight whitespace-nowrap"
            >
              Genius Scout
            </Link>
            <Link
              href="/contacts"
              className="text-sm text-foreground/60 hover:text-foreground transition whitespace-nowrap"
            >
              Contacts
            </Link>
            <Link
              href="/history"
              className="text-sm text-foreground/60 hover:text-foreground transition whitespace-nowrap"
            >
              Scans precedents
            </Link>
          </div>
        </nav>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
