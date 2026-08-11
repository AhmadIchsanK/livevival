import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireCaller } from "@/lib/adminApiAuth";
import { flags } from "@/lib/featureFlags";
import { reconcile } from "@/lib/reconstruction/reconcile";
import { buildStateHealth } from "@/lib/reconstruction/health";
import type { ConfirmedState, PlayerState } from "@/lib/reconstruction/types";
import { asGameId, asTeamId, asPlayerId } from "@/lib/reconstruction/types";

// Admin State Health diagnostics (spec §24) — a per-field control panel so an
// operator can diagnose a conflict without reading source code: confirmed vs
// candidate values, confidence, last update, rejection reasons, reconciliation
// conflicts and stale trackers.
//
// GET /api/admin/state-health/:gameId   (admin bearer token required)
//
// Read-only. Derives a ConfirmedState from the persisted legacy tables and runs
// the same reconcile() the engine uses, so conflicts surface identically to the
// live reconstruction path. When RECONSTRUCTION_PERSISTENCE is enabled it also
// folds in the latest per-field observation metadata from game_observations.
export async function GET(req: NextRequest, { params }: { params: { gameId: string } }) {
  if (!flags.adminStateHealth) {
    return NextResponse.json({ error: "State Health is disabled (ADMIN_STATE_HEALTH=0)" }, { status: 404 });
  }
  const auth = await requireCaller(req, "admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const gameId = params.gameId;

  const { data: game } = await supabase
    .from("games")
    .select("id, match_id, status, state, current_time_seconds, team_a_kills_override, team_b_kills_override")
    .eq("id", gameId)
    .maybeSingle();
  if (!game) return NextResponse.json({ error: "game not found" }, { status: 404 });
  const g = game as any;

  const { data: matchRow } = await supabase.from("matches").select("team_a_id, team_b_id").eq("id", g.match_id).maybeSingle();
  const teamAId = (matchRow as any)?.team_a_id ?? null;
  const teamBId = (matchRow as any)?.team_b_id ?? null;

  const [{ data: stats }, { data: objectives }, { data: nw }] = await Promise.all([
    supabase.from("player_stats").select("player_id, kills, deaths, assists, hero_name, player:players!player_stats_player_id_fkey(team_id)").eq("game_id", gameId),
    supabase.from("objectives").select("team_id, type").eq("game_id", gameId),
    supabase.from("net_worth_snapshots").select("team_a_gold, team_b_gold, minute_mark").eq("game_id", gameId).order("minute_mark", { ascending: false }).limit(1),
  ]);

  // Assemble a ConfirmedState from persisted values so reconcile()/health see
  // the same shape the engine produces.
  const players: Record<string, PlayerState> = {};
  const teamKills: Record<string, number> = {};
  for (const s of (stats as any[]) ?? []) {
    const teamId = s.player?.team_id ?? "";
    players[s.player_id] = {
      playerId: asPlayerId(s.player_id),
      teamId: asTeamId(teamId),
      kills: s.kills ?? 0,
      deaths: s.deaths ?? 0,
      assists: s.assists ?? 0,
      heroName: s.hero_name ?? null,
    };
    teamKills[teamId] = (teamKills[teamId] ?? 0) + (s.kills ?? 0);
  }
  if (teamAId) teamKills[teamAId] = Math.max(teamKills[teamAId] ?? 0, g.team_a_kills_override ?? 0);
  if (teamBId) teamKills[teamBId] = Math.max(teamKills[teamBId] ?? 0, g.team_b_kills_override ?? 0);

  const byTeam: Record<string, { turtle: number; lord: number; tower: number }> = {};
  const turrets: Record<string, { destroyed: number; lanes: Record<string, boolean> }> = {};
  let turtleTotal = 0;
  let lordTotal = 0;
  for (const o of (objectives as { team_id: string; type: string }[]) ?? []) {
    const bt = (byTeam[o.team_id] = byTeam[o.team_id] ?? { turtle: 0, lord: 0, tower: 0 });
    if (o.type === "turtle") { bt.turtle += 1; turtleTotal += 1; }
    else if (o.type === "lord") { bt.lord += 1; lordTotal += 1; }
    else if (o.type === "tower") { bt.tower += 1; turrets[o.team_id] = { destroyed: (turrets[o.team_id]?.destroyed ?? 0) + 1, lanes: {} }; }
  }

  const latestNw = ((nw as any[]) ?? [])[0];
  const netWorth: Record<string, number> = {};
  if (latestNw && teamAId) netWorth[teamAId] = latestNw.team_a_gold;
  if (latestNw && teamBId) netWorth[teamBId] = latestNw.team_b_gold;

  const state: ConfirmedState = {
    gameId: asGameId(gameId),
    status: g.status === "finished" || g.state === "GAME_FINISHED" || g.state === "SERIES_FINISHED" ? "finished" : g.state === "GAME_STARTED" || g.state === "TECHNICAL_PAUSE" ? "in_progress" : "not_started",
    timerSeconds: g.current_time_seconds ?? 0,
    teamKills,
    netWorth,
    players,
    objectives: { byTeam, turtleTotal, lordTotal },
    turrets,
    stateVersion: 0,
    timeline: [],
    lastConfirmedAt: null,
  };

  // Optional: fold in latest per-field observation metadata when the
  // reconstruction tables exist.
  let observations: Parameters<typeof buildStateHealth>[0]["observations"] = [];
  if (flags.reconstructionPersistence) {
    const { data: obs } = await supabase
      .from("game_observations")
      .select("field, status, normalized_value, confidence, captured_at")
      .eq("game_id", gameId)
      .order("captured_at", { ascending: false })
      .limit(200);
    const seen = new Set<string>();
    for (const o of (obs as any[]) ?? []) {
      if (seen.has(o.field)) continue;
      seen.add(o.field);
      observations.push({
        field: o.field,
        status: o.status,
        candidateValue: o.normalized_value,
        confidence: o.confidence,
        lastObservedAt: o.captured_at ? new Date(o.captured_at).getTime() : null,
      });
    }
  }

  const report = reconcile(state);
  const health = buildStateHealth({ state, observations, conflicts: report.conflicts });

  return NextResponse.json({ health, reconciliation: report });
}
