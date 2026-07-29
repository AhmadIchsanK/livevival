import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Livevival — MLBB Live Scores",
  description: "Live scores, stats, and analytics for S-Tier and A-Tier Mobile Legends: Bang Bang tournaments.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
