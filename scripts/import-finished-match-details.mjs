// Livevival — imports finished-match detail (per-game VOD links, winners,
// champion picks, bans, and map) from a tournament's Liquipedia bracket page.
//
// Structure this relies on — confirmed against real Liquipedia bracket-page
// HTML (the owner pasted a live tournament page directly; the previous
// version of this comment claimed the same "confirmed against a real api.php
// response" but was actually a hand-built guess that turned out wrong in a
// way that only showed up on real data — see below):
//
//   .brkts-popup-container.brkts-match-info-popup   one block per match
//     .timer-object[data-timestamp][data-finished]  schedule + completion
//     .match-info-header-opponent(-left)             the two team names;
//       "-left" marks the LEFT side. Side (left/right) is the reliable way
//       to attribute picks/bans to a physical team — do NOT assume the
//       left side always won or always picks first.
//     .match-info-header-scoreholder-lower            "(BoX)" format tag
//
//     Picks — one row PER GAME, both sides together (NOT one row per team
//     per game — that was the bug: the old version paired up consecutive
//     rows two-at-a-time and, within each row, only ever read the first
//     .brkts-champion-icon/.generic-label it found, which is always the
//     LEFT side — so every game's RIGHT side picks and result were
//     silently dropped, and a 2-game series produced 1 merged "game" while
//     an N-game series' row count got halved and misattributed):
//     .brkts-popup-body-grid-row
//       .generic-label[data-label-type]  (1st = left result, 2nd = right
//         result, in document order — "result-win"|"result-loss")
//       .brkts-popup-body-grid-row-detail
//         .brkts-champion-icon (no "-right")     left side's 5 picks
//         .brkts-popup-spaced                    game duration text (e.g. "17:08")
//         .brkts-champion-icon.brkts-popup-body-element-thumbs-right   right side's 5 picks
//       .brkts-popup-comment > b   map name, when Liquipedia records one
//
//     Bans — one row PER GAME (both teams together), inside a collapsed
//     panel that's still present in the static HTML:
//     .brkts-popup-veto-wrapper .brkts-popup-veto-row
//       first  .brkts-champion-icon (no "-right" class) = LEFT team's bans
//       second .brkts-champion-icon.brkts-popup-body-element-thumbs-right
//              = RIGHT team's bans
//       rows appear in game order (row 1 = game 1, row 2 = game 2, ...)
//       — this part of the original comment was correct, only the picks
//       section above was wrong.
//
//     .brkts-popup-footer .plainlinks.vodlink a[href][title="Watch Game N"]
//       per-game VOD link. Multiple games can share one base video with a
//       "?&=<seconds>" offset instead of separate URLs — both are stored
//       as-is, either way the site can link straight to the right moment.
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, 2s between requests, only ever calls api.php.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export function heroesIn($, containerEl) {
  return $(containerEl)
    .find("a[title]")
    .map((_, a) => $(a).attr("title"))
    .get();
}

/**
 * Parses every finished match popup out of a rendered bracket page.
 * @returns {Array<object>} one entry per finished match
 */
