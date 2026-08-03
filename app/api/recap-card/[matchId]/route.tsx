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
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
};
type CardGame = { winner_team_id: string | null };
type CardHeroPick = { team_id: string; hero_name: string; icon_url: string | null };

// Liquipedia-hosted images need this site's own proxy (hotlink protection —
// see lib/proxiedImageUrl.ts / app/api/image-proxy) — building the absolute
// form here since this runs server-side with no browser location to resolve
// the relative form against.
function proxied(origin: string, url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith("https://liquipedia.net/")) return url;
  return `${origin}/api/image-proxy?url=${encodeURIComponent(url)}`;
}

function dims(ratio: Ratio) {
  return ratio === "portrait" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function renderCard({
  match,
  games,
  heroPicks,
  mvpLine,
  keyMomentLines,
  ratio,
  mode,
  logoUrl,
}: {
  match: CardMatch;
  games: CardGame[];
  heroPicks: CardHeroPick[];
  mvpLine: string | null;
  keyMomentLines: string[];
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
  const teamAPicks = heroPicks.filter((p) => p.team_id === teamA?.id);
  const teamBPicks = heroPicks.filter((p) => p.team_id === teamB?.id);
  const isLandscape = ratio === "landscape";

  // Icons render in every mode now (that's the fix for "hero image still
  // doesn't show" — the fetch used to be skipped entirely outside advanced
  // mode); only the hero NAME text is advanced-only, per spec ("simple:
  // only team logo, score and hero icon" / "advanced: both icon and name").
  const heroPickRow = (name: string | undefined, picks: CardHeroPick[]) => (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 * scale }}>
      {mode === "advanced" && <span style={{ fontSize: 18 * scale, color: "#ffffffcc" }}>{name}:</span>}
      {picks.length === 0 && <span style={{ fontSize: 18 * scale, color: "#ffffff55" }}>—</span>}
      {picks.map((p, j) => (
        <div key={j} style={{ display: "flex", alignItems: "center", gap: 4 * scale }}>
          {p.icon_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.icon_url} alt="" width={30 * scale} height={30 * scale} style={{ borderRadius: 999, objectFit: "cover", border: `1px solid #ffffff33` }} />
          )}
          {mode === "advanced" && <span style={{ fontSize: 18 * scale, color: "#ffffffcc" }}>{p.hero_name}</span>}
        </div>
      ))}
    </div>
  );

  const teamBlock = (team: CardMatch["team_a"], wins: number, isWinner: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 * scale, flex: 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 84 * scale,
          height: 84 * scale,
          borderRadius: 18 * scale,
          background: "#ffffff1a",
          border: `${isWinner ? 3 : 1}px solid ${isWinner ? SIGNAL : "#ffffff22"}`,
          padding: 10 * scale,
        }}
      >
        {team?.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={team.logo_url} alt="" width={64 * scale} height={64 * scale} style={{ objectFit: "contain" }} />
        )}
      </div>
      <span style={{ fontSize: 34 * scale, fontWeight: 700, color: isWinner ? SIGNAL : "#ffffff", textAlign: "center" }}>
        {team?.name ?? "TBD"}
      </span>
    </div>
  );

  const scoreHeader = (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 * scale }}>
      <span style={{ fontSize: 22 * scale, color: "#ffffff77", textTransform: "uppercase", letterSpacing: 2 }}>
        {match.tournament?.name ?? ""} {match.format ? `· ${match.format}` : ""}
      </span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {teamBlock(teamA, aWins, winnerName === teamA?.name)}
        <div style={{ display: "flex", alignItems: "center", gap: 16 * scale, fontSize: 72 * scale, fontWeight: 700 }}>
          <span>{aWins}</span>
          <span style={{ color: "#ffffff55" }}>–</span>
          <span>{bWins}</span>
        </div>
        {teamBlock(teamB, bWins, winnerName === teamB?.name)}
      </div>
      {winnerName && <span style={{ fontSize: 26 * scale, color: SIGNAL, fontWeight: 600 }}>🏆 {winnerName} wins</span>}
    </div>
  );

  const heroPicksBlock = (teamAPicks.length > 0 || teamBPicks.length > 0) && (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 * scale }}>
      <span style={{ fontSize: 18 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 1 }}>Final game picks</span>
      {heroPickRow(teamA?.name, teamAPicks)}
      {heroPickRow(teamB?.name, teamBPicks)}
    </div>
  );

  const mvpBlock = mode === "advanced" && mvpLine && (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 * scale }}>
      <span style={{ fontSize: 18 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 1 }}>Top performer</span>
      <span style={{ fontSize: 22 * scale, color: "#ffffffcc" }}>{mvpLine}</span>
    </div>
  );

  const keyMomentsBlock = mode === "advanced" && keyMomentLines.length > 0 && (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 * scale }}>
      <span style={{ fontSize: 18 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 1 }}>Key moments</span>
      {keyMomentLines.map((line, i) => (
        <span key={i} style={{ fontSize: 20 * scale, color: "#ffffffcc" }}>🔥 {line}</span>
      ))}
    </div>
  );

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
        {/* Brand accent bar — an angular sliver of signal red across the
            top, echoing the site's own .lv-clip-corner mark motif, so the
            card reads as Livevival-branded even cropped to a thumbnail. */}
        <div
          style={{
            display: "flex",
            width: 120 * scale,
            height: 8 * scale,
            background: SIGNAL,
            borderRadius: 4 * scale,
            marginBottom: 28 * scale,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          {/* Real width/height needed — Satori doesn't do intrinsic image
              sizing, and logo-dark-bg.png's native ratio is 1248:352. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl} alt="Livevival" width={(isLandscape ? 168 : 142) * scale} height={(isLandscape ? 48 : 40) * scale} />
        </div>

        {/* Landscape gets a genuine two-column recomposition (score left,
            picks/MVP/moments right) instead of the portrait stack scaled
            up uniformly — the latter left the wide frame looking sparse. */}
        {isLandscape ? (
          <div style={{ display: "flex", flexGrow: 1, alignItems: "center", gap: 56 * scale, marginTop: 24 * scale }}>
            <div style={{ display: "flex", flex: 1 }}>{scoreHeader}</div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 20 * scale }}>
              {heroPicksBlock}
              {mvpBlock}
              {keyMomentsBlock}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, flexShrink: 1, flexBasis: 0, justifyContent: "center", gap: 24 * scale }}>
            {scoreHeader}
            {heroPicksBlock}
            {mvpBlock}
            {keyMomentsBlock}
          </div>
        )}

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
       team_a:teams!matches_team_a_id_fkey(id, name, logo_url),
       team_b:teams!matches_team_b_id_fkey(id, name, logo_url)`
    )
    .eq("id", params.matchId)
    .single();

  if (!match) {
    return new Response("Match not found", { status: 404 });
  }
  const rawTeamA = Array.isArray(match.team_a) ? match.team_a[0] : match.team_a;
  const rawTeamB = Array.isArray(match.team_b) ? match.team_b[0] : match.team_b;
  const teamA = rawTeamA ? { ...rawTeamA, logo_url: proxied(origin, rawTeamA.logo_url) } : null;
  const teamB = rawTeamB ? { ...rawTeamB, logo_url: proxied(origin, rawTeamB.logo_url) } : null;
  const tournament = Array.isArray(match.tournament) ? match.tournament[0] : match.tournament;

  const { data: games } = await supabase
    .from("games")
    .select("id, game_number, winner_team_id")
    .eq("match_id", params.matchId)
    .order("game_number");

  let heroPicks: CardHeroPick[] = [];
  let mvpLine: string | null = null;
  let keyMomentLines: string[] = [];

  // Hero picks now render in BOTH modes (icons only in simple, icons+names
  // in advanced) — gating the fetch itself behind mode === "advanced" was
  // why "the hero image still doesn't show" for anyone sharing the
  // default (simple) card: the query never ran, so there was nothing to
  // render regardless of the JSX below.
  if (games && games.length > 0) {
    const lastGameId = games[games.length - 1].id;
    const { data: picks } = await supabase
      .from("hero_picks_bans")
      .select("team_id, hero_name, pick_order, hero:heroes(icon_url)")
      .eq("game_id", lastGameId)
      .eq("type", "pick")
      .order("pick_order");
    heroPicks = (picks ?? []).map((p) => {
      const hero = Array.isArray(p.hero) ? p.hero[0] : p.hero;
      return { team_id: p.team_id, hero_name: p.hero_name, icon_url: proxied(origin, hero?.icon_url) };
    });
  }

  if (mode === "advanced") {
    const { data: keyMoments } = await supabase
      .from("key_moments")
      .select("type, game:games(game_number), player:players(ign)")
      .eq("match_id", params.matchId)
      .in("type", ["savage", "maniac"]);
    keyMomentLines = (keyMoments ?? []).map((km) => {
      const game = Array.isArray(km.game) ? km.game[0] : km.game;
      const player = Array.isArray(km.player) ? km.player[0] : km.player;
      const label = km.type === "savage" ? "Savage" : "Maniac";
      const who = player?.ign ?? "A player";
      return `${who} got a ${label}${game?.game_number ? ` in Game ${game.game_number}` : ""}`;
    });

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
    keyMomentLines,
    ratio,
    mode,
    logoUrl,
  });
}
