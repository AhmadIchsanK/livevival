import { createClient } from "@supabase/supabase-js";

// Shared query logic for the public, unauthenticated read-only endpoints
// under app/api/public/* (JSON + RSS). Deliberately its own small module
// rather than importing anything from app/page.tsx — this mirrors that
// page's Supabase select shape (same table, same foreign-key aliases) but
// runs server-side with its own client instance and its own bounds, so it
// stays fully decoupled from the home page's client-only data flow.

export type PublicMatchStatus = "live" | "scheduled" | "finished";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const UPCOMING_WINDOW_DAYS = 30;
// Bounded fetch caps per underlying query — same rationale as app/page.tsx's
// FINISHED_FETCH_CAP: Supabase caps unbounded selects at 1000 rows, so any
// query needs its own explicit, generous-but-bounded limit.
const QUERY_CAP = 300;

export type PublicMatch = {
  id: string;
  status: string;
  scheduledAt: string | null;
  format: string | null;
  tournament: { name: string; tier: string } | null;
  teamA: { name: string } | null;
  teamB: { name: string } | null;
  score: { teamA: number; teamB: number } | null;
  streamUrl: string | null;
  // Site-relative path — callers prefix with their own base URL since that
  // depends on the incoming request's host.
  path: string;
};

type MatchRow = {
  id: string;
  status: string;
  scheduled_at: string | null;
  format: string | null;
  tournament: { name: string; tier: string } | null;
  team_a: { id: string; name: string } | null;
  team_b: { id: string; name: string } | null;
  stream: { url: string } | null;
};

type GameRow = { match_id: string; winner_team_id: string | null };

const MATCH_SELECT = `id, status, scheduled_at, format,
  tournament:tournaments(name, tier),
  team_a:teams!matches_team_a_id_fkey(id, name),
  team_b:teams!matches_team_b_id_fkey(id, name),
  stream:streams!matches_stream_id_fkey(url)`;

function serverSupabase() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}

export function clampLimit(raw: string | null): number {
  const n = raw === null ? DEFAULT_LIMIT : parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export function parseStatus(raw: string | null): PublicMatchStatus | undefined {
  if (raw === "live" || raw === "scheduled" || raw === "finished") return raw;
  return undefined;
}

async function attachScores(rows: MatchRow[]): Promise<PublicMatch[]> {
  const scoredIds = rows.filter((m) => m.status === "live" || m.status === "finished").map((m) => m.id);
  const scores: Record<string, { teamA: number; teamB: number }> = {};

  if (scoredIds.length > 0) {
    const supabase = serverSupabase();
    const { data: games } = await supabase
      .from("games")
      .select("match_id, winner_team_id")
      .in("match_id", scoredIds);

    const teamAById = new Map(rows.map((m) => [m.id, m.team_a?.id]));
    const teamBById = new Map(rows.map((m) => [m.id, m.team_b?.id]));
    for (const g of (games as GameRow[]) ?? []) {
      if (!g.winner_team_id) continue;
      const entry = scores[g.match_id] ?? { teamA: 0, teamB: 0 };
      if (g.winner_team_id === teamAById.get(g.match_id)) entry.teamA += 1;
      else if (g.winner_team_id === teamBById.get(g.match_id)) entry.teamB += 1;
      scores[g.match_id] = entry;
    }
  }

  return rows.map((m) => ({
    id: m.id,
    status: m.status,
    scheduledAt: m.scheduled_at,
    format: m.format,
    tournament: m.tournament,
    teamA: m.team_a ? { name: m.team_a.name } : null,
    teamB: m.team_b ? { name: m.team_b.name } : null,
    score: scores[m.id] ?? null,
    streamUrl: m.stream?.url ?? null,
    path: `/match/${m.id}`,
  }));
}

// Fetches matches for the public API/RSS feed. With no `status`, mirrors the
// home page's default view: live matches, upcoming matches within the next
// UPCOMING_WINDOW_DAYS days, and recently-finished matches — concatenated
// in that order and truncated to `limit`. With a `status`, returns just
// that bucket.
export async function getPublicMatches(opts: { status?: PublicMatchStatus; limit: number }): Promise<PublicMatch[]> {
  const supabase = serverSupabase();
  const limit = Math.min(opts.limit, MAX_LIMIT);

  if (opts.status === "live") {
    const { data } = await supabase
      .from("matches")
      .select(MATCH_SELECT)
      .eq("status", "live")
      .order("scheduled_at", { ascending: true })
      .limit(limit);
    return attachScores((data as unknown as MatchRow[]) ?? []);
  }

  if (opts.status === "scheduled") {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const { data } = await supabase
      .from("matches")
      .select(MATCH_SELECT)
      .eq("status", "scheduled")
      .gte("scheduled_at", now.toISOString())
      .lte("scheduled_at", windowEnd.toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(limit);
    return attachScores((data as unknown as MatchRow[]) ?? []);
  }

  if (opts.status === "finished") {
    const { data } = await supabase
      .from("matches")
      .select(MATCH_SELECT)
      .eq("status", "finished")
      .order("scheduled_at", { ascending: false })
      .limit(limit);
    return attachScores((data as unknown as MatchRow[]) ?? []);
  }

  // Default: same three-query shape as app/page.tsx's home load.
  const now = new Date();
  const windowEnd = new Date(now.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [{ data: liveData }, { data: upcomingData }, { data: finishedData }] = await Promise.all([
    supabase.from("matches").select(MATCH_SELECT).eq("status", "live").order("scheduled_at", { ascending: true }).limit(QUERY_CAP),
    supabase
      .from("matches")
      .select(MATCH_SELECT)
      .eq("status", "scheduled")
      .gte("scheduled_at", now.toISOString())
      .lte("scheduled_at", windowEnd.toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(QUERY_CAP),
    supabase
      .from("matches")
      .select(MATCH_SELECT)
      .eq("status", "finished")
      .order("scheduled_at", { ascending: false })
      .limit(QUERY_CAP),
  ]);

  const combined = [
    ...((liveData as unknown as MatchRow[]) ?? []),
    ...((upcomingData as unknown as MatchRow[]) ?? []),
    ...((finishedData as unknown as MatchRow[]) ?? []),
  ].slice(0, limit);

  return attachScores(combined);
}