export function extractFinishedMatches($) {
  const matches = [];

  $(".brkts-popup-container.brkts-match-info-popup").each((_, el) => {
    const $popup = $(el);
    const timer = $popup.find(".timer-object").first();
    if (timer.attr("data-finished") === undefined) return; // only finished matches

    const teamLeft = $popup.find(".match-info-header-opponent-left");
    const teamRight = $popup.find(".match-info-header-opponent").not(teamLeft);
    const leftName = teamLeft.find(".name.hidden-xs").first().text().trim();
    const rightName = teamRight.find(".name.hidden-xs").first().text().trim();
    if (!leftName || !rightName) return;

    const leftWon = teamLeft.hasClass("match-info-header-winner");
    const format = $popup.find(".match-info-header-scoreholder-lower").text().trim().replace(/[()]/g, "");

    // ── Picks: one row per game, both sides together — see module comment.
    const gamesByNumber = new Map();
    $popup.find(".brkts-popup-body-grid-row").each((idx, row) => {
      const $row = $(row);
      const gameNumber = idx + 1;
      const labels = $row.find(".generic-label");
      const leftIcon = $row.find(".brkts-champion-icon").not(".brkts-popup-body-element-thumbs-right").first();
      const rightIcon = $row.find(".brkts-champion-icon.brkts-popup-body-element-thumbs-right").first();
      const map = $row.find(".brkts-popup-comment b").first().text().trim() || null;

      gamesByNumber.set(gameNumber, {
        gameNumber,
        left: { picks: heroesIn($, leftIcon), won: labels.eq(0).attr("data-label-type") === "result-win" },
        right: { picks: heroesIn($, rightIcon), won: labels.eq(1).attr("data-label-type") === "result-win" },
        map,
      });
    });

    // ── Bans: one row per game, both sides together.
    $popup.find(".brkts-popup-veto-wrapper .brkts-popup-veto-row").each((rowIndex, row) => {
      const $row = $(row);
      const gameNumber = rowIndex + 1;
      const rightIcon = $row.find(".brkts-champion-icon.brkts-popup-body-element-thumbs-right").first();
      const leftIcon = $row.find(".brkts-champion-icon").not(".brkts-popup-body-element-thumbs-right").first();

      const game = gamesByNumber.get(gameNumber) ?? { gameNumber, left: null, right: null };
      game.leftBans = heroesIn($, leftIcon);
      game.rightBans = heroesIn($, rightIcon);
      gamesByNumber.set(gameNumber, game);
    });

    // ── VOD links, in "Watch Game N" order.
    const vods = {};
    $popup.find(".brkts-popup-footer .plainlinks.vodlink").each((_, span) => {
      const $span = $(span);
      const title = $span.attr("title") ?? "";
      const m = title.match(/Watch Game (\d+)/i);
      const href = $span.find("a[href]").attr("href");
      if (m && href) vods[Number(m[1])] = href;
    });

    matches.push({
      leftName,
      rightName,
      leftWon,
      format,
      timestamp: Number(timer.attr("data-timestamp")) || null,
      games: Array.from(gamesByNumber.values()).sort((a, b) => a.gameNumber - b.gameNumber),
      vods,
    });
  });

  return matches;
}

async function findTeamId(name) {
  const { data } = await supabase.from("teams").select("id").ilike("name", name.trim()).maybeSingle();
  return data?.id ?? null;
}

// Same two teams can face off more than once in one tournament (a
// round-robin group stage, or a group-stage + playoff rematch) — confirmed
// against real data: Team Vamos vs Team Spirit played twice in MSC/2026,
// which made this query's old `.maybeSingle()` return 2 rows and error out
// on every single run (the error was silently discarded since only `data`
// was destructured), permanently skipping BOTH matches with "no existing
// match row" even though both existed. Disambiguate multiple candidates
// using the popup's own scraped kickoff timestamp against each candidate's
// scheduled_at instead of assuming the pairing is unique.
async function findMatch(tournamentId, leftName, rightName, matchTimestamp) {
  const leftId = await findTeamId(leftName);
  const rightId = await findTeamId(rightName);
  if (!leftId || !rightId) return null;

  const { data, error } = await supabase
    .from("matches")
    .select("id, format, team_a_id, team_b_id, scheduled_at")
    .eq("tournament_id", tournamentId)
    .or(
      `and(team_a_id.eq.${leftId},team_b_id.eq.${rightId}),and(team_a_id.eq.${rightId},team_b_id.eq.${leftId})`
    );

  if (error) {
    console.error(`Failed looking up match for ${leftName} vs ${rightName}:`, error.message);
    return null;
  }
  if (!data || data.length === 0) return null;
  if (data.length === 1) return { ...data[0], leftId, rightId };

  if (!matchTimestamp) {
    console.warn(`Multiple match rows for ${leftName} vs ${rightName} in this tournament and no timestamp to disambiguate — skipping`);
    return null;
  }
  const targetMs = matchTimestamp * 1000;
  let closest = data[0];
  let closestDiff = Infinity;
  for (const row of data) {
    if (!row.scheduled_at) continue;
    const diff = Math.abs(new Date(row.scheduled_at).getTime() - targetMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = row;
    }
  }
  return { ...closest, leftId, rightId };
}

