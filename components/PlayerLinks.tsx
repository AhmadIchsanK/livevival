// players.links is a flexible {platform: url} map (jsonb) since the set of
// socials Liquipedia lists varies per player — rendered as small clickable
// abbreviation badges rather than icons, since this codebase has no icon
// library dependency to draw on (see backfill-player-photos.mjs's
// extractLinks for where the platform slugs — instagram/twitter/facebook/
// tiktok/youtube/etc, taken from Liquipedia's own `lp-<platform>` icon
// classes — come from).
const PLATFORM_LABELS: Record<string, string> = {
  instagram: "IG",
  twitter: "X",
  "x-twitter": "X",
  x: "X",
  facebook: "FB",
  tiktok: "TT",
  youtube: "YT",
  twitch: "TWI",
  discord: "DC",
  weibo: "WB",
  douyin: "DY",
  bilibili: "BILI",
  vk: "VK",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform.toLowerCase()] ?? platform.slice(0, 2).toUpperCase();
}

export function PlayerLinks({ links, className = "" }: { links: Record<string, string> | null | undefined; className?: string }) {
  const entries = Object.entries(links ?? {});
  if (entries.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {entries.map(([platform, url]) => (
        <a
          key={platform}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={`${platform} — ${url}`}
          onClick={(e) => e.stopPropagation()}
          className="lv-badge bg-white/10 text-white/60 hover:text-signal hover:bg-signal/10 transition-colors"
        >
          {platformLabel(platform)}
        </a>
      ))}
    </div>
  );
}
