"use client";

import { useEffect, useState } from "react";
import { TeamLogo } from "@/components/TeamLogo";
import { HeroIcon } from "@/components/HeroIcon";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";

// Broadcast-style pick/ban overlay for the admin live console's Draft
// phase — a presentation layer on top of the same hero_picks_bans rows the
// plain "Hero picks & bans" form below already reads/writes. This never
// writes to the DB itself except through the two callbacks
// (onCorrectPick/nothing else) — turn order, sequencing, and the actual
// insert/delete of a pick or ban all stay owned by the draft-simulation
// logic in the page itself.

export type DraftOverlayPlayer = {
  id: string;
  ign: string;
  role: string | null;
  photo_url: string | null;
};
export type DraftOverlayTeam = { id: string; name: string; logo_url: string | null } | null | undefined;
export type DraftOverlayPickBan = {
  id: string;
  team_id: string;
  player_id: string | null;
  hero_name: string;
  type: "pick" | "ban";
  pick_order: number | null;
};

// Same no-image fallback language as HeroIcon (rounded-lg bg-white/5 border
// border-white/10, shrink-0) — just with initials instead of an empty box,
// since a person (unlike a hero icon) reads better with something in it.
function PlayerPhoto({ url, name, size }: { url: string | null | undefined; name: string; size: "md" | "lg" }) {
  const proxied = proxiedImageUrl(url);
  const box = size === "lg" ? "w-16 h-16 sm:w-20 sm:h-20" : "w-12 h-12 sm:w-14 sm:h-14";
  if (!proxied) {
    const initials = name.trim().slice(0, 2).toUpperCase();
    return (
      <div className={`${box} rounded-lg bg-white/5 border border-white/10 shrink-0 flex items-center justify-center text-white/30 font-display font-bold text-sm`}>
        {initials || "?"}
      </div>
    );
  }
  return (
    <div className={`${box} rounded-lg overflow-hidden border border-white/10 shrink-0`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={proxied} alt={name} className="w-full h-full object-cover object-top" />
    </div>
  );
}

function mmss(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function PlayerSlot({
  player,
  team,
  pick,
  heroIconUrl,
  size,
  onClick,
}: {
  player: DraftOverlayPlayer;
  team: DraftOverlayTeam;
  pick: DraftOverlayPickBan | undefined;
  heroIconUrl: string | null | undefined;
  size: "md" | "lg";
  onClick?: () => void;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={onClick ? `Correct ${player.ign}'s pick` : undefined}
      className={`flex flex-col items-center gap-1 w-14 sm:w-[4.5rem] shrink-0 ${onClick ? "cursor-pointer group" : ""}`}
    >
      <div className={`relative ${onClick ? "transition-transform group-hover:scale-105" : ""}`}>
        {pick ? (
          <HeroIcon url={heroIconUrl} name={pick.hero_name} size={size} />
        ) : (
          <PlayerPhoto url={player.photo_url} name={player.ign} size={size} />
        )}
        {team && (
          <div className="absolute -bottom-1.5 -right-1.5 scale-[0.55] origin-bottom-right drop-shadow">
            <TeamLogo url={team.logo_url} size="sm" />
          </div>
        )}
      </div>
      <span className="text-[9px] sm:text-[10px] font-semibold leading-tight truncate w-full text-center">{player.ign}</span>
      {player.role && (
        <span className="text-[8px] text-white/40 uppercase tracking-wide leading-none truncate w-full text-center">
          {player.role}
        </span>
      )}
    </Wrapper>
  );
}

function BanSlot({ ban, heroIconUrl, onClick }: { ban: DraftOverlayPickBan | undefined; heroIconUrl: string | null | undefined; onClick?: () => void }) {
  if (!ban) return <div className="w-6 h-6 rounded border border-dashed border-white/10 shrink-0" />;
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper type={onClick ? "button" : undefined} onClick={onClick} title={onClick ? `Correct ban: ${ban.hero_name}` : ban.hero_name}>
      <HeroIcon url={heroIconUrl} name={ban.hero_name} size="xs" banned />
    </Wrapper>
  );
}

export function DraftOverlay({
  leftTeam,
  rightTeam,
  leftPlayers,
  rightPlayers,
  pickBans,
  heroIconFor,
  stageLabel,
  phaseLabel,
  turnSide,
  turnLabel,
  stepProgress,
  turnKey,
  interactive,
  onCorrectPick,
}: {
  leftTeam: DraftOverlayTeam;
  rightTeam: DraftOverlayTeam;
  leftPlayers: DraftOverlayPlayer[];
  rightPlayers: DraftOverlayPlayer[];
  pickBans: DraftOverlayPickBan[];
  heroIconFor: (heroName: string) => string | null | undefined;
  stageLabel: string;
  phaseLabel: string;
  // Which side currently has the turn — highlights that whole side's row,
  // not one specific player, since a ban never has a player_id and a sim
  // pick doesn't get one until the post-draft assignment step (see the
  // "Player -> hero assignment" section below in the page) — there's no
  // reliable "which exact player" signal available while a step is live.
  turnSide: "left" | "right" | null;
  turnLabel: string | null;
  stepProgress: string | null;
  // Changes whenever the active turn changes — resets the cosmetic
  // countdown. Not tied to any real deadline in the data model; purely a
  // broadcast-style visual per the reference screenshots.
  turnKey: string;
  interactive: boolean;
  onCorrectPick: (pb: DraftOverlayPickBan, label: string) => void;
}) {
  const [countdown, setCountdown] = useState(30);
  useEffect(() => {
    setCountdown(30);
    const iv = setInterval(() => setCountdown((c) => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(iv);
  }, [turnKey]);

  function pickFor(playerId: string) {
    return pickBans.find((pb) => pb.type === "pick" && pb.player_id === playerId);
  }
  function bansFor(teamId: string | undefined) {
    if (!teamId) return [];
    return pickBans.filter((pb) => pb.type === "ban" && pb.team_id === teamId).sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
  }
  const leftBans = bansFor(leftTeam?.id);
  const rightBans = bansFor(rightTeam?.id);

  function renderPlayers(playersList: DraftOverlayPlayer[], team: DraftOverlayTeam) {
    return playersList.map((p) => {
      const pick = pickFor(p.id);
      const clickable = interactive && !!pick;
      return (
        <PlayerSlot
          key={p.id}
          player={p}
          team={team}
          pick={pick}
          heroIconUrl={pick ? heroIconFor(pick.hero_name) : null}
          size="lg"
          onClick={clickable ? () => onCorrectPick(pick!, `${p.ign} — ${pick!.hero_name}`) : undefined}
        />
      );
    });
  }

  return (
    <div className="relative border border-white/10 rounded-xl bg-gradient-to-b from-white/[0.04] to-transparent p-3 sm:p-4 overflow-hidden">
      <div className="flex items-start justify-between gap-2 sm:gap-4">
        <div
          className={`flex-1 flex flex-col gap-2 rounded-lg p-1.5 sm:p-2 transition-colors ${
            turnSide === "left" ? "bg-signal/10 ring-1 ring-signal/50" : ""
          }`}
        >
          <div className="flex justify-around sm:justify-between gap-1 sm:gap-2 flex-wrap">{renderPlayers(leftPlayers, leftTeam)}</div>
          <div className="flex justify-center gap-1">{Array.from({ length: 5 }).map((_, i) => (
            <BanSlot
              key={i}
              ban={leftBans[i]}
              heroIconUrl={leftBans[i] ? heroIconFor(leftBans[i].hero_name) : null}
              onClick={interactive && leftBans[i] ? () => onCorrectPick(leftBans[i], `${leftTeam?.name ?? "Team"} ban — ${leftBans[i].hero_name}`) : undefined}
            />
          ))}</div>
          <div
            className={`h-1 rounded-full transition-opacity ${turnSide === "left" ? "bg-signal opacity-100 shadow-[0_0_10px_2px_rgba(227,30,42,0.6)]" : "opacity-0"}`}
          />
        </div>

        <div className="shrink-0 flex flex-col items-center justify-start pt-2 sm:pt-4 px-2 sm:px-5 gap-1 text-center">
          <span className="text-[9px] sm:text-[10px] tracking-widest text-white/40 uppercase">{stageLabel}</span>
          <span className="text-base sm:text-xl font-display font-bold uppercase tracking-wide">{phaseLabel}</span>
          <span className="text-2xl sm:text-3xl font-mono font-bold tabular-nums text-signal">{mmss(countdown)}</span>
          {turnLabel && (
            <span className="text-[10px] text-white/50">
              {turnLabel}
              {stepProgress ? ` · ${stepProgress}` : ""}
            </span>
          )}
        </div>

        <div
          className={`flex-1 flex flex-col gap-2 rounded-lg p-1.5 sm:p-2 transition-colors ${
            turnSide === "right" ? "bg-signal/10 ring-1 ring-signal/50" : ""
          }`}
        >
          <div className="flex justify-around sm:justify-between gap-1 sm:gap-2 flex-wrap">{renderPlayers(rightPlayers, rightTeam)}</div>
          <div className="flex justify-center gap-1">{Array.from({ length: 5 }).map((_, i) => (
            <BanSlot
              key={i}
              ban={rightBans[i]}
              heroIconUrl={rightBans[i] ? heroIconFor(rightBans[i].hero_name) : null}
              onClick={interactive && rightBans[i] ? () => onCorrectPick(rightBans[i], `${rightTeam?.name ?? "Team"} ban — ${rightBans[i].hero_name}`) : undefined}
            />
          ))}</div>
          <div
            className={`h-1 rounded-full transition-opacity ${turnSide === "right" ? "bg-signal opacity-100 shadow-[0_0_10px_2px_rgba(227,30,42,0.6)]" : "opacity-0"}`}
          />
        </div>
      </div>
      {interactive && (
        <p className="mt-2 text-center text-[10px] text-white/30">Click a locked-in pick or ban to correct which hero it was.</p>
      )}
    </div>
  );
}
