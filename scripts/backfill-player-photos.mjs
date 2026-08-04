// Livevival — one-time backfill: gives players their own Liquipedia photo
// where one exists.
//
// import-team-details.mjs only ever inserted ign/role/team_id — it never
// captured a player's own Liquipedia page slug, so there was no way to
// fetch an individual photo for any of the 1620 rows (confirmed: 0/1620
// had photo_url or liquipedia_slug set). That importer now also captures
// each roster row's slug (from the roster table's own player link) at zero
// extra request cost, since it already fetches the team page once — this
// script just needs to (a) run that same team-page fetch again for any
// team with players still missing a slug, to actually populate it, then
// (b) fetch each now-slugged player's own page for their infobox photo.
//
// Two phases, same idempotent/re-runnable/small-retry-budget shape as
// backfill-hero-icons.mjs: a sustained Liquipedia throttle window can
// still eat a chunk of any single run, but re-running only ever touches
// rows still missing data, so repeated triggers converge on "done" instead
// of duplicating work.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage, sleep } from "./_liquipedia.mjs";
import { fetchTeamPage, extractActiveRoster, upsertPlayerRole } from "./import-team-details.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Matches backfill-hero-icons.mjs's rationale exactly: a sustained
// throttle window (not just one transient 429) showed up in real job logs
// for this same Liquipedia wiki. Capping the per-call retry budget here
// means one stuck player/team can't burn the whole job timeout — it moves
// on and gets mopped up on a later run instead.
const BACKFILL_MAX_RETRIES = 2;

async function fetchPlayerPortrait(title) {
  const html = await fetchRenderedPage(title, 1, BACKFILL_MAX_RETRIES);
  const $ = cheerio.load(html);
  let src = $(".infobox-image.lightmode img").first().attr("src");
  if (!src) src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
}

async function backfillSlugs() {
  const { data: players, error } = await supabase
    .from("players")
    .select("id, team_id")
    .is("liquipedia_slug", null)
    .not("team_id", "is", null);
  if (error) throw error;

  const teamIds = Array.from(new Set(players.map((p) => p.team_id)));
  console.log(`Phase 1: ${teamIds.length} team(s) with at least one un-slugged player`);

  const { data: teams, error: teamsError } = await supabase
    .from("teams")
    .select("id, name, liquipedia_slug")
    .in("id", teamIds);
  if (teamsError) throw teamsError;

  for (const team of teams) {
    const slug = team.liquipedia_slug || team.name.trim().replace(/ /g, "_");
    try {
      const page = await fetchTeamPage(slug, 1, BACKFILL_MAX_RETRIES);
      if (!page) {
        console.warn(`No Liquipedia page for "${team.name}" — skipping`);
      } else {
        const $ = cheerio.load(page.html);
        const roster = extractActiveRoster($);
        for (const p of roster) {
          await upsertPlayerRole(team.id, p.ign, p.role, p.slug);
        }
        console.log(`${team.name}: ${roster.filter((p) => p.slug).length}/${roster.length} roster row(s) slugged`);
      }
    } catch (err) {
      console.error(`Failed processing team "${team.name}":`, err.message);
    }
    await sleep(4000);
  }
}

async function backfillPhotos() {
  const { data: players, error } = await supabase
    .from("players")
    .select("id, ign, liquipedia_slug")
    .is("photo_url", null)
    .not("liquipedia_slug", "is", null);
  if (error) throw error;

  console.log(`Phase 2: ${players.length} slugged player(s) missing a photo`);

  for (const p of players) {
    const title = p.liquipedia_slug.replace(/_/g, " ");
    try {
      const photoUrl = await fetchPlayerPortrait(title);
      if (photoUrl) {
        const { error: updateError } = await supabase.from("players").update({ photo_url: photoUrl }).eq("id", p.id);
        if (updateError) console.error(`Failed to save photo for "${p.ign}":`, updateError.message);
        else console.log(`${p.ign}: photo found`);
      } else {
        console.log(`${p.ign}: no infobox photo on their page`);
      }
    } catch (err) {
      console.error(`Failed processing "${p.ign}":`, err.message);
    }
    await sleep(4000);
  }
}

async function main() {
  await backfillSlugs();
  await backfillPhotos();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
