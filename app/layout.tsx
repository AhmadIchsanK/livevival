import type { Metadata } from "next";
import localFont from "next/font/local";
import { Inter } from "next/font/google";
import "./globals.css";
import { PageTransition } from "@/components/PageTransition";

// Display font: the brand's own Inter 18pt cut (ExtraLight/Light only) —
// used for large headings, scores, and the wordmark. Not suited to small
// body text at these weights, so paired with a full-weight Inter below.
const displayFont = localFont({
  src: [
    { path: "../public/fonts/Inter18pt-ExtraLight.ttf", weight: "200", style: "normal" },
    { path: "../public/fonts/Inter18pt-ExtraLightItalic.ttf", weight: "200", style: "italic" },
    { path: "../public/fonts/Inter18pt-Light.ttf", weight: "300", style: "normal" },
    { path: "../public/fonts/Inter18pt-LightItalic.ttf", weight: "300", style: "italic" },
    { path: "../public/fonts/Inter18pt-Italic.ttf", weight: "400", style: "italic" },
  ],
  variable: "--font-display",
  display: "swap",
});

const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Livevival — Esports Live Score by RevivalTV",
  description:
    "Automatic MLBB Tier S & A live scores, drafts, stats, and VODs — sourced from Liquipedia and public livestreams.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${displayFont.variable} ${bodyFont.variable}`}>
      <body>
        <PageTransition>{children}</PageTransition>
      </body>
    </html>
  );
}
