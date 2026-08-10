"use client";

import { TeamLogo } from "@/components/TeamLogo";
import { HeroIcon } from "@/components/HeroIcon";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";

// Broadcast-style pick/ban board for the admin live console's Draft phase —
// and the SINGLE editing surface for hero_picks_bans, not just a read-only
// presentation layer. Every slot is directly interactive: click a filled
// slot to correct it (auto-swapping with a teammate if the new hero is
// already theirs), click an empty slot to add a fresh pick/ban for that
// exact player/team. This replaces what used to be three separate,
// disconnected editors (a manual Team/Type/Hero/Log form, a drag-and-drop
// swap grid, and a chip list with delete buttons) — see the "Hero picks &
// bans" section of the live console page for the callback wiring
// (onSlotClick) and the shared hero-picker modal all three actions open.

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
// Discriminated union covering every write the board can trigger — passed
// to the page's single onSlotClick handler, which opens the shared hero
// picker modal already targeted at the right action.
export type DraftOverlaySlotAction =
  | { mode: "correct"; pb: DraftOverlayPickBan; label: string }
  | { mode: "add-pick"; teamId: string; playerId: string; label: string }
  | { mode: "add-ban"; teamId: string; label: string };

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

function PlayerSlot({
  player,
  team,
  pick,
  heroIconUrl,
  size,
  onClick,
  addable,
}: {
  player: DraftOverlayPlayer;
  team: DraftOverlayTeam;
  pick: DraftOverlayPickBan | undefined;
  heroIconUrl: string | null | undefined;
  size: "md" | "lg";
  onClick?: () => void;
  // Empty slot, but still clickable — dashed ring + a small "+" badge so it
  // reads as "click to add" instead of looking like an inert placeholder.
  addable?: boolean;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={onClick ? (pick ? `Correct ${player.ign}'s pick` : `Add a pick for ${player.ign}`) : undefined}
      className={`flex flex-col items-center gap-1 w-14 sm:w-[4.5rem] shrink-0 ${onClick ? "cursor-pointer group" : ""}`}
    >
      <div className={`relative ${onClick ? "transition-transform group-hover:scale-105" : ""}`}>
        {pick ? (
          <HeroIcon url={heroIconUrl} name={pick.hero_name} size={size} />
        ) : (
          <div className={addable ? "rounded-lg ring-1 ring-dashed ring-white/20 group-hover:ring-signal/60" : ""}>
            <PlayerPhoto url={player.photo_url} name={player.ign} size={size} />
          </div>
        )}
        {addable && (
          <span className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-white/10 border border-white/20 text-[10px] leading-4 text-center text-white/50 group-hover:text-signal group-hover:border-signal/60">
            +
          </span>
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

function BanSlot({
  ban,
  heroIconUrl,
  onClick,
  addable,
}: {
  ban: DraftOverlayPickBan | undefined;
  heroIconUrl: string | null | undefined;
  onClick?: () => void;
  addable?: boolean;
}) {
  if (!ban) {
    return (
      <button
        type="button"
        disabled={!onClick}
        onClick={onClick}
        title={onClick ? "Add a ban" : undefined}
        className={`w-6 h-6 rounded border border-dashed shrink-0 ${
          addable ? "border-white/25 hover:border-signal/60 hover:bg-signal/10 cursor-pointer" : "border-white/10"
        }`}
      />
    );
  }
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
  interactive,
  onSlotClick,
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
  interactive: boolean;
  // Single dispatch point for every write the board can trigger — see
  // DraftOverlaySlotAction. The page owns opening the shared hero-picker
  // modal and the actual insert/update/swap logic; this component only
  // ever reports "here's what was clicked."
  onSlotClick: (action: DraftOverlaySlotAction) => void;
}) {
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
      const onClick = !interactive
        ? undefined
        : pick
        ? () => onSlotClick({ mode: "correct", pb: pick, label: `${p.ign} — ${pick.hero_name}` })
        : team
        ? () => onSlotClick({ mode: "add-pick", teamId: team.id, playerId: p.id, label: `${p.ign}${p.role ? ` (${p.role})` : ""}` })
        : undefined;
      return (
        <PlayerSlot
          key={p.id}
          player={p}
          team={team}
          pick={pick}
          heroIconUrl={pick ? heroIconFor(pick.hero_name) : null}
          size="lg"
          onClick={onClick}
          addable={!pick && !!onClick}
        />
      );
    });
  }

  function renderBans(bans: DraftOverlayPickBan[], team: DraftOverlayTeam) {
    return Array.from({ length: 5 }).map((_, i) => {
      const ban = bans[i];
      const onClick = !interactive
        ? undefined
        : ban
        ? () => onSlotClick({ mode: "correct", pb: ban, label: `${team?.name ?? "Team"} ban — ${ban.hero_name}` })
        : team
        ? () => onSlotClick({ mode: "add-ban", teamId: team.id, label: `${team.name} — ban` })
        : undefined;
      return (
        <BanSlot
          key={i}
          ban={ban}
          heroIconUrl={ban ? heroIconFor(ban.hero_name) : null}
          onClick={onClick}
          addable={!ban && !!onClick}
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
          <div className="flex justify-center gap-1">{renderBans(leftBans, leftTeam)}</div>
          <div
            className={`h-1 rounded-full transition-opacity ${turnSide === "left" ? "bg-signal opacity-100 shadow-[0_0_10px_2px_rgba(227,30,42,0.6)]" : "opacity-0"}`}
          />
        </div>

        <div className="shrink-0 flex flex-col items-center justify-start pt-2 sm:pt-4 px-2 sm:px-5 gap-1 text-center">
          <span className="text-[9px] sm:text-[10px] tracking-widest text-white/40 uppercase">{stageLabel}</span>
          <span className="text-base sm:text-xl font-display font-bold uppercase tracking-wide">{phaseLabel}</span>
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
          <div className="flex justify-center gap-1">{renderBans(rightBans, rightTeam)}</div>
          <div
            className={`h-1 rounded-full transition-opacity ${turnSide === "right" ? "bg-signal opacity-100 shadow-[0_0_10px_2px_rgba(227,30,42,0.6)]" : "opacity-0"}`}
          />
        </div>
      </div>
      {interactive && (
        <p className="mt-2 text-center text-[10px] text-white/30">
          Click any slot — filled to correct it, empty to add a pick or ban.
        </p>
      )}
    </div>
  );
}
