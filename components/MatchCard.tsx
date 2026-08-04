import type { ReactNode } from "react";
import { TeamLogo } from "@/components/TeamLogo";
import { HotBadge } from "@/components/HotBadge";
import { formatMatchDate } from "@/lib/formatMatchDate";

type CardTeam = { name: string | null | undefined; logo_url?: string | null } | null | undefined;

// Shared match-card markup — the same grid-cols-[1fr_auto_1fr] centered
// team/score layout used by the home page's Live/Upcoming/Recent results
// sections and the tournament page's match list. One component instead of
// three+ near-identical copies, so /matches (and anywhere else) automatically
// stays visually consistent with the home page instead of drifting into its
// own layout again.
export function MatchCard({
  href,
  status,
  teamA,
  teamB,
  score,
  scheduledAt,
  format,
  tier,
  tournamentName,
  tournamentSlug,
  updateSource,
}: {
  href: string;
  status: string;
  teamA: CardTeam;
  teamB: CardTeam;
  score?: { a: number; b: number };
  scheduledAt?: string | null;
  format?: string | null;
  tier?: string | null;
  // Omit tournamentName (e.g. on the tournament's own page) to skip the
  // tournament line entirely instead of showing a redundant self-link.
  tournamentName?: string | null;
  tournamentSlug?: string | null;
  updateSource?: "liquipedia" | "local_ocr";
}) {
  const scoreLabel = score ? `${score.a}–${score.b}` : null;
  const isFinished = status === "finished";
  const isLive = status === "live";
  const aWon = isFinished && !!score && score.a > score.b;
  const bWon = isFinished && !!score && score.b > score.a;

  return (
    <a
      href={href}
      className={`lv-card lv-clip-corner block px-4 py-3 space-y-2 ${
        isLive ? "border-signal/30 bg-signal/[0.04] hover:border-signal/60" : ""
      }`}
    >
      {isLive && (
        <div className="flex items-center gap-2">
          <p className="lv-badge-live">Live</p>
          <HotBadge updateSource={updateSource ?? "liquipedia"} />
        </div>
      )}

      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex items-center justify-end gap-2 min-w-0">
          <span className={`font-semibold text-sm text-right leading-tight ${aWon ? "text-signal" : ""}`}>
            {teamA?.name ?? "TBD"}
          </span>
          <TeamLogo url={teamA?.logo_url} alt={teamA?.name ?? undefined} size="sm" highlight={aWon} />
        </div>
        {scoreLabel ? (
          <span className="lv-score text-xl shrink-0 bg-white/5 border border-white/10 rounded-md px-3 py-1">
            {scoreLabel}
          </span>
        ) : (
          <span className="lv-score text-sm shrink-0 bg-white/5 border border-white/10 rounded-md px-2 py-1 uppercase tracking-wide">
            vs
          </span>
        )}
        <div className="flex items-center justify-start gap-2 min-w-0">
          <TeamLogo url={teamB?.logo_url} alt={teamB?.name ?? undefined} size="sm" highlight={bWon} />
          <span className={`font-semibold text-sm leading-tight ${bWon ? "text-signal" : ""}`}>
            {teamB?.name ?? "TBD"}
          </span>
        </div>
      </div>

      <MatchCardMeta
        tournamentName={tournamentName}
        tournamentSlug={tournamentSlug}
        tier={tier}
        format={format}
        scheduledAt={scheduledAt}
        showHot={!isLive}
        updateSource={updateSource}
      />
    </a>
  );
}

function MatchCardMeta({
  tournamentName,
  tournamentSlug,
  tier,
  format,
  scheduledAt,
  showHot,
  updateSource,
}: {
  tournamentName?: string | null;
  tournamentSlug?: string | null;
  tier?: string | null;
  format?: string | null;
  scheduledAt?: string | null;
  showHot: boolean;
  updateSource?: "liquipedia" | "local_ocr";
}) {
  const bits: ReactNode[] = [];
  if (tournamentName) {
    bits.push(
      tournamentSlug ? (
        <a
          key="tournament"
          href={`/tournaments/${tournamentSlug}`}
          onClick={(e) => e.stopPropagation()}
          className="hover:text-white/70 underline"
        >
          {tournamentName}
        </a>
      ) : (
        tournamentName
      )
    );
  }
  if (tier) bits.push(`${tier}-Tier`);
  if (format) bits.push(format);
  if (scheduledAt) {
    const label = formatMatchDate(scheduledAt);
    if (label) bits.push(label);
  }

  return (
    <div className="flex flex-col items-center gap-1 text-center">
      {bits.length > 0 && (
        <p className="text-xs text-white/40 truncate max-w-full">
          {bits.map((bit, i) => (
            <span key={i}>
              {i > 0 ? " · " : ""}
              {bit}
            </span>
          ))}
        </p>
      )}
      {showHot && updateSource && <HotBadge updateSource={updateSource} />}
    </div>
  );
}
