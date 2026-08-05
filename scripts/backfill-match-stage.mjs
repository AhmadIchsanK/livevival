// Livevival — one-time backfill: fills `matches.stage` for existing rows
// that predate stage derivation.
//
// import-liquipedia-matches.mjs derives a `stage` label (e.g. "Regular
// Season", "Playoffs") from the subpage a match's popup was found on (see
// deriveStageFromPage() there), but only applies it when INSERTING a brand
// new match row — never on UPDATE of an existing one, specifically so a
// re-import can't silently clobber a hand-edited stage value (see the
// comment on that branch). Every match row already in the table predates
// that feature, so every single one is always hit via the UPDATE branch and
// none of them have ever gotten a stage from it — confirmed via direct SQL:
// all 1316 rows in `matches` have stage IS NULL. Since the regular
// recurring import will never backfill these by design, this script exists
// to do it once, deliberately, for rows that are still null (and only
// those — it never touches a row that already has a stage, whether from a
// hand-edit or a previous run of this same script, so it's safe to re-run).
//
// Reuses import-liquipedia-matches.mjs's own getTournamentPages(),
// extractMatches(), and deriveStageFromPage() (exported from there) rather
// than duplicating that parsing — this script just re-runs the same
// page-discovery + extraction + stage-derivation pass and re-associates
// each extracted match back to its existing DB row instead of inserting.
//
// Re-association strategy: identical composite key already used everywhere
// else in this codebase for a match — `${tournament.liquipedia_slug}__
// ${teamAId}__${teamBId}__${m.timestamp}` — computed the same way
// (resolving each team name to its `teams.id` first) and looked up against
// `matches.liquipedia_match_key`. If that row exists and its `stage` is
// still null, and this pass derived a non-null stage for it, set it. Never
// insert a new row here — only tournaments with at least one existing
// null-stage match are processed in the first place, and any match this
// pass doesn't find a DB row for is simply skipped.
//
// Paced the same as import-liquipedia-matches.mjs: 2s between page fetches
// within a tournament, 5s between tournaments (see sleep() calls below) —
// same Liquipedia API Terms of Use headroom, just reused rather than
// reinvented. Given ~150 tournaments could plausibly need re-fetching, this
// may not finish in one GH Actions run; that's fine, it's safe to just
// re-trigger later — only tournaments that still have a null-stage match
// left get reprocessed on the next run.

import { createClient } from "@supabase/supabase-js";
import { sleep, fetchRenderedPage } from "./_liquipedia.mjs";
import { getTournamentPages, extractMatches, deriveStageFromPage } from "./import-liquipedia-matches.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Read-only lookup — this backfill only ever fills `stage` on rows that
// already exist, so a team name it can't resolve to an existing `teams.id`
// just means the composite key can't be built and that extracted match is
// skipped (never worth creating a team row for a field this incidental).
const teamIdCache = new Map();
async function getExistingTeamId(name) {
  const key = name.trim().toLowerCase();
  if (teamIdCache.has(key)) return teamIdCache.get(key);

  const { data } = await supabase
    .from("teams")
    .select("id")
    .ilike("name", name.trim())
    .maybeSingle();

  const id = data?.id ?? null;
  teamIdCache.set(key, id);
  return id;
}

async function backfillTournament(tournament) {
  const pages = await getTournamentPages(tournament);
  // pages[0] is always the tournament's own base page — deriveStageFromPage()
  // always returns null for it (see that function), so it can never
  // contribute a stage to fill in here. Skip fetching it entirely; only the
  // subpages (if any were discovered) are worth a request for this backfill.
  const subpages = pages.slice(1);
  console.log(`[${tournament.name}] checking ${subpages.length} subpage(s): ${subpages.join(", ") || "(none found)"}`);

  const found = [];
  for (let i = 0; i < subpages.length; i++) {
    try {
      const html = await fetchRenderedPage(subpages[i]);
      const stage = deriveStageFromPage(tournament.liquipedia_slug, subpages[i]);
      if (stage) found.push(...extractMatches(html).map((m) => ({ ...m, stage })));
    } catch (err) {
      console.error(`[${tournament.name}] failed fetching "${subpages[i]}": ${err.message}`);
    }
    if (i < subpages.length - 1) await sleep(2000); // same pacing as import-liquipedia-matches.mjs
  }
  console.log(`[${tournament.name}] found ${found.length} match(es) with a derivable stage`);

  let filled = 0;
  for (const m of found) {
    const teamAId = await getExistingTeamId(m.teamAName);
    const teamBId = await getExistingTeamId(m.teamBName);
    if (!teamAId || !teamBId) continue; // no existing DB row could possibly match

    const key = `${tournament.liquipedia_slug}__${teamAId}__${teamBId}__${m.timestamp}`;

    const { data: existing, error } = await supabase
      .from("matches")
      .select("id, stage")
      .eq("liquipedia_match_key", key)
      .maybeSingle();
    if (error) {
      console.error(`[${tournament.name}] lookup failed for ${key}: ${error.message}`);
      continue;
    }
    if (!existing || existing.stage !== null) continue; // no match, or already has a stage — never clobber

    const { error: updErr } = await supabase.from("matches").update({ stage: m.stage }).eq("id", existing.id);
    if (updErr) {
      console.error(`[${tournament.name}] failed to set stage on match ${existing.id}: ${updErr.message}`);
    } else {
      filled++;
    }
  }
  console.log(`[${tournament.name}] filled stage on ${filled} match row(s)`);
}

// Supabase/PostgREST caps a single select at 1000 rows by default — with
// all 1316 matches in the table currently stage IS NULL, a single
// unpaginated select here would silently truncate and miss real gap rows.
// Paged explicitly so this always sees every null-stage row regardless of
// how many there are.
async function getAllNullStageTournamentIds() {
  const ids = new Set();
  const PAGE_SIZE = 1000;
  let from = 0;
  let total = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("matches")
      .select("tournament_id")
      .is("stage", null)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      total++;
      if (row.tournament_id) ids.add(row.tournament_id);
    }
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { tournamentIds: [...ids], total };
}

async function main() {
  const { tournamentIds, total } = await getAllNullStageTournamentIds();
  console.log(`${total} match row(s) with stage IS NULL, across ${tournamentIds.length} tournament(s)`);
  if (tournamentIds.length === 0) return;

  const { data: tournaments, error: tourErr } = await supabase
    .from("tournaments")
    .select("id, name, liquipedia_slug")
    .in("id", tournamentIds);
  if (tourErr) throw tourErr;

  const relevant = (tournaments ?? []).filter((t) => t.liquipedia_slug);
  console.log(`Processing ${relevant.length} tournament(s) with a liquipedia_slug`);

  for (const t of relevant) {
    try {
      await backfillTournament(t);
    } catch (err) {
      console.error(`[${t.name}] failed:`, err.message);
    }
    await sleep(5000); // same pacing as import-liquipedia-matches.mjs
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
