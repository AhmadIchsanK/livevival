// Kill reconstruction engine (spec §21) — pairs kill observations with death
// observations into ATOMIC KILL events. A confirmed KILL is one real kill:
//   1 killer  +  1 victim  +  0..4 assists
// ---------------------------------------------------------------------------
// The pairing model (spec §4, §21). Kills and deaths are read from independent
// OCR regions on independent ticks, so a kill delta and its matching death
// delta rarely land in the same window. We therefore pair the kill deltas of a
// team with the death deltas of the ENEMY team:
//   - min(killCount, deathCount) pairs become complete KILL events (killer AND
//     victim both known, both from a real observed delta — never fabricated).
//   - any leftover kills (killer known, no victim yet) OR leftover deaths
//     (victim known, no killer yet) are held PENDING — not emitted — and are
//     re-derived next tick from (reading − confirmed) until their counterpart
//     is observed. Confirmed K/D therefore come ONLY from complete kills, so
//     team A kills == team B deaths by construction, and a death OCR can never
//     exceed the enemy's confirmed kills.
// Guardrail (spec §21): never fabricate a killer, victim, or assist. A kill
// with no victim delta stays pending; it is never confirmed with a null victim.
import type { GameId, GameEvent, PlayerId, TeamId, ObservationSource } from "./types.ts";
import { createEvent, killSignature } from "./events.ts";

export type PlayerDelta = {
  playerId: PlayerId;
  teamId: TeamId;
  dKills: number;
  dDeaths: number;
  dAssists: number;
};

export type KillReconstructionInput = {
  gameId: GameId;
  gameTimeSeconds: number | null;
  teamAId: TeamId;
  teamBId: TeamId;
  // Per-player confirmed stat deltas this window (kills/deaths/assists gained).
  playerDeltas: PlayerDelta[];
  source: ObservationSource;
  confidence: number | null;
  evidence?: string[];
};

export type KillReconstruction = {
  // Complete, confirmable KILL events (killer + victim both attributed).
  events: GameEvent[];
  // Unpaired observations held back this window, for admin diagnostics.
  // teamId → count of kills seen with no victim yet / deaths with no killer yet.
  pending: {
    killsAwaitingVictim: Record<string, number>;
    deathsAwaitingKiller: Record<string, number>;
  };
};

// Reconstruct KILL events from a window of confirmed deltas. Emits exactly
// min(killers, victims) complete kills per team-pair; the surplus is reported
// as pending, never emitted with a null participant.
export function reconstructKills(input: KillReconstructionInput): KillReconstruction {
  const events: GameEvent[] = [];
  const killsAwaitingVictim: Record<string, number> = {};
  const deathsAwaitingKiller: Record<string, number> = {};

  for (const killerTeamId of [input.teamAId, input.teamBId]) {
    const victimTeamId = killerTeamId === input.teamAId ? input.teamBId : input.teamAId;

    // Killers: this team's players with a positive kill delta, one slot each.
    const killers = input.playerDeltas
      .filter((d) => d.teamId === killerTeamId && d.dKills > 0)
      .flatMap((d) => Array<PlayerId>(d.dKills).fill(d.playerId));
    // Victims: enemy players with a positive death delta, one slot each.
    const victims = input.playerDeltas
      .filter((d) => d.teamId === victimTeamId && d.dDeaths > 0)
      .flatMap((d) => Array<PlayerId>(d.dDeaths).fill(d.playerId));
    // Assisters: killer-team players with a positive assist delta (0..4 used).
    const assisters = input.playerDeltas
      .filter((d) => d.teamId === killerTeamId && d.dAssists > 0)
      .map((d) => d.playerId);

    const pairs = Math.min(killers.length, victims.length);
    for (let i = 0; i < pairs; i++) {
      const killerPlayerId = killers[i];
      const victimPlayerId = victims[i];
      // Assists only on the first reconstructed kill of the window (0..4), and
      // never the killer themselves — you cannot assist your own kill.
      const assistPlayerIds =
        i === 0 ? assisters.filter((a) => a !== killerPlayerId).slice(0, 4) : [];
      const payload = { killerTeamId, victimTeamId, killerPlayerId, victimPlayerId, assistPlayerIds };
      events.push(
        createEvent({
          gameId: input.gameId,
          type: "KILL",
          gameTimeSeconds: input.gameTimeSeconds,
          payload,
          source: input.source,
          confidence: input.confidence,
          evidence: input.evidence,
          // Signature keyed on the exact participants + index so a re-delivered
          // identical window collapses, while genuinely distinct kills don't.
          signature: `${killSignature(payload)}#${i}`,
        })
      );
    }

    if (killers.length > pairs) killsAwaitingVictim[killerTeamId] = killers.length - pairs;
    if (victims.length > pairs) deathsAwaitingKiller[victimTeamId] = victims.length - pairs;
  }

  return { events, pending: { killsAwaitingVictim, deathsAwaitingKiller } };
}