// Liquipedia's bracket picks/bans popup only ever exposes a hero NAME per
// slot (see heroesIn() above — reads a[title], nothing else), never a
// player attribution, so hero_id is the only extra thing recoverable here.
// hero_name is already the exact Liquipedia page title (same source
// import-liquipedia-heroes.mjs uses for heroes.name), confirmed against
// production data to match heroes.name by plain equality with zero misses
// — no fuzzy/normalize matching needed.
let heroIdByName = null;
async function heroIdFor(heroName) {
  if (!heroIdByName) {
    const { data } = await supabase.from("heroes").select("id, name");
    heroIdByName = new Map((data ?? []).map((h) => [h.name, h.id]));
  }
  return heroIdByName.get(heroName) ?? null;
}

async function insertPicksAndBans(gameId, side, teamId, matchId) {
  const insertAll = async (heroes, type) => {
    for (const heroName of heroes ?? []) {
      const { error } = await supabase.from("hero_picks_bans").insert({
        game_id: gameId,
        match_id: matchId,
        team_id: teamId,
        hero_name: heroName,
        hero_id: await heroIdFor(heroName),
        type,
      });
      if (error && !error.message.includes("duplicate key")) {
        console.error(`Failed to log ${type} ${heroName}:`, error.message);
      }
    }
  };
  if (side.picks) await insertAll(side.picks, "pick");
  if (side.bans) await insertAll(side.bans, "ban");
}

async function importMatchDetail(tournamentId, m) {
  const match = await findMatch(tournamentId, m.leftName, m.rightName, m.timestamp);
  if (!match) {
    console.warn(`No existing match row for ${m.leftName} vs ${m.rightName} — skipping (run the schedule importer first)`);
    return;
  }

  const seriesWinnerTeamId = m.leftWon ? match.leftId : match.rightId;

  await supabase.from("matches").update({
    state: "SERIES_FINISHED",
    status: "finished",
    series_winner_team_id: seriesWinnerTeamId,
  }).eq("id", match.id);

  for (const g of m.games) {
    // Per-game winner comes from that game's own result-win label, NOT
    // assumed from the series winner — correctly handles reverse sweeps.
    const gameWinnerTeamId = g.left?.won ? match.leftId : g.right?.won ? match.rightId : null;

    // Only include vod_url in the upsert when this game hasn't been
    // manually overridden — PostgREST's upsert only touches the columns
    // present in the payload, so omitting vod_url here leaves an admin's
    // manual link alone instead of clobbering it with whatever (or
    // nothing) Liquipedia currently shows for this game.
    const { data: existingGame } = await supabase
      .from("games")
      .select("vod_url_source")
      .eq("match_id", match.id)
      .eq("game_number", g.gameNumber)
      .maybeSingle();
    const isManualVod = existingGame?.vod_url_source === "manual";

    const { data: gameRow, error } = await supabase
      .from("games")
      .upsert(
        {
          match_id: match.id,
          game_number: g.gameNumber,
          state: "GAME_FINISHED",
          winner_team_id: gameWinnerTeamId,
          ...(isManualVod ? {} : { vod_url: m.vods[g.gameNumber] ?? null }),
        },
        { onConflict: "match_id,game_number" }
      )
      .select("id")
      .single();

    if (error || !gameRow) {
      console.error(`Failed to upsert game ${g.gameNumber} for match ${match.id}:`, error?.message);
      continue;
    }

    if (g.left) await insertPicksAndBans(gameRow.id, { picks: g.left.picks, bans: g.leftBans }, match.leftId, match.id);
    if (g.right) await insertPicksAndBans(gameRow.id, { picks: g.right.picks, bans: g.rightBans }, match.rightId, match.id);
  }

  console.log(`Imported ${m.leftName} vs ${m.rightName}: ${m.games.length} game(s), picks + bans + winners recorded`);
}

