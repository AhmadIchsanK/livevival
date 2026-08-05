// Unified Normal / Priority / Hot dropdown for matches.
//
// Historically this was two separate toggles added by different PRs:
//   - matches.update_source ('liquipedia' | 'local_ocr') — where live DATA
//     comes from (Liquipedia auto-sync vs fully admin/OCR-controlled).
//   - matches.notification_tier ('normal' | 'hot' | 'priority') — which
//     automatic Telegram/Slack posts a match generates.
// Both are now driven together from one dropdown, under this exact mapping:
export type MatchTier = "normal" | "priority" | "hot";

export type MatchTierSource = {
  update_source: "liquipedia" | "local_ocr";
  notification_tier: "normal" | "hot" | "priority";
};

export const MATCH_TIER_FIELDS: Record<MatchTier, MatchTierSource> = {
  normal: { update_source: "liquipedia", notification_tier: "normal" },
  priority: { update_source: "liquipedia", notification_tier: "priority" },
  hot: { update_source: "local_ocr", notification_tier: "hot" },
};

export function matchTierFields(tier: MatchTier): MatchTierSource {
  return MATCH_TIER_FIELDS[tier];
}

// Existing rows can carry combinations outside the mapping above (e.g.
// local_ocr + 'normal' tier, from before notification_tier existed) — this
// picks the closest of the three options for display WITHOUT rewriting
// anything until the admin actually changes the dropdown. local_ocr always
// reads as Hot, since OCR tracking implies Hot regardless of its stored
// tier; otherwise whatever notification_tier already says.
export function displayMatchTier(m: MatchTierSource): MatchTier {
  if (m.update_source === "local_ocr") return "hot";
  return m.notification_tier;
}

export const MATCH_TIER_LABELS: Record<MatchTier, string> = {
  normal: "📡 Normal",
  priority: "🔔 Priority",
  hot: "🔥 Hot",
};
