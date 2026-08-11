"use client";

import { HeroIcon } from "@/components/HeroIcon";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";

// In-game-style draft board — modeled on MLBB's own draft screen layout
// (one continuous ban strip across the very top, team panels facing each
// other below it) instead of the app's usual card language bolted onto a
// live preview. Still the single editing surface for hero_picks_bans:
// every slot is directly interactive — click a filled slot to correct it
// (auto-swapping with a teammate if the new hero is already theirs),
// click an empty slot to add a fresh pick/ban for that exact player/team.
// No countdown anywhere — nothing in this data model tracks a real
// per-turn deadline, so showing one was always fiction. See the "Hero
// picks & bans" section of the live console page for the callback wiring
// (onSlotClick) and the shared hero-picker modal all three actions open.
//
// Positional fallback + swap (replaces the old post-draft "Assign player"
// dropdown screen): a pick logged by the draft simulation has no
// player_id yet (nobody knows which of a team's 5 exact roster slots each
// hero belongs to until the caster/HUD confirms it) — this board no longer
// waits for that. Each team's Nth still-unassigned pick (by pick_order)
// renders under that team's Nth roster player (in the same fixed role
// order the live console's roster panel already sorts by), so a hero
// appears in place of a player's photo the instant it's picked — same
// positional-match trick the public match page's draft board already uses
// for the same reason (see PublicDraftTeamPanel there). Wrong by position
// only when the actual draft order didn't go role-by-role; the swap
// affordance (onSwapClick) exists for exactly that — pick two players on
// the same team, swap which hero they're actually credited with. Clicking
// the portrait itself still only ever corrects the *hero*, never touches
// who it's assigned to (see correctPickBanHero) — the two actions are
// deliberately separate buttons, not overloaded onto one click.

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
function PlayerPhoto({ url, name }: { url: string | null | undefined; name: string }) {
  const proxied = proxiedImageUrl(url);
  const box = "w-12 h-12 sm:w-14 sm:h-14";
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

// One row per starter, hero art filling the row once locked in — closer to
// an in-game roster panel (name + role + portrait, stacked horizontally,
// mirrored for the right-hand team) than a grid of square avatars.
function PlayerRow({
  player,
  pick,
  heroIconUrl,
  align,
  onClick,
  addable,
  positional,
  onSwapClick,
  swapSelected,
}: {
  player: DraftOverlayPlayer;
  pick: DraftOverlayPickBan | undefined;
  heroIconUrl: string | null | undefined;
  align: "left" | "right";
  onClick?: () => void;
  addable?: boolean;
  // True when `pick` is a positional-fallback match (team's Nth
  // unassigned pick shown under their Nth roster player) rather than a
  // real player_id record — see the file-level comment above.
  positional?: boolean;
  // Present only once there's an actual pick to reassign — clicking
  // toggles this player as the swap source/target. Separate button from
  // the row's own onClick (hero correction) so the two never conflict.
  onSwapClick?: () => void;
  swapSelected?: boolean;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <div className={`w-full flex items-center gap-1 ${align === "right" ? "flex-row-reverse" : ""}`}>
      <Wrapper
        type={onClick ? "button" : undefined}
        onClick={onClick}
        title={onClick ? (pick ? `Correct ${player.ign}'s hero` : `Add a pick for ${player.ign}`) : undefined}
        className={`min-w-0 flex-1 flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors ${
          align === "right" ? "flex-row-reverse" : ""
        } ${onClick ? "cursor-pointer group hover:bg-white/5" : ""}`}
      >
        <div className={`relative shrink-0 ${addable ? "rounded-lg ring-1 ring-dashed ring-white/20 group-hover:ring-signal/60" : ""}`}>
          {pick ? <HeroIcon url={heroIconUrl} name={pick.hero_name} size="md" /> : <PlayerPhoto url={player.photo_url} name={player.ign} />}
          {addable && (
            <span className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-white/10 border border-white/20 text-[10px] leading-4 text-center text-white/50 group-hover:text-signal group-hover:border-signal/60">
              +
            </span>
          )}
        </div>
        <div className={`min-w-0 flex-1 ${align === "right" ? "text-right" : "text-left"}`}>
          <p className="text-sm font-semibold truncate">{pick ? pick.hero_name : "—"}</p>
          <p className="text-[10px] text-white/40 uppercase tracking-wide truncate">
            {player.ign}
            {player.role ? ` · ${player.role}` : ""}
            {positional && <span className="text-white/25 normal-case"> · auto</span>}
          </p>
        </div>
      </Wrapper>
      {onSwapClick && (
        <button
          type="button"
          onClick={onSwapClick}
          title={swapSelected ? "Cancel swap" : `Swap ${player.ign}'s hero with a teammate`}
          className={`shrink-0 w-6 h-6 rounded border text-xs flex items-center justify-center transition-colors ${
            swapSelected ? "border-signal bg-signal/25 text-signal" : "border-white/15 text-white/40 hover:border-signal/50 hover:text-signal"
          }`}
        >
          ⇄
        </button>
      )}
    </div>
  );
}

function BanChip({ ban, heroIconUrl, onClick, addable }: { ban: DraftOverlayPickBan | undefined; heroIconUrl: string | null | undefined; onClick?: () => void; addable?: boolean }) {
  if (!ban) {
    return (
      <button
        type="button"
        disabled={!onClick}
        onClick={onClick}
        title={onClick ? "Add a ban" : undefined}
        className={`w-8 h-8 rounded border border-dashed shrink-0 ${
          addable ? "border-white/25 hover:border-signal/60 hover:bg-signal/10 cursor-pointer" : "border-white/10"
        }`}
      />
    );
  }
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper type={onClick ? "button" : undefined} onClick={onClick} title={onClick ? `Correct ban: ${ban.hero_name}` : ban.hero_name} className="shrink-0">
      <HeroIcon url={heroIconUrl} name={ban.hero_name} size="sm" banned />
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
  onSwapClick,
  swapSelectedPlayerId,
}: {
  leftTeam: DraftOverlayTeam;
  rightTeam: DraftOverlayTeam;
  leftPlayers: DraftOverlayPlayer[];
  rightPlayers: DraftOverlayPlayer[];
  pickBans: DraftOverlayPickBan[];
  heroIconFor: (heroName: string) => string | null | undefined;
  stageLabel: string;
  phaseLabel: string;
  // Which side currently has the turn — highlights that whole side's
  // panel, not one specific player, since a ban never has a player_id and
  // a sim pick doesn't get one until it's positionally matched below —
  // there's no reliable "which exact player" signal available mid-step.
  turnSide: "left" | "right" | null;
  turnLabel: string | null;
  stepProgress: string | null;
  interactive: boolean;
  // Single dispatch point for every write the board can trigger — see
  // DraftOverlaySlotAction. The page owns opening the shared hero-picker
  // modal and the actual insert/update/swap logic; this component only
  // ever reports "here's what was clicked."
  onSlotClick: (action: DraftOverlaySlotAction) => void;
  // Optional — omit to hide the swap button entirely (e.g. while a draft
  // simulation is actively running and this board is read-only). Passed
  // the clicked player; the page owns tracking which one's selected as the
  // swap source and committing the actual swap once a second is clicked.
  onSwapClick?: (player: DraftOverlayPlayer, pick: DraftOverlayPickBan) => void;
  swapSelectedPlayerId?: string | null;
}) {
  // Real assignment first; falls back to this team's Nth still-unassigned
  // pick (by pick_order) for the Nth player in the given (role-ordered)
  // list — see the file-level comment for why. Computed once per team per
  // render, consumed in list order as renderPlayers walks each row.
  function unassignedPicksFor(teamId: string | undefined) {
    if (!teamId) return [];
    return pickBans
      .filter((pb) => pb.type === "pick" && pb.team_id === teamId && !pb.player_id)
      .sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
  }
  function pickFor(playerId: string) {
    return pickBans.find((pb) => pb.type === "pick" && pb.player_id === playerId);
  }
  function bansFor(teamId: string | undefined) {
    if (!teamId) return [];
    return pickBans.filter((pb) => pb.type === "ban" && pb.team_id === teamId).sort((a, b) => (a.pick_order ?? 0) - (b.pick_order ?? 0));
  }
  const leftBans = bansFor(leftTeam?.id);
  const rightBans = bansFor(rightTeam?.id);

  function renderPlayers(playersList: DraftOverlayPlayer[], team: DraftOverlayTeam, align: "left" | "right") {
    const fallbackQueue = unassignedPicksFor(team?.id);
    let fallbackIdx = 0;
    return playersList.map((p) => {
      const realPick = pickFor(p.id);
      let pick = realPick;
      let positional = false;
      if (!pick && fallbackIdx < fallbackQueue.length) {
        pick = fallbackQueue[fallbackIdx];
        fallbackIdx++;
        positional = true;
      }
      const onClick = !interactive
        ? undefined
        : pick
        ? () => onSlotClick({ mode: "correct", pb: pick!, label: `${p.ign} — ${pick!.hero_name}` })
        : team
        ? () => onSlotClick({ mode: "add-pick", teamId: team.id, playerId: p.id, label: `${p.ign}${p.role ? ` (${p.role})` : ""}` })
        : undefined;
      return (
        <PlayerRow
          key={p.id}
          player={p}
          pick={pick}
          heroIconUrl={pick ? heroIconFor(pick.hero_name) : null}
          align={align}
          onClick={onClick}
          addable={!pick && !!onClick}
          positional={positional}
          onSwapClick={onSwapClick && pick ? () => onSwapClick(p, pick!) : undefined}
          swapSelected={swapSelectedPlayerId === p.id}
        />
      );
    });
  }

  function renderBanStrip(bans: DraftOverlayPickBan[], team: DraftOverlayTeam) {
    return Array.from({ length: 5 }).map((_, i) => {
      const ban = bans[i];
      const onClick = !interactive
        ? undefined
        : ban
        ? () => onSlotClick({ mode: "correct", pb: ban, label: `${team?.name ?? "Team"} ban — ${ban.hero_name}` })
        : team
        ? () => onSlotClick({ mode: "add-ban", teamId: team.id, label: `${team.name} — ban` })
        : undefined;
      return <BanChip key={i} ban={ban} heroIconUrl={ban ? heroIconFor(ban.hero_name) : null} onClick={onClick} addable={!ban && !!onClick} />;
    });
  }

  return (
    <div className="rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent overflow-hidden">
      {/* Continuous ban strip across the very top, both sides meeting in
          the middle — deliberately modeled on the real in-game draft
          screen, since bans-as-one-shared-row is instantly recognizable
          to anyone who's watched an MLBB draft. */}
      <div className="flex items-center justify-center gap-4 sm:gap-8 px-3 sm:px-6 py-2.5 bg-black/20 border-b border-white/10">
        <div className="flex items-center gap-1">{renderBanStrip(leftBans, leftTeam)}</div>
        <span className="text-[10px] uppercase tracking-widest text-white/30 shrink-0">Bans</span>
        <div className="flex items-center gap-1">{renderBanStrip(rightBans, rightTeam)}</div>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 sm:px-6 py-2 border-b border-white/5 bg-white/[0.02]">
        <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wide text-white/60 truncate">{leftTeam?.name ?? "Team A"}</span>
        <div className="text-center shrink-0">
          <p className="text-[9px] tracking-widest text-white/30 uppercase">{stageLabel}</p>
          <p className="text-sm font-display font-bold uppercase tracking-wide">{phaseLabel}</p>
          {turnLabel && (
            <p className="text-[10px] text-white/50">
              {turnLabel}
              {stepProgress ? ` · ${stepProgress}` : ""}
            </p>
          )}
        </div>
        <span className="text-[10px] sm:text-xs font-semibold uppercase tracking-wide text-white/60 truncate text-right">{rightTeam?.name ?? "Team B"}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:gap-4 p-2 sm:p-4">
        <div className={`space-y-1 rounded-lg p-1.5 transition-colors ${turnSide === "left" ? "bg-signal/10 ring-1 ring-signal/50" : ""}`}>
          {renderPlayers(leftPlayers, leftTeam, "left")}
        </div>
        <div className={`space-y-1 rounded-lg p-1.5 transition-colors ${turnSide === "right" ? "bg-signal/10 ring-1 ring-signal/50" : ""}`}>
          {renderPlayers(rightPlayers, rightTeam, "right")}
        </div>
      </div>

      {swapSelectedPlayerId ? (
        <p className="text-center text-[10px] text-signal pb-2">Now click ⇄ on a teammate to swap heroes with them, or click their ⇄ again to cancel.</p>
      ) : interactive ? (
        <p className="text-center text-[10px] text-white/30 pb-2">
          Click any slot — filled to correct its hero, empty to add a pick or ban.{onSwapClick && " ⇄ swaps which player a hero is credited to."}
        </p>
      ) : onSwapClick ? (
        <p className="text-center text-[10px] text-white/30 pb-2">⇄ swaps which player a hero is credited to.</p>
      ) : null}
    </div>
  );
}