// tournamentId, when passed by a caller that already knows it (e.g.
// refresh-finished-match-details.mjs, which resolves it once per tournament
// and reuses it across every stage subpage), skips the lookup below entirely.
//
// THE BUG this fixes: this function used to resolve tournamentId by looking
// up `tournaments.liquipedia_slug === pageTitle` — which only ever matches
// when pageTitle is a tournament's own top-level slug. Every stage subpage
// (e.g. "MPL/Indonesia/Season_17/Regular_Season") is NOT its own row in the
// `tournaments` table (only "MPL/Indonesia/Season_17" is), so that lookup
// always failed for subpages and logged "not found in DB — run the
// tournament importer first" — which was actively misleading, since the
// tournament importer had already run and the subpage's matches already
// existed in `matches` (tournament_id pointing at the parent). Confirmed via
// real job logs: refresh-finished-match-details.mjs discovers subpages fine
// (discoverStagePages) and calls importTournament(page) once per subpage,
// but every one of those calls hit exactly this dead end — silently
// limiting every multi-page tournament to whatever small inline bracket (if
// any) renders on the top-level page itself, e.g. MPL Indonesia Season 17
// only ever got its 8 inline playoff matches' details while the 72 real
// regular-season matches (which live entirely on the /Regular_Season
// subpage) never got picks/bans/VODs/winners at all — accounting for the
// large majority of the ~800 finished matches found with zero `games` rows
// despite this job "succeeding" run after run. Even the CLI usage note
// below (`node ... "MSC/2026/Knockout_Stage"`) documents passing a subpage
// title directly, so this was broken for manual single-page runs too, not
// just the automated multi-page pass — it just never surfaced as an error,
// only ever as a skipped tournament.
//
// Fix: resolve by the LONGEST tournament slug that's a prefix of pageTitle
// (exact match included) instead of requiring pageTitle to equal a slug
// outright — this correctly maps any subpage back to its parent tournament
// row without a hardcoded subpage-name list, the same "no hardcoded names"
// principle getTournamentPages() already uses on the import-matches side.
export async function importTournament(pageTitle, tournamentId = null) {
  let resolvedId = tournamentId;

  if (!resolvedId) {
    const { data: exact } = await supabase
      .from("tournaments")
      .select("id")
      .eq("liquipedia_slug", pageTitle)
      .maybeSingle();

    if (exact) {
      resolvedId = exact.id;
    } else {
      const { data: candidates } = await supabase
        .from("tournaments")
        .select("id, liquipedia_slug")
        .not("liquipedia_slug", "is", null);
      const parent = (candidates ?? [])
        .filter((t) => pageTitle.startsWith(`${t.liquipedia_slug}/`))
        .sort((a, b) => b.liquipedia_slug.length - a.liquipedia_slug.length)[0];
      resolvedId = parent?.id ?? null;
    }
  }

  if (!resolvedId) {
    console.warn(`Tournament "${pageTitle}" not found in DB — run the tournament importer first.`);
    return;
  }

  console.log(`Fetching ${pageTitle}...`);
  const html = await fetchRenderedPage(pageTitle);
  const $ = cheerio.load(html);
  const finished = extractFinishedMatches($);
  console.log(`Found ${finished.length} finished match(es) on ${pageTitle}`);

  for (const m of finished) {
    await importMatchDetail(resolvedId, m);
  }
}

async function main() {
  const pageTitle = process.argv[2];
  if (!pageTitle) {
    console.error("Usage: node scripts/import-finished-match-details.mjs <Liquipedia_Page_Title>");
    console.error('Example: node scripts/import-finished-match-details.mjs "MSC/2026/Knockout_Stage"');
    console.error("Note: bans/picks/VODs typically live on a tournament's STAGE subpages");
    console.error('(e.g. "MSC/2026/Group_Stage", "MSC/2026/Knockout_Stage"), not always the');
    console.error("top-level tournament page — run once per stage for full coverage.");
    process.exit(1);
  }
  await importTournament(pageTitle);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
