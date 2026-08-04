// Hot = fully admin/OCR-controlled (KDA, items, moment log all available).
// Normal = Liquipedia auto-sync only (score, picks/bans, VOD). Shown so
// fans know which matches will have the deeper coverage. Shared by every
// match list/card on the site (was previously redefined per-file).
export function HotBadge({ updateSource }: { updateSource: "liquipedia" | "local_ocr" }) {
  if (updateSource !== "local_ocr") return null;
  return (
    <span className="lv-badge bg-signal/20 text-signal border border-signal/40 shrink-0" title="Fully admin-tracked: live KDA, items, and moment log">
      🔥 HOT
    </span>
  );
}
