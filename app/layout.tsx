import type { Metadata, Viewport } from "next";
import { Inter, Rajdhani, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { PageTransition } from "@/components/PageTransition";
import { ThemeProvider } from "@/components/ThemeProvider";

// Per Livevival_Brand_Guide.pdf ("Typography"): Rajdhani for headings/
// scoreboard, Inter for body/UI, JetBrains Mono for figures that must
// align in fixed-width columns (timers, exact KDA, net-worth diffs).
const displayFont = Rajdhani({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
  display: "swap",
});

const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const monoFont = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-mono",
  display: "swap",
});

const siteUrl = "https://livevival.vercel.app";
const title = "Livevival — Live MLBB Esports Scores | RevivalTV";
const description =
  "Live scores, hero picks/bans, net worth, KDA, objectives, and match analytics for MLBB S-Tier and A-Tier tournaments.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicons/favicon.ico" },
      { url: "/favicons/icon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicons/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicons/icon-48x48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicons/android-chrome-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/favicons/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    type: "website",
    siteName: "Livevival",
    title,
    description,
    url: siteUrl,
    images: [{ url: "/social/og-image-1200x630.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/social/og-image-1200x630.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#E31E2A",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning on <html> is the documented next-themes
    // pattern — the theme class gets set client-side before React
    // hydrates, which otherwise reads as a hydration mismatch even though
    // it's expected and harmless.
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem themes={["dark", "light"]}>
          <PageTransition>{children}</PageTransition>
        </ThemeProvider>
      </body>
    </html>
  );
}
