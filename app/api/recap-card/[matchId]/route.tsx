import { ImageResponse } from "next/og";
import { createClient } from "@supabase/supabase-js";

export const runtime = "edge";

// Team logos and hero icons are Liquipedia-hosted and need the site's own
// image proxy (hotlink protection) — fetching them from an edge function
// adds a network hop this route doesn't need to depend on. Everything
// rendered here is either text or the site's own local /logo asset, so the
// card always renders the same regardless of Liquipedia's availability.
const INK = "#0A0A0A";
const SIGNAL = "#E31E2A";

type Ratio = "portrait" | "landscape";
type Mode = "simple" | "advanced";
type CardMatch = {
  format: string | null;
  series_winner_team_id: string | null;
  tournament: { name: string } | null;
  team_a: { id: string; name: string } | null;
  team_b: { id: string; name: string } | null;
};
type CardGame = { winner_team_id: string | null };

function dims(ratio: Ratio) {
  return ratio === "portrait" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function renderCard({
  match,
  games,
  heroPicks,
  mvpLine,
  ratio,
  mode,
  logoUrl,
}: {
  match: CardMatch;
  games: CardGame[];
  heroPicks: { team_id: string; hero_name: string }[];
  mvpLine: string | null;
  ratio: Ratio;
  mode: Mode;
  logoUrl: string;
}) {
  const teamA = match.team_a;
  const teamB = match.team_b;
  const winsFor = (teamId?: string) => games.filter((g) => g.winner_team_id === teamId).length;
  const aWins = winsFor(teamA?.id);
  const bWins = winsFor(teamB?.id);
  const winnerName =
    match.series_winner_team_id === teamA?.id
      ? teamA?.name
      : match.series_winner_team_id === teamB?.id
      ? teamB?.name
      : aWins > bWins
      ? teamA?.name
      : bWins > aWins
      ? teamB?.name
      : null;

  const { width, height } = dims(ratio);
  const scale = width / 1080;
  const teamAPicks = heroPicks.filter((p) => p.team_id === teamA?.id).map((p) => p.hero_name);
  const teamBPicks = heroPicks.filter((p) => p.team_id === teamB?.id).map((p) => p.hero_name);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: `linear-gradient(160deg, ${INK} 0%, #1a0a0a 100%)`,
          color: "#ffffff",
          fontFamily: "sans-serif",
          padding: `${64 * scale}px`,
        }}
      >
        {/* Real width/height needed — Satori doesn't do intrinsic image
            sizing, and logo-dark-bg.png's native ratio is 1248:352. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt="Livevival" width={142 * scale} height={40 * scale} />

        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, justifyContent: "center", gap: 24 * scale }}>
          <span style={{ fontSize: 22 * scale, color: "#ffffff77", textTransform: "uppercase", letterSpacing: 2 }}>
            {match.tournament?.name ?? ""} {match.format ? `· ${match.format}` : ""}
          </span>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
              <span style={{ fontSize: 44 * scale, fontWeight: 700, color: winnerName === teamA?.name ? SIGNAL : "#ffffff" }}>
                {teamA?.name ?? "TBD"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 * scale, fontSize: 72 * scale, fontWeight: 700 }}>
              <span>{aWins}</span>
              <span style={{ color: "#ffffff55" }}>–</span>
              <span>{bWins}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, alignItems: "flex-end" }}>
              <span style={{ fontSize: 44 * scale, fontWeight: 700, color: winnerName === teamB?.name ? SIGNAL : "#ffffff" }}>
                {teamB?.name ?? "TBD"}
              </span>
            </div>
          </div>

          {winnerName && <span style={{ fontSize: 26 * scale, color: SIGNAL, fontWeight: 600 }}>🏆 {winnerName} wins</span>}

          {mode === "advanced" && (teamAPicks.length > 0 || teamBPicks.length > 0) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 * scale, marginTop: 8 * scale }}>
              <span style={{ fontSize: 18 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 1 }}>
                Final game picks
              </span>
              <span style={{ fontSize: 20 * scale, color: "#ffffffcc" }}>
                {teamA?.name}: {teamAPicks.join(", ") || "—"}
              </span>
              <span style={{ fontSize: 20 * scale, color: "#ffffffcc" }}>
                {teamB?.name}: {teamBPicks.join(", ") || "—"}
              </span>
            </div>
          )}

          {mode === "advanced" && mvpLine && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 * scale, marginTop: 8 * scale }}>
              <span style={{ fontSize: 18 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 1 }}>
                Top performer
              </span>
              <span style={{ fontSize: 22 * scale, color: "#ffffffcc" }}>{mvpLine}</span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", fontSize: 18 * scale, color: "#ffffff55" }}>livevival-sigma.vercel.app</div>
      </div>
    ),
    { width, height }
  );
}

export async function GET(req: Request, { params }: { params: { matchId: string } }) {
  const { searchParams, origin } = new URL(req.url);
  const ratio: Ratio = searchParams.get("ratio") === "landscape" ? "landscape" : "portrait";
  const mode: Mode = searchParams.get("mode") === "advanced" ? "advanced" : "simple";
  // Same-origin static asset — unlike Liquipedia's CDN this needs no proxy
  // and no hotlink-protection workaround, so it's safe to fetch at render
  // time even though it's still one network hop for the edge function.
  const logoUrl = `${origin}/logo/logo-dark-bg.png`;

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

  const { data: match } = await supabase
    .from("matches")
    .select(
      `id, format, status, series_winner_team_id,
       tournament:tournaments(name),
       team_a:teams!matches_team_a_id_fkey(id, name),
       team_b:teams!matches_team_b_id_fkey(id, name)`
    )
    .eq("id", params.matchId)
    .single();

  if (!match) {
    return new Response("Match not found", { status: 404 });
  }
  const teamA = Array.isArray(match.team_a) ? match.team_a[0] : match.team_a;
  const teamB = Array.isArray(match.team_b) ? match.team_b[0] : match.team_b;
  const tournament = Array.isArray(match.tournament) ? match.tournament[0] : match.tournament;

  const { data: games } = await supabase
    .from("games")
    .select("id, game_number, winner_team_id")
    .eq("match_id", params.matchId)
    .order("game_number");

  let heroPicks: { team_id: string; hero_name: string }[] = [];
  let mvpLine: string | null = null;

  if (mode === "advanced" && games && games.length > 0) {
    const lastGameId = games[games.length - 1].id;
    const { data: picks } = await supabase
      .from("hero_picks_bans")
      .select("team_id, hero_name, pick_order")
      .eq("game_id", lastGameId)
      .eq("type", "pick")
      .order("pick_order");
    heroPicks = picks ?? [];

    const { data: stats } = await supabase
      .from("player_stats")
      .select("kills, deaths, assists, hero_name, player:players(ign)")
      .eq("match_id", params.matchId);
    const best = (stats ?? [])
      .map((s) => ({ ...s, player: Array.isArray(s.player) ? s.player[0] : s.player, score: s.kills + s.assists - s.deaths }))
      .sort((a, b) => b.score - a.score)[0];
    if (best) mvpLine = `${best.player?.ign ?? "?"} (${best.hero_name ?? "?"}) — ${best.kills}/${best.deaths}/${best.assists}`;
  }

  return renderCard({
    match: { format: match.format, series_winner_team_id: match.series_winner_team_id, tournament, team_a: teamA, team_b: teamB },
    games: games ?? [],
    heroPicks,
    mvpLine,
    ratio,
    mode,
    logoUrl,
  });
}
