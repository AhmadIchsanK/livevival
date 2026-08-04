// Livevival — reconciles a single Hot (OCR-tracked) match's hero picks/bans
// against Liquipedia's own bracket-page record when an admin flags a
// discrepancy (wrong hero logged during a live draft, a mis-click, etc.).
//
// Scope is deliberately narrow: this ONLY ever reads and writes
// hero_picks_bans rows for the one match passed in via MATCH_ID. It never
// touches player_stats (kills/deaths/assists), key_moments, games.state,
// games.winner_team_id, matches.state, matches.series_winner_team_id, or
// vod_url — all of those stay Hot-match/OCR-authoritative regardless of
// what Liquipedia says, per the owner's own framing: "Only Kill points and
// moment list that's absolute from Hot match." Only which HERO was
// picked/banned is ever corrected here.
//
// Reconciliation is done by POSITION within each (game, team, pick|ban)
// group, not delete-all-then-reinsert — an admin may have already assigned
// a player_id to a pick row via the live console's "assign hero to player"
// step (Liquipedia's bracket popup has no player attribution at all), and
// a blind delete+reinsert would silently wipe that out even when the hero
// name itself was already correct. Updating an existing row's hero_name
// in place (same row id, same player_id) only touches rows that actually
// disagree with Liquipedia.
//
// Reuses the same page-discovery and HTML-parsing logic as the routine
// Liquipedia sync (extractFinishedMatches from import-finished-match-
// details.mjs, discoverStagePages from refresh-finished-match-details.mjs)
// instead of a third copy — this project has twice already shipped a bug
// from two near-identical scrapers drifting out of sync (see
// finishedMatchSync.mjs's match_id fix), so sharing beats re-deriving.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage, sleep } from "./_liquipedia.mjs";
import { extractFinishedMatches } from "./import-finished-match-details.mjs";
import { discoverStagePages } from "./refresh-finished-match-details.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

let heroIdByName = null;
async function heroIdFor(heroName) {
  if (!heroIdByName) {
    const { data } = await supabase.from("heroes").select("id, name");
    heroIdByName = new Map((data ?? []).map((h) => [h.name, h.id]));
  }
  return heroIdByName.get(heroName) ?? null;
}

const norm = (s) => (s ?? "").trim().toLowerCase();

// Finds this match's popup among every candidate page's finished matches —
// same team-pair + closest-timestamp disambiguation as findMatch() in
// import-finished-match-details.mjs, just matched against a match row we
// already have (no team-name-to-id lookup needed, we already have the ids).
function findScrapedMatch(candidates, teamAName, teamBName, scheduledAt) {
  const pairMatches = candidates.filter((m) => {
    const left = norm(m.leftName);
    const right = norm(m.rightName);
    return (left === norm(teamAName) && right === norm(teamBName)) || (left === norm(teamBName) && right === norm(teamAName));
  });
  if (pairMatches.length === 0) return null;
  if (pairMatches.length === 1) return pairMatches[0];
  if (!scheduledAt) return pairMatches[0];

  const targetMs = new Date(scheduledAt).getTime();
  let closest = pairMatches[0];
  let closestDiff = Infinity;
  for (const m of pairMatches) {
    if (!m.timestamp) continue;
    const diff = Math.abs(m.timestamp * 1000 - targetMs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = m;
    }
  }
  return closest;
}

// Loops every candidate page (top-level + discovered stage subpages) for a
// tournament until it finds this specific team pair's finished-match popup.
// Shared by the on-demand single-match reconciliation below and by
// sync-hot-matches-cron.mjs's every-eligible-match sweep, so the fetch/
// disambiguation logic only lives in one place.
export async function findMatchOnLiquipedia(tournamentSlug, teamAName, teamBName, scheduledAt) {
  const candidatePages = [tournamentSlug, ...(await discoverStagePages(tournamentSlug))];
  for (const page of candidatePages) {
    const html = await fetchRenderedPage(page);
    const $ = cheerio.load(html);
    const finished = extractFinishedMatches($);
    const found = findScrapedMatch(finished, teamAName, teamBName, scheduledAt);
    if (found) return found;
    await sleep(4000);
  }
  return null;
}

