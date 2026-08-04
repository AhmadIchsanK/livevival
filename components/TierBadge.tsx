// notification_tier badge — a separate axis from update_source (the
// Hot-match OCR-capture-vs-Liquipedia column HotBadge.tsx reads). This one
// is about who gets Telegram/Slack pinged, not where live data comes from.
// Priority gets a bell (🔔) per spec. Hot only shows its own badge here
// when it *disagrees* with update_source — a Liquipedia-synced match
// manually escalated to Hot notifications without also switching to OCR
// capture — otherwise it would just repeat HotBadge's own 🔥 HOT badge.
export function TierBadge({
  tier,
  updateSource,
}: {
  tier?: "normal" | "hot" | "priority" | null;
  updateSource?: "liquipedia" | "local_ocr";
}) {
  if (tier === "priority") {
    return (
      <span
        className="lv-badge bg-amber-400/20 text-amber-300 border border-amber-400/40 shrink-0"
        title="Priority notifications: automatic match-started and match-finished alerts"
      >
        🔔 PRIORITY
      </span>
    );
  }
  if (tier === "hot" && updateSource !== "local_ocr") {
    return (
      <span
        className="lv-badge bg-signal/20 text-signal border border-signal/40 shrink-0"
        title="Hot notification tier: full automatic Telegram/Slack alerts"
      >
        🔥 HOT ALERTS
      </span>
    );
  }
  return null;
}
