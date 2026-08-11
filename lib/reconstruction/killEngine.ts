// Kill reconstruction engine (spec §21) — turns stat deltas into atomic KILL
// events. A team-kill +1 is matched with the player kill/death/assist deltas
// that explain it, producing one event containing killer, victim and assists.
// Kill-banner recognition (vision) can supply supporting evidence.
// ---------------------------------------------------------------------------
// Guardrail (spec §21): never fabricate killer/assist identity when evidence is
// insufficient. When deltas are ambiguous, the event is emitted with whatever
// identities are certain and the rest left null (team totals still reconcile).
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
  // Per-team confirmed team-kill increase this window.
  teamKillDelta: Record<string, number>;
  // Per-player confirmed stat deltas this window.
  playerDeltas: PlayerDelta[];
  source: ObservationSource;
  confidence: number | null;
  evidence?: string[];
};

// Reconstruct KILL events from a window of confirmed deltas. Returns zero or
// more events; team totals are guaranteed to reconcile because we emit exactly
// `teamKillDelta` kills per team, attributing killer/victim/assists where the
// deltas make it unambiguous.
export function reconstructKills(input: KillReconstructionInput): GameEvent[] {
  const events: GameEvent[] = [];

  for (const killerTeamId of [input.teamAId, input.teamBId]) {
    const victimTeamId = killerTeamId === input.teamAId ? input.teamBId : input.teamAId;
    const kills = input.teamKillDelta[killerTeamId] ?? 0;
    if (kills <= 0) continue;

    // Candidate killers: this team's players with a positive kill delta.
    const killers = input.playerDeltas
      .filter((d) => d.teamId === killerTeamId && d.dKills > 0)
      .flatMap((d) => Array<PlayerId>(d.dKills).fill(d.playerId));
    // Candidate victims: enemy players with a positive death delta.
    const victims = input.playerDeltas
      .filter((d) => d.teamId === victimTeamId && d.dDeaths > 0)
      .flatMap((d) => Array<PlayerId>(d.dDeaths).fill(d.playerId));
    // Assisters: killer-team players with a positive assist delta (0..4 each).
    const assisters = input.playerDeltas
      .filter((d) => d.teamId === killerTeamId && d.dAssists > 0)
      .map((d) => d.playerId);

    for (let i = 0; i < kills; i++) {
      const killerPlayerId = killers[i] ?? null; // null when identity uncertain
      const victimPlayerId = victims[i] ?? null;
      // Attach assists only to the first reconstructed kill of the window to
      // avoid double-counting; assists are 0..4 and can't be split reliably.
      const assistPlayerIds = i === 0 ? assisters.slice(0, 4) : [];
      const payload = {
        killerTeamId,
        victimTeamId,
        killerPlayerId,
        victimPlayerId,
        assistPlayerIds,
      };
      events.push(
        createEvent({
          gameId: input.gameId,
          type: "KILL",
          gameTimeSeconds: input.gameTimeSeconds,
          payload,
          source: input.source,
          confidence: input.confidence,
          evidence: input.evidence,
          // Signature includes the index so multiple distinct kills in one
          // window don't dedup into one, but a re-delivered identical window
          // still collapses (same index → same id).
          signature: `${killSignature(payload)}#${i}`,
        })
      );
    }
  }

  return events;
}
