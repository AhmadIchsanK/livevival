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

  // Redesign: hero picks now sit inside a chip (subtle card background,
  // rounded, bordered) instead of floating bare on the arena-glow
  // background — same "icon everywhere, name advanced-only" behavior as
  // before (fixes "hero image doesn't show" for the simple card), but the
  // chip gives each pick some visual weight instead of reading as loose
  // text/icons scattered on empty space.
  const heroPickRow = (name: string | undefined, picks: CardHeroPick[]) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 * scale }}>
      {mode === "advanced" && (
        <span style={{ fontSize: 16 * scale, color: "#ffffff55", textTransform: "uppercase", letterSpacing: 1 }}>{name}</span>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 * scale }}>
        {picks.length === 0 && <span style={{ fontSize: 20 * scale, color: "#ffffff40" }}>—</span>}
        {picks.map((p, j) => (
          <div
            key={j}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10 * scale,
              background: "#ffffff0d",
              border: "1px solid #ffffff1f",
              borderRadius: 14 * scale,
              padding: `${8 * scale}px ${mode === "advanced" ? 16 * scale : 10 * scale}px`,
            }}
          >
            {p.icon_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.icon_url} alt="" width={60 * scale} height={60 * scale} style={{ borderRadius: 999, objectFit: "cover", border: "2px solid #ffffff33" }} />
            )}
            {mode === "advanced" && <span style={{ fontSize: 20 * scale, color: "#ffffffdd", fontWeight: 600 }}>{p.hero_name}</span>}
          </div>
        ))}
      </div>
    </div>
  );

  // Bigger, poster-scale logos than before (168 vs 140) — the biggest
  // single leverage point for "less empty space" was the logo boxes
  // themselves, since a match recap is fundamentally "two team crests and
  // a score." A losing side gets a subtle desaturating dim (opacity) so
  // the winner reads as the clear focal point without needing extra text.
  const teamBlock = (team: CardMatch["team_a"], wins: number, isWinner: boolean, hasWinner: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 * scale, flex: 1, opacity: hasWinner && !isWinner ? 0.55 : 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 168 * scale,
          height: 168 * scale,
          borderRadius: 32 * scale,
          background: isWinner ? `${SIGNAL}1f` : "#ffffff14",
          border: `${isWinner ? 5 : 1}px solid ${isWinner ? SIGNAL : "#ffffff22"}`,
          padding: 18 * scale,
          boxShadow: isWinner ? `0 0 ${64 * scale}px ${SIGNAL}55` : "none",
        }}
      >
        {team?.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={team.logo_url} alt="" width={124 * scale} height={124 * scale} style={{ objectFit: "contain" }} />
        )}
      </div>
      <span style={{ fontSize: 34 * scale, fontWeight: 700, color: isWinner ? SIGNAL : "#ffffff", textAlign: "center" }}>
        {team?.name ?? "TBD"}
      </span>
      {isWinner && (
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6 * scale,
            fontSize: 16 * scale,
            fontWeight: 700,
            color: SIGNAL,
            textTransform: "uppercase",
            letterSpacing: 1,
            background: `${SIGNAL}1a`,
            border: `1px solid ${SIGNAL}55`,
            borderRadius: 999,
            padding: `${4 * scale}px ${14 * scale}px`,
          }}
        >
          🏆 Winner
        </span>
      )}
    </div>
  );

  // Score dominates the frame now (140px, up from 96) — a match recap's
  // single most-scanned number gets the most visual weight, with the
  // tournament line demoted to a small eyebrow above the two crests
  // instead of competing with the score for top billing.
  const scoreHeader = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 * scale }}>
      <span style={{ fontSize: 20 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 3, textAlign: "center" }}>
        {match.tournament?.name ?? ""} {match.format ? `· ${match.format}` : ""}
      </span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 40 * scale, width: "100%" }}>
        {teamBlock(teamA, aWins, winnerName === teamA?.name, Boolean(winnerName))}
        <div style={{ display: "flex", alignItems: "center", gap: 24 * scale, fontSize: 140 * scale, fontWeight: 700, lineHeight: 1 }}>
          <span style={{ color: winnerName === teamA?.name ? SIGNAL : "#ffffff" }}>{aWins}</span>
          <span style={{ color: "#ffffff33", fontSize: 80 * scale }}>–</span>
          <span style={{ color: winnerName === teamB?.name ? SIGNAL : "#ffffff" }}>{bWins}</span>
        </div>
        {teamBlock(teamB, bWins, winnerName === teamB?.name, Boolean(winnerName))}
      </div>
    </div>
  );

  const sectionLabel = (text: string) => (
    <span style={{ fontSize: 16 * scale, color: "#ffffff55", textTransform: "uppercase", letterSpacing: 2 }}>{text}</span>
  );

  const heroPicksBlock = (teamAPicks.length > 0 || teamBPicks.length > 0) && (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 * scale }}>
      {sectionLabel("Final game picks")}
      <div style={{ display: "flex", flexDirection: isLandscape ? "column" : "row", flexWrap: "wrap", gap: 16 * scale }}>
        {heroPickRow(teamA?.name, teamAPicks)}
        {heroPickRow(teamB?.name, teamBPicks)}
      </div>
    </div>
  );

  // MVP as a highlighted stat card (signal-tinted chip) instead of plain
  // text — gives the "top performer" callout the same visual treatment
  // real esports broadcast graphics use for a standout stat.
  const mvpBlock = mode === "advanced" && mvpLine && (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 * scale }}>
      {sectionLabel("Top performer")}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10 * scale,
          background: `${SIGNAL}14`,
          border: `1px solid ${SIGNAL}40`,
          borderRadius: 14 * scale,
          padding: `${12 * scale}px ${18 * scale}px`,
          width: "fit-content",
        }}
      >
        <span style={{ fontSize: 24 * scale }}>⭐</span>
        <span style={{ fontSize: 22 * scale, color: "#ffffffee", fontWeight: 600 }}>{mvpLine}</span>
      </div>
    </div>
  );

  const keyMomentsBlock = mode === "advanced" && keyMomentLines.length > 0 && (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 * scale }}>
      {sectionLabel("Key moments")}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 * scale }}>
        {keyMomentLines.map((line, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10 * scale,
              background: "#ffffff0d",
              border: "1px solid #ffffff1f",
              borderRadius: 12 * scale,
              padding: `${10 * scale}px ${16 * scale}px`,
              width: "fit-content",
            }}
          >
            <span style={{ fontSize: 20 * scale }}>🔥</span>
            <span style={{ fontSize: 20 * scale, color: "#ffffffcc" }}>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return new ImageResponse(
    (
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          background: `linear-gradient(160deg, ${INK} 0%, #1a0a0a 100%)`,
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        {/* Procedural "arena glow" — layered radial gradients standing in
            for a blurred stadium/map photo (no licensed asset to source
            here). Absolutely positioned + explicit z-index so they sit
            behind the content regardless of paint order. */}
        <div
          style={{
            position: "absolute",
            zIndex: 0,
            top: `-${20 * scale}%`,
            left: `-${15 * scale}%`,
            width: "70%",
            height: "60%",
            background: `radial-gradient(closest-side, ${SIGNAL}33, transparent 70%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            zIndex: 0,
            bottom: `-${25 * scale}%`,
            right: `-${20 * scale}%`,
            width: "80%",
            height: "70%",
            background: `radial-gradient(closest-side, ${SIGNAL}26, transparent 70%)`,
          }}
        />
        <div
          style={{
            position: "absolute",
            zIndex: 0,
            top: "35%",
            left: "50%",
            width: "60%",
            height: "50%",
            background: `radial-gradient(closest-side, ${SIGNAL}1a, transparent 75%)`,
          }}
        />

        <div
          style={{
            position: "relative",
            zIndex: 1,
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
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
              {/* Centered, not top-aligned — in simple mode this column is
                  only heroPicksBlock (mvp/keyMoments are advanced-only), so
                  top-aligning it left a big empty lower half of the frame. */}
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flex: 1, height: "100%", gap: 28 * scale }}>
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

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "1px solid #ffffff1a",
              paddingTop: 20 * scale,
              marginTop: 24 * scale,
            }}
          >
            <span style={{ fontSize: 18 * scale, color: "#ffffff55", letterSpacing: 1 }}>livevival-sigma.vercel.app</span>
            <span style={{ fontSize: 18 * scale, color: "#ffffff33", textTransform: "uppercase", letterSpacing: 2 }}>Match recap</span>
          </div>
        </div>
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
