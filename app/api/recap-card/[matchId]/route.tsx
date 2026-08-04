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

// Small angled accent ticks flanking a section title — Satori supports
// `transform`, so this reproduces the slanted red mark motif from the
// reference designs without needing a licensed icon asset.
function tickMarks(scale: number) {
  const tick = (
    <div
      style={{
        display: "flex",
        width: 14 * scale,
        height: 4 * scale,
        background: SIGNAL,
        transform: "skewX(-25deg)",
      }}
    />
  );
  return { left: tick, right: tick };
}

function renderCard({
  match,
  games,
  heroPicks,
  ratio,
  logoUrl,
}: {
  match: CardMatch;
  games: CardGame[];
  heroPicks: CardHeroPick[];
  ratio: Ratio;
  logoUrl: string;
}) {
  const teamA = match.team_a;
  const teamB = match.team_b;
  const winsFor = (teamId?: string) => games.filter((g) => g.winner_team_id === teamId).length;
  const aWins = winsFor(teamA?.id);
  const bWins = winsFor(teamB?.id);
  const winnerId =
    match.series_winner_team_id ?? (aWins > bWins ? teamA?.id : bWins > aWins ? teamB?.id : null) ?? null;

  const { width, height } = dims(ratio);
  const scale = width / 1080;
  const teamAPicks = heroPicks.filter((p) => p.team_id === teamA?.id);
  const teamBPicks = heroPicks.filter((p) => p.team_id === teamB?.id);
  const isLandscape = ratio === "landscape";
  const ticks = tickMarks(scale);

  // Every hero portrait sits on a light plate with a signal-colored ring —
  // the same "logo/icon always gets a backing box" rule used everywhere
  // else on the site (components/TeamLogo.tsx). That component samples the
  // actual image's luminance client-side to decide light-vs-dark backing;
  // Satori's edge renderer has no canvas/pixel access to replicate that
  // here, so this always uses a light plate, which reads correctly for the
  // overwhelming majority of real team/hero art (dark or colorful icons on
  // white) at the cost of not inverting for the rare near-white logo.
  const heroPortrait = (p: CardHeroPick, i: number) => (
    <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 * scale, width: 92 * scale }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 84 * scale,
          height: 84 * scale,
          borderRadius: 999,
          background: "#f5f5f5",
          border: `3px solid ${SIGNAL}`,
          overflow: "hidden",
        }}
      >
        {p.icon_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.icon_url} alt="" width={84 * scale} height={84 * scale} style={{ objectFit: "cover" }} />
        )}
      </div>
      <span
        style={{
          fontSize: 15 * scale,
          fontWeight: 600,
          color: "#ffffffdd",
          textAlign: "center",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {p.hero_name}
      </span>
    </div>
  );

  const teamPickColumn = (name: string | undefined, picks: CardHeroPick[]) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 * scale, flex: 1 }}>
      {/* Angled ribbon tag — both teams get the same signal-red treatment,
          matching both reference designs (neither singles out one side). */}
      <div
        style={{
          display: "flex",
          alignSelf: "flex-start",
          background: SIGNAL,
          padding: `${6 * scale}px ${18 * scale}px`,
          transform: "skewX(-12deg)",
        }}
      >
        <span
          style={{
            display: "flex",
            transform: "skewX(12deg)",
            fontSize: 18 * scale,
            fontWeight: 700,
            color: "#ffffff",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          {name ?? "TBD"}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 * scale }}>
        {picks.length > 0 ? picks.map((p, i) => heroPortrait(p, i)) : <span style={{ fontSize: 18 * scale, color: "#ffffff40" }}>—</span>}
      </div>
    </div>
  );

  const finalPicksBlock = (teamAPicks.length > 0 || teamBPicks.length > 0) && (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 * scale }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14 * scale }}>
        {ticks.left}
        <span style={{ fontSize: 20 * scale, color: "#ffffffaa", textTransform: "uppercase", letterSpacing: 4 }}>Final game picks</span>
        {ticks.right}
      </div>
      <div style={{ display: "flex", flexDirection: isLandscape ? "row" : "column", gap: isLandscape ? 40 * scale : 26 * scale }}>
        {teamPickColumn(teamA?.name, teamAPicks)}
        {teamPickColumn(teamB?.name, teamBPicks)}
      </div>
    </div>
  );

  // Boxed team logo (square, light-plate backing per the note above) with
  // the name below and a per-team winner pill, matching the portrait
  // reference exactly — the landscape reference's single centered trophy
  // is a cosmetic variant of the same information, and a per-team badge
  // reads unambiguously at any size, so it's used for both ratios.
  const teamBox = (team: CardMatch["team_a"], wins: number, isWinner: boolean, hasWinner: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 * scale, flex: 1, opacity: hasWinner && !isWinner ? 0.55 : 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 176 * scale,
          height: 176 * scale,
          borderRadius: 28 * scale,
          background: "#f5f5f5",
          border: `${isWinner ? 6 : 2}px solid ${isWinner ? SIGNAL : "#ffffff2a"}`,
          padding: 20 * scale,
          boxShadow: isWinner ? `0 0 ${64 * scale}px ${SIGNAL}66` : "none",
        }}
      >
        {team?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={team.logo_url} alt="" width={132 * scale} height={132 * scale} style={{ objectFit: "contain" }} />
        ) : (
          <span style={{ fontSize: 48 * scale, fontWeight: 700, color: INK }}>{(team?.name ?? "?").slice(0, 2).toUpperCase()}</span>
        )}
      </div>
      <span style={{ fontSize: 32 * scale, fontWeight: 700, color: isWinner ? SIGNAL : "#ffffff", textAlign: "center" }}>
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

  const scoreBar = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24 * scale }}>
      <span style={{ fontSize: 20 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 3, textAlign: "center" }}>
        {match.tournament?.name ?? ""} {match.format ? `· ${match.format}` : ""}
      </span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 40 * scale, width: "100%" }}>
        {teamBox(teamA, aWins, winnerId === teamA?.id, Boolean(winnerId))}
        <div style={{ display: "flex", alignItems: "center", gap: 24 * scale, fontSize: 140 * scale, fontWeight: 700, lineHeight: 1 }}>
          <span style={{ color: winnerId === teamA?.id ? SIGNAL : "#ffffff" }}>{aWins}</span>
          <span style={{ color: "#ffffff33", fontSize: 80 * scale }}>–</span>
          <span style={{ color: winnerId === teamB?.id ? SIGNAL : "#ffffff" }}>{bWins}</span>
        </div>
        {teamBox(teamB, bWins, winnerId === teamB?.id, Boolean(winnerId))}
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
            <span style={{ fontSize: 16 * scale, color: "#ffffff55", textTransform: "uppercase", letterSpacing: 3 }}>Match recap</span>
          </div>

          {/* Landscape gets a genuine two-column recomposition for the
              picks (each team's 5 heroes as their own row, side by side)
              instead of the portrait's stacked rows — matches the two
              reference layouts rather than scaling one design uniformly. */}
          <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: isLandscape ? 48 * scale : 40 * scale, marginTop: 24 * scale }}>
            {scoreBar}
            {finalPicksBlock}
          </div>

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
            <span style={{ fontSize: 18 * scale, color: "#ffffff33", textTransform: "uppercase", letterSpacing: 2 }}>Esports live score</span>
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

  return renderCard({
    match: { format: match.format, series_winner_team_id: match.series_winner_team_id, tournament, team_a: teamA, team_b: teamB },
    games: games ?? [],
    heroPicks,
    ratio,
    logoUrl,
  });
}
