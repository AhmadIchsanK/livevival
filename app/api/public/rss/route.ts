import { getPublicMatches, type PublicMatch } from "@/lib/publicMatches";

// Public RSS 2.0 feed of live/upcoming/recent matches — hand-built XML
// (no rss-generator dependency needed for one feed this small). Same
// unauthenticated, cached read as /api/public/matches, just XML-shaped.
//
// GET /api/public/rss
const FEED_LIMIT = 50;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function scoreLabel(m: PublicMatch): string {
  if (!m.score) return "vs";
  return `${m.score.teamA}–${m.score.teamB}`;
}

function statusLabel(status: string): string {
  if (status === "live") return "LIVE";
  if (status === "finished") return "Final";
  return "Upcoming";
}

function itemXml(m: PublicMatch, base: string): string {
  const teamA = m.teamA?.name ?? "TBD";
  const teamB = m.teamB?.name ?? "TBD";
  const title = `[${statusLabel(m.status)}] ${teamA} ${scoreLabel(m)} ${teamB}`;
  const link = `${base}${m.path}`;
  const tournament = m.tournament?.name ?? "";
  const descriptionParts = [tournament, m.format ?? "", m.streamUrl ? `Stream: ${m.streamUrl}` : ""].filter(Boolean);
  const description = descriptionParts.join(" · ");
  // Falls back to now for matches without a scheduled_at rather than
  // omitting pubDate — an RSS reader sorting by date needs some value, and
  // this only affects the rare row where scheduling data is missing.
  const pubDate = new Date(m.scheduledAt ?? Date.now()).toUTCString();

  return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(m.id)}</guid>
      <description>${escapeXml(description)}</description>
      <pubDate>${pubDate}</pubDate>
    </item>`;
}

export async function GET(req: Request) {
  const base = new URL(req.url).origin;
  const matches = await getPublicMatches({ limit: FEED_LIMIT });

  const items = matches.map((m) => itemXml(m, base)).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>LiveVival — Live Scores</title>
    <link>${escapeXml(base)}</link>
    <description>Live, upcoming, and recent esports match results.</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
    },
  });
}
