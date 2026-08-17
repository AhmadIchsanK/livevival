import { ImageResponse } from "next/og";
import { createClient } from "@supabase/supabase-js";

// Date-only formatter for recap card (time removed to fit safe area in portrait)
function formatRecapDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const year = d.getFullYear();
  const month = MONTH_NAMES[d.getMonth()];
  const day = String(d.getDate()).padStart(2, "0");
  return `${year} ${month} ${day}`;
}

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
  stage: string | null;
  scheduled_at: string | null;
  series_winner_team_id: string | null;
  tournament: { name: string } | null;
  team_a: { id: string; name: string; logo_url: string | null } | null;
  team_b: { id: string; name: string; logo_url: string | null } | null;
};
type CardGame = { winner_team_id: string | null };
type CardHeroPick = {
  team_id: string;
  hero_name: string;
  icon_url: string | null;
  type: "pick" | "ban";
  // Only ever populated for Hot (OCR-tracked) matches — Liquipedia-synced
  // picks/bans have no player_id to join a KDA row against, so this stays
  // undefined for Normal matches and the card never reserves space for it.
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
};

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

// Small accent ticks flanking a section title. An earlier version used
// `transform: skewX()` here (and on the ribbon tags below) to match the
// reference design's angled marks exactly — that corrupted Satori's layout
// for every sibling after it (confirmed against a real broken render: two
// team pick columns collapsed into each other and one side vanished
// entirely in landscape). Satori's yoga-based layout engine computes box
// size from the pre-transform geometry in most cases, but nested/opposing
// skews on flex containers is exactly the kind of case its docs warn is
// unsupported — so this drops the skew and keeps a plain rectangle, which
// still reads as an accent mark without risking the same corruption.
function tickMarks(scale: number) {
  const tick = (
    <div
      style={{
        display: "flex",
        width: 16 * scale,
        height: 4 * scale,
        background: SIGNAL,
        borderRadius: 2 * scale,
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
  // Every size below is an absolute pixel value tuned to look right on
  // portrait's 1920px-TALL canvas, so the right scale factor is always
  // "how does this canvas's HEIGHT compare to portrait's" — not width.
  // Using width/1080 for landscape (1920 wide) inflated every element by
  // ~1.78x on top of already-portrait-tuned sizes, which is why a real
  // landscape render overflowed its own 1080px-tall frame and the whole
  // picks section fell off the bottom, invisible. Landscape's height
  // (1080) is a bit over half of portrait's (1920), so this scales
  // everything down accordingly — its much wider frame is what gives the
  // two-column pick layout room, not bigger absolute pixel sizes.
  const scale = ratio === "landscape" ? height / 1920 : width / 1080;
  const teamAPicks = heroPicks.filter((p) => p.team_id === teamA?.id && p.type === "pick");
  const teamBPicks = heroPicks.filter((p) => p.team_id === teamB?.id && p.type === "pick");
  const teamABans = heroPicks.filter((p) => p.team_id === teamA?.id && p.type === "ban");
  const teamBBans = heroPicks.filter((p) => p.team_id === teamB?.id && p.type === "ban");
  const isLandscape = ratio === "landscape";
  const ticks = tickMarks(scale);

  // Safe-margin convention (confirmed via real rendered screenshots showing
  // footer text cutting through the last ban row's labels in BOTH
  // orientations): top/bottom margin is scaled off the canvas HEIGHT so it
  // reads the same proportionally in both ratios (80px on portrait's
  // 1920-tall canvas == ~42px on landscape's 1080-tall one, ~3.9%).
  // Left/right margin is intentionally NOT the same value in landscape —
  // that would be ~42px on a 1920-wide canvas (2.2%), way tighter than
  // portrait's 80px on its 1080-wide canvas (7.4%). marginX uses that
  // same 7.4%-of-width ratio so landscape gets a proportionally equivalent
  // side margin (~141px) instead of an accidentally-thin one.
  // Increased from 64px to 80px in portrait to ensure time-removed date fits
  // comfortably within safe area without overlapping header or footer.
  const marginY = 80 * scale;
  const marginX = isLandscape ? 141 : 80 * scale;
  // Landscape-only size boosts so the wider canvas's extra horizontal room
  // shows up as bigger, more prominent content instead of empty black space
  // between the two team columns (confirmed via a rough height budget: even
  // after these boosts, landscape's content column comes in ~200px under
  // its 1080px-tall frame, so there's no risk of pushing bans/picks into
  // the footer). heroBoost enlarges pick/ban hero portraits and their
  // internal gaps; logoBoost enlarges the team logo plates in the score bar.
  // Portrait uses 0.75 to fit all 5 picks + 5 bans per team without clipping.
  const heroBoost = isLandscape ? 1.4 : 0.75;
  const logoBoost = isLandscape ? 1.25 : 1;

  // Every hero portrait sits on a light plate with a signal-colored ring —
  // the same "logo/icon always gets a backing box" rule used everywhere
  // else on the site (components/TeamLogo.tsx). That component samples the
  // actual image's luminance client-side to decide light-vs-dark backing;
  // Satori's edge renderer has no canvas/pixel access to replicate that
  // here, so this always uses a light plate, which reads correctly for the
  // overwhelming majority of real team/hero art (dark or colorful icons on
  // white) at the cost of not inverting for the rare near-white logo.
  //
  // The card the browser renders for a real match page's Draft Recap panel
  // (app/match/[id]/page.tsx) gets this exactly right with plain CSS:
  // `object-fit: cover; object-position: top` on a roughly-square box.
  // Satori can't do the same thing — `object-fit` compiles straight to an
  // SVG `preserveAspectRatio="xMidYMid slice"` (confirmed by inspecting the
  // bundled renderer's source) that always centers the crop on both axes
  // and never reads `object-position` at all. A prior attempt compensated
  // by cover-fitting into a box 2.4x taller than a SQUARE frame, which
  // over-corrected: it forced enough horizontal scale-up to cover that tall
  // a box that real hero art was visibly losing its left/right edges ("get
  // cutting out"). The fix is to make the frame itself portrait-shaped
  // (closer to the hero art's own real proportions) instead of forcing a
  // square into a tall crop — a portrait frame needs far less artificial
  // height padding to bias the crop toward the face, so far less horizontal
  // over-crop happens as a side effect.
  const heroPortrait = (p: CardHeroPick, i: number, boxWidth: number, ringWidth: number) => {
    const hasKda = p.kills != null && p.deaths != null && p.assists != null;
    const boxHeight = boxWidth * 1.35;
    return (
      <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 * scale, width: boxWidth + 16 * scale }}>
        <div
          style={{
            display: "flex",
            position: "relative",
            width: boxWidth,
            height: boxHeight,
            borderRadius: boxWidth * 0.14,
            background: "#f5f5f5",
            border: `${ringWidth}px solid ${p.type === "ban" ? "#ffffff40" : SIGNAL}`,
            overflow: "hidden",
          }}
        >
          {p.icon_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={p.icon_url}
              alt=""
              width={boxWidth}
              height={boxHeight * 1.35}
              style={{ objectFit: "cover", position: "absolute", top: 0, left: 0 }}
            />
          )}
          {p.type === "ban" && (
            <div style={{ display: "flex", position: "absolute", top: 0, left: 0, right: 0, bottom: 0, background: "#0a0a0a99" }} />
          )}
        </div>
        <span
          style={{
            fontSize: 19 * scale,
            fontWeight: 700,
            color: p.type === "ban" ? "#ffffff88" : "#ffffffee",
            textAlign: "center",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {p.hero_name}
        </span>
        {hasKda && (
          <span style={{ fontSize: 16 * scale, fontWeight: 600, color: "#ffffff99", letterSpacing: 0.5 }}>
            {p.kills}/{p.deaths}/{p.assists}
          </span>
        )}
      </div>
    );
  };

  // Ribbon tag: a plain solid-color rounded rect, not the angled/skewed
  // shape in the reference art. Satori's layout engine (yoga) doesn't
  // reliably support a `transform: skewX()` flex container with a
  // counter-skewed text child inside it — confirmed against a real broken
  // render where this exact pattern corrupted the layout of every sibling
  // after it (two team columns collapsing into each other, and the whole
  // row vanishing in landscape). Not worth the risk for a cosmetic angle.
  // `flex: 1` (flex-grow with an implicit flex-basis: 0) is only safe here
  // in landscape's row layout — confirmed via an offline render test that
  // Satori's layout engine collapses a COLUMN-direction flex item using
  // flex-grow to near-zero height when its parent's height is content-
  // driven rather than fixed (exactly portrait's case here), which is what
  // caused team A's whole column — ribbon and all 5 hero portraits — to
  // render on top of team B's instead of stacked above it. Landscape's row
  // layout doesn't hit this; each column's cross-axis (width) is bounded
  // by the frame's own definite width, so flex-grow resolves correctly
  // there and both columns split the row evenly as intended.
  const subLabel = (text: string) => (
    <span style={{ display: "flex", fontSize: 15 * scale, fontWeight: 700, color: "#ffffff55", textTransform: "uppercase", letterSpacing: 2 }}>
      {text}
    </span>
  );

  // Everything here is center-oriented (not left-aligned like the previous
  // version) per the redesign brief — the ribbon, the picks row, and the
  // bans row all center on the column's own width, and in portrait mode
  // the whole column is centered on the card. Hero portraits are also
  // noticeably bigger than before (128*scale-wide picks vs. the old
  // 110*scale square) so the section fills more of the available frame
  // instead of leaving visible dead space.
  const teamPickColumn = (name: string | undefined, picks: CardHeroPick[], bans: CardHeroPick[]) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: isLandscape ? 26 * scale : 18 * scale, minWidth: 0, ...(isLandscape ? { flex: 1 } : {}) }}>
      <div
        style={{
          display: "flex",
          background: SIGNAL,
          borderRadius: 6 * scale,
          padding: `${8 * scale}px ${22 * scale}px`,
        }}
      >
        <span
          style={{
            fontSize: 21 * scale,
            fontWeight: 700,
            color: "#ffffff",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          {name ?? "TBD"}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 * scale }}>
        {subLabel("Picks")}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: isLandscape ? 20 * scale * heroBoost : 16 * scale * heroBoost }}>
          {picks.length > 0 ? picks.map((p, i) => heroPortrait(p, i, 128 * scale * heroBoost, 4)) : <span style={{ fontSize: 18 * scale, color: "#ffffff40" }}>—</span>}
        </div>
      </div>
      {bans.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 * scale }}>
          {subLabel("Bans")}
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: isLandscape ? 16 * scale * heroBoost : 12 * scale * heroBoost }}>
            {bans.map((p, i) => heroPortrait(p, i, 92 * scale * heroBoost, 3))}
          </div>
        </div>
      )}
    </div>
  );

  const hasAnyPickOrBan = teamAPicks.length > 0 || teamBPicks.length > 0 || teamABans.length > 0 || teamBBans.length > 0;
  const finalPicksBlock = hasAnyPickOrBan && (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 36 * scale }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 * scale }}>
        {ticks.left}
        <span style={{ fontSize: 22 * scale, color: "#ffffffaa", textTransform: "uppercase", letterSpacing: 4 }}>Final game picks &amp; bans</span>
        {ticks.right}
      </div>
      <div style={{ display: "flex", flexDirection: isLandscape ? "row" : "column", alignItems: "center", justifyContent: "center", gap: isLandscape ? 80 * scale : 36 * scale, width: "100%" }}>
        {teamPickColumn(teamA?.name, teamAPicks, teamABans)}
        {teamPickColumn(teamB?.name, teamBPicks, teamBBans)}
      </div>
    </div>
  );

  // Boxed team logo (square, light-plate backing per the note above) with
  // the name below and a per-team winner pill, matching the portrait
  // reference exactly — the landscape reference's single centered trophy
  // is a cosmetic variant of the same information, and a per-team badge
  // reads unambiguously at any size, so it's used for both ratios.
  const teamBox = (team: CardMatch["team_a"], wins: number, isWinner: boolean, hasWinner: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 * scale, flex: 1, opacity: hasWinner && !isWinner ? 0.55 : 1 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 220 * scale * logoBoost,
          height: 220 * scale * logoBoost,
          borderRadius: 32 * scale,
          background: "#f5f5f5",
          border: `${isWinner ? 7 : 2}px solid ${isWinner ? SIGNAL : "#ffffff2a"}`,
          padding: 24 * scale * logoBoost,
          boxShadow: isWinner ? `0 0 ${72 * scale}px ${SIGNAL}66` : "none",
        }}
      >
        {team?.logo_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={team.logo_url} alt="" width={164 * scale * logoBoost} height={164 * scale * logoBoost} style={{ objectFit: "contain" }} />
        ) : (
          <span style={{ fontSize: 56 * scale * logoBoost, fontWeight: 700, color: INK }}>{(team?.name ?? "?").slice(0, 2).toUpperCase()}</span>
        )}
      </div>
      <span style={{ fontSize: 36 * scale, fontWeight: 700, color: isWinner ? SIGNAL : "#ffffff", textAlign: "center" }}>
        {team?.name ?? "TBD"}
      </span>
      {isWinner && (
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6 * scale,
            fontSize: 17 * scale,
            fontWeight: 700,
            color: SIGNAL,
            textTransform: "uppercase",
            letterSpacing: 1,
            background: `${SIGNAL}1a`,
            border: `1px solid ${SIGNAL}55`,
            borderRadius: 999,
            padding: `${5 * scale}px ${16 * scale}px`,
          }}
        >
          🏆 Winner
        </span>
      )}
    </div>
  );

  // Stage ("Group A", "Playoffs", "Grand Final", ...) and the match date
  // sit on their own line below the tournament/format line — a subtler
  // sub-label (smaller, more muted, tighter letter-spacing than the
  // tournament line) rather than crowding onto the same line, matching the
  // "Picks"/"Bans" sub-label treatment already used below (see subLabel()).
  // Either piece is omitted gracefully when absent — a null stage never
  // renders as a stray "null" or empty dot-separator.
  // Date-only format (time removed) ensures portrait mode content stays within safe area
  const dateLabel = formatRecapDate(match.scheduled_at);
  const stageDateBits = [match.stage, dateLabel || null].filter(Boolean);

  const scoreBar = (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 * scale }}>
      <span style={{ fontSize: 22 * scale, color: "#ffffff66", textTransform: "uppercase", letterSpacing: 3, textAlign: "center" }}>
        {match.tournament?.name ?? ""} {match.format ? `· ${match.format}` : ""}
      </span>
      {stageDateBits.length > 0 && (
        <span style={{ fontSize: 16 * scale, fontWeight: 700, color: "#ffffff44", textTransform: "uppercase", letterSpacing: 2, textAlign: "center" }}>
          {stageDateBits.join(" · ")}
        </span>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 48 * scale, width: "100%", marginTop: 14 * scale }}>
        {teamBox(teamA, aWins, winnerId === teamA?.id, Boolean(winnerId))}
        <div style={{ display: "flex", alignItems: "center", gap: 28 * scale, fontSize: 160 * scale * logoBoost, fontWeight: 700, lineHeight: 1 }}>
          <span style={{ color: winnerId === teamA?.id ? SIGNAL : "#ffffff" }}>{aWins}</span>
          <span style={{ color: "#ffffff33", fontSize: 90 * scale * logoBoost }}>–</span>
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
            paddingTop: marginY,
            paddingBottom: marginY,
            paddingLeft: marginX,
            paddingRight: marginX,
          }}
        >
          {/* Top and bottom safe-space, explicitly verified against the real
              overlap bug (footer text cutting through the last ban row's
              labels in both orientations): the OLD footer used `marginTop:
              "auto"` to float to the bottom of this column. That only
              reserves space when the column has genuine leftover height —
              on a match with a full 5-pick/5-ban row for both teams, the
              content group below can grow tall enough that there's no
              leftover space left, so `auto` resolves to 0 and the footer
              renders flush against (and on a still-taller render, painted
              over) the last content row instead of below it.
              The fix: everything ABOVE the footer (accent bar, header,
              score/picks content) now lives in its own `flex: 1` region
              with `overflow: "hidden"`. Because this region's parent
              (the padded column above) has a definite height (the fixed
              ImageResponse canvas), `flex: 1` here resolves correctly —
              same reasoning already established for the landscape pick
              columns' `flex: 1` above. That reserves the footer's own
              height FIRST (the footer is a normal, non-growing flex child
              sized after this region), guaranteeing a real gap between
              content and footer on every render; on the rare
              longer-than-usual match this clips excess content at the
              bottom of the region instead of overlapping the footer —
              clipped is a strictly safer failure mode than illegible
              overlapping text.
              Top clearance was checked too, not just assumed: the header
              row (accent bar + logo/"Match recap" line) sits directly
              below `marginY` of top padding with nothing else competing
              for that space, so it already had adequate top safe-space in
              both orientations before this change — left as-is. */}
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
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
                reference layouts rather than scaling one design uniformly.
                Top-anchored (not `justifyContent: "center"` inside a grown
                flex container) — centering a content block shorter than the
                available height left a large dead gap above the tournament
                line on a real render; a fixed top offset plus generous
                between-section gaps fills the frame in a way that's
                predictable regardless of how much content each match has. */}
            <div style={{ display: "flex", flexDirection: "column", gap: isLandscape ? 64 * scale : 56 * scale, marginTop: 56 * scale }}>
              {scoreBar}
              {finalPicksBlock}
            </div>
          </div>

          {/* Footer is now a plain (non-growing) flex child that always
              renders right after the `flex: 1` region above, i.e. always
              `marginY` above the canvas's bottom edge regardless of how
              tall the content above is — see the safe-space comment above
              for why this replaced the old `marginTop: "auto"` approach. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderTop: "1px solid #ffffff1a",
              paddingTop: 20 * scale,
              marginTop: 28 * scale,
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
      `id, format, stage, scheduled_at, status, series_winner_team_id, update_source,
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
  // Only Hot (OCR-tracked) matches ever get a per-pick player_id logged
  // against a KDA row — Liquipedia-synced picks never carry one — so
  // gating on update_source here is really just an optimization; the
  // player_id join below would come back empty for a Normal match anyway.
  const isHotMatch = match.update_source === "local_ocr";

  if (games && games.length > 0) {
    // Use the LATEST game that actually has a draft logged — not simply the
    // last game. During a live series the current (final) game often has no
    // picks yet (or a Normal match's placeholder game has none), and keying off
    // that blanked the recap's picks/bans entirely. Fetch picks for every game,
    // then take the last game (in play order) that has any.
    const gameIds = games.map((g) => g.id);
    const { data: allPicksAndBans } = await supabase
      .from("hero_picks_bans")
      .select("game_id, team_id, hero_name, type, pick_order, player_id, hero:heroes(icon_url)")
      .in("game_id", gameIds)
      .in("type", ["pick", "ban"])
      .order("pick_order");
    let draftGameId: string | null = null;
    for (const g of games) {
      if ((allPicksAndBans ?? []).some((p) => p.game_id === g.id)) draftGameId = g.id;
    }
    const picksAndBans = (allPicksAndBans ?? []).filter((p) => p.game_id === draftGameId);

    let kdaByPlayerId = new Map<string, { kills: number | null; deaths: number | null; assists: number | null }>();
    if (isHotMatch && draftGameId) {
      const { data: stats } = await supabase
        .from("player_stats")
        .select("player_id, kills, deaths, assists")
        .eq("game_id", draftGameId);
      kdaByPlayerId = new Map((stats ?? []).filter((s) => s.player_id).map((s) => [s.player_id as string, s]));
    }

    heroPicks = (picksAndBans ?? []).map((p) => {
      const hero = Array.isArray(p.hero) ? p.hero[0] : p.hero;
      const kda = p.player_id ? kdaByPlayerId.get(p.player_id) : undefined;
      return {
        team_id: p.team_id,
        hero_name: p.hero_name,
        icon_url: proxied(origin, hero?.icon_url),
        type: p.type as "pick" | "ban",
        kills: kda?.kills,
        deaths: kda?.deaths,
        assists: kda?.assists,
      };
    });
  }

  return renderCard({
    match: {
      format: match.format,
      stage: match.stage,
      scheduled_at: match.scheduled_at,
      series_winner_team_id: match.series_winner_team_id,
      tournament,
      team_a: teamA,
      team_b: teamB,
    },
    games: games ?? [],
    heroPicks,
    ratio,
    logoUrl,
  });
}