// Reconciles one (game, team, pick|ban) group by position — see module
// comment for why this updates-in-place instead of delete+reinsert.
export async function reconcileGroup(gameId, matchId, teamId, type, scrapedHeroNames) {
  const { data: existing, error } = await supabase
    .from("hero_picks_bans")
    .select("id, hero_name, pick_order, created_at")
    .eq("game_id", gameId)
    .eq("team_id", teamId)
    .eq("type", type)
    .order("pick_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`Failed reading existing ${type}s for game ${gameId} team ${teamId}:`, error.message);
    return { corrected: 0, added: 0, removed: 0 };
  }

  const rows = existing ?? [];
  let corrected = 0;
  let added = 0;
  let removed = 0;
  const maxLen = Math.max(rows.length, scrapedHeroNames.length);

  for (let i = 0; i < maxLen; i++) {
    const row = rows[i];
    const scrapedName = scrapedHeroNames[i];

    if (row && scrapedName) {
      if (norm(row.hero_name) !== norm(scrapedName)) {
        const { error: updateError } = await supabase
          .from("hero_picks_bans")
          .update({ hero_name: scrapedName, hero_id: await heroIdFor(scrapedName) })
          .eq("id", row.id);
        if (updateError) {
          console.error(`Failed correcting ${type} row ${row.id}:`, updateError.message);
        } else {
          console.log(`  Corrected ${type}: "${row.hero_name}" -> "${scrapedName}"`);
          corrected++;
        }
      }
    } else if (!row && scrapedName) {
      const { error: insertError } = await supabase.from("hero_picks_bans").insert({
        game_id: gameId,
        match_id: matchId,
        team_id: teamId,
        hero_name: scrapedName,
        hero_id: await heroIdFor(scrapedName),
        type,
        pick_order: i,
      });
      if (insertError) {
        console.error(`Failed adding missing ${type} "${scrapedName}":`, insertError.message);
      } else {
        console.log(`  Added missing ${type}: "${scrapedName}"`);
        added++;
      }
    } else if (row && !scrapedName) {
      const { error: deleteError } = await supabase.from("hero_picks_bans").delete().eq("id", row.id);
      if (deleteError) {
        console.error(`Failed removing extra ${type} "${row.hero_name}":`, deleteError.message);
      } else {
        console.log(`  Removed extra ${type} not on Liquipedia: "${row.hero_name}"`);
        removed++;
      }
    }
  }

  return { corrected, added, removed };
}

export async function syncHotMatchPicksBans(matchId) {
  const { data: match, error } = await supabase
    .from("matches")
    .select(
      `id, update_source, scheduled_at,
       tournament:tournaments(liquipedia_slug),
       team_a:teams!matches_team_a_id_fkey(id, name),
       team_b:teams!matches_team_b_id_fkey(id, name)`
    )
    .eq("id", matchId)
    .single();
  if (error || !match) {
    throw new Error(`Match ${matchId} not found: ${error?.message ?? "no row"}`);
  }
  if (match.update_source !== "local_ocr") {
    console.log(`Match ${matchId} is not a Hot match (update_source="${match.update_source}") — the routine Liquipedia sync already keeps it current, nothing to reconcile here.`);
    return;
  }

  const tournament = Array.isArray(match.tournament) ? match.tournament[0] : match.tournament;
  const teamA = Array.isArray(match.team_a) ? match.team_a[0] : match.team_a;
  const teamB = Array.isArray(match.team_b) ? match.team_b[0] : match.team_b;
  if (!tournament?.liquipedia_slug || !teamA || !teamB) {
    throw new Error(`Match ${matchId} is missing tournament/team data needed to look it up on Liquipedia.`);
  }

  console.log(`Looking up ${teamA.name} vs ${teamB.name} on Liquipedia (${tournament.liquipedia_slug})...`);
  const scrapedMatch = await findMatchOnLiquipedia(tournament.liquipedia_slug, teamA.name, teamB.name, match.scheduled_at);

  if (!scrapedMatch) {
    console.log(`No finished-match record found on Liquipedia yet for ${teamA.name} vs ${teamB.name} — nothing to reconcile against.`);
    return;
  }

  const leftIsTeamA = norm(scrapedMatch.leftName) === norm(teamA.name);
  const teamAScrapedSide = (g) => (leftIsTeamA ? g.left : g.right);
  const teamBScrapedSide = (g) => (leftIsTeamA ? g.right : g.left);
  const teamAScrapedBans = (g) => (leftIsTeamA ? g.leftBans : g.rightBans);
  const teamBScrapedBans = (g) => (leftIsTeamA ? g.rightBans : g.leftBans);

  const totals = { corrected: 0, added: 0, removed: 0 };
  for (const g of scrapedMatch.games) {
    const { data: gameRow } = await supabase
      .from("games")
      .select("id")
      .eq("match_id", matchId)
      .eq("game_number", g.gameNumber)
      .maybeSingle();
    if (!gameRow) {
      console.log(`No game ${g.gameNumber} row recorded for this match yet — skipping (nothing to reconcile).`);
      continue;
    }

    const groups = [
      [teamA.id, "pick", teamAScrapedSide(g)?.picks ?? []],
      [teamB.id, "pick", teamBScrapedSide(g)?.picks ?? []],
      [teamA.id, "ban", teamAScrapedBans(g) ?? []],
      [teamB.id, "ban", teamBScrapedBans(g) ?? []],
    ];
    for (const [teamId, type, scrapedNames] of groups) {
      const result = await reconcileGroup(gameRow.id, matchId, teamId, type, scrapedNames);
      totals.corrected += result.corrected;
      totals.added += result.added;
      totals.removed += result.removed;
    }
  }

  console.log(`Done: ${totals.corrected} corrected, ${totals.added} added, ${totals.removed} removed. player_stats, key_moments, and match/game state were not touched.`);
}

async function main() {
  const matchId = process.env.MATCH_ID || process.argv[2];
  if (!matchId) {
    console.error("Usage: MATCH_ID=<uuid> node scripts/sync-hot-match-picks-bans.mjs");
    process.exit(1);
  }
  await syncHotMatchPicksBans(matchId);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
