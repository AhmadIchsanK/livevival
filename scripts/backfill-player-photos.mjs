// Livevival — one-time backfill: gives players their own Liquipedia photo,
// real name, nationality, and social links, from
// https://liquipedia.net/mobilelegends/All_Players's per-player pages.
//
// import-team-details.mjs only ever inserted ign/role/team_id — it never
// captured a player's own Liquipedia page slug, so there was no way to
// fetch an individual photo for any of the 1620 rows (confirmed: 0/1620
// had photo_url or liquipedia_slug set). That importer now also captures
// each roster row's slug (from the roster table's own player link) at zero
// extra request cost, since it already fetches the team page once — this
// script just needs to (a) run that same team-page fetch again for any
// team with players still missing a slug, to actually populate it, then
// (b) fetch each now-slugged player's own page for their infobox photo,
// name, nationality, and links.
//
// Two phases, same idempotent/re-runnable/small-retry-budget shape as
// backfill-hero-icons.mjs: a sustained Liquipedia throttle window can
// still eat a chunk of any single run, but re-running only ever touches
// rows still missing data, so repeated triggers converge on "done" instead
// of duplicating work.
//
// Phase 2's DOM selectors below were confirmed against real rendered HTML
// for 5 players (AURORAA/Argentina, Lutpiii/Indonesia, Kairi/Philippines,
// Daniel (Indonesian player)/Indonesia, Bo Ye/Myanmar) fetched through this
// same client — not guessed. Notably:
//   - Every infobox row is `<div class="infobox-cell-2 infobox-description">
//     Label:</div><div style="width:50%">Value</div>` — labels seen include
//     "Name:", "Nationality:", "Born:", "Role:", "Team:", "Status:".
//   - The nationality flag's own <img> src encodes the ISO code directly in
//     its filename ("Ar_hd.png" = Argentina/AR, "Id_hd.png" =
//     Indonesia/ID, "Ph_hd.png" = Philippines/PH, "Mm_hd.png" =
//     Myanmar/MM) — confirmed identically across all 4 distinct countries
//     in the sample, so extracting from the filename is reliable, not a
//     guess. A name->code fallback table covers the rare case a flag file
//     doesn't follow that pattern.
//   - Social links are NOT under a labeled infobox row at all — they sit in
//     a dedicated `.infobox-icons` block as `<a class="external text"
//     href="..."><i class="lp-icon lp-instagram"></i></a>`-style anchors,
//     one per platform, identified by the icon's second `lp-*` class.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import {
  fetchRenderedPage,
  sleep,
  extractCountryCodes,
  extractInfoboxIconLinks,
  getInfoboxRows,
} from "./_liquipedia.mjs";
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

// extractCountryCodes/extractInfoboxIconLinks/getInfoboxRows now live in
// _liquipedia.mjs — moved there so import-team-details.mjs's own team
// location/region/social-link extraction can reuse the exact same
// confirmed selectors instead of duplicating them (see that file's
// extractLocationAndRegion/extractSocialLinks).

async function fetchPlayerProfile(title) {
  const html = await fetchRenderedPage(title, 1, BACKFILL_MAX_RETRIES);
  const $ = cheerio.load(html);

  let photoUrl = $(".infobox-image.lightmode img").first().attr("src");
  if (!photoUrl) photoUrl = $(".infobox-image img").first().attr("src");
  if (photoUrl && !photoUrl.startsWith("http")) photoUrl = `https://liquipedia.net${photoUrl}`;

  const rows = getInfoboxRows($);
  // "Romanized Name" shows up instead of "Name" for a handful of players
  // whose native-script name Liquipedia also lists separately — either one
  // is the real name we want, "Name" just tends to be present more often.
  const realNameCell = rows.get("name") || rows.get("romanized name");
  const realName = realNameCell ? realNameCell.text().trim() || null : null;

  const nationalityCell = rows.get("nationality");
  const countryCodes = nationalityCell ? extractCountryCodes($, nationalityCell) : null;

  const links = extractInfoboxIconLinks($);

  return { photoUrl: photoUrl || null, realName, countryCodes, links };
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

async function backfillProfiles() {
  // Broadened from "photo_url is null" so a re-run also picks up players
  // that already got a photo from before real_name/country_codes/links
  // existed as columns — one fetch per player still covers all four
  // fields, so there's no extra request cost to also mopping those up.
  const { data: players, error } = await supabase
    .from("players")
    .select("id, ign, liquipedia_slug, photo_url, real_name, country_codes, links")
    .not("liquipedia_slug", "is", null)
    .or("photo_url.is.null,real_name.is.null,country_codes.is.null,links.is.null");
  if (error) throw error;

  console.log(`Phase 2: ${players.length} slugged player(s) missing photo/real_name/country_codes/links`);

  for (const p of players) {
    const title = p.liquipedia_slug.replace(/_/g, " ");
    try {
      const profile = await fetchPlayerProfile(title);

      const update = {};
      if (!p.photo_url && profile.photoUrl) update.photo_url = profile.photoUrl;
      if (!p.real_name && profile.realName) update.real_name = profile.realName;
      if (!p.country_codes && profile.countryCodes) update.country_codes = profile.countryCodes;
      if (!p.links && profile.links) update.links = profile.links;

      // Every field that came back empty this run, whether or not it was
      // already set — surfaced so a human scanning the job log can tell a
      // real gap (this player's page genuinely has no listed nationality)
      // from a broken selector (the same field is empty for everyone).
      const stillMissing = [];
      if (!profile.photoUrl) stillMissing.push("photo");
      if (!profile.realName) stillMissing.push("real_name");
      if (!profile.countryCodes) stillMissing.push("country_codes");
      if (!profile.links) stillMissing.push("links");

      if (Object.keys(update).length > 0) {
        const { error: updateError } = await supabase.from("players").update(update).eq("id", p.id);
        if (updateError) console.error(`Failed to save profile for "${p.ign}":`, updateError.message);
        else console.log(`${p.ign}: saved ${Object.keys(update).join(", ")}${stillMissing.length ? ` (page has no ${stillMissing.join("/")})` : ""}`);
      } else {
        console.log(`${p.ign}: nothing new on their page (missing: ${stillMissing.join(", ") || "none"})`);
      }
    } catch (err) {
      console.error(`Failed processing "${p.ign}":`, err.message);
    }
    await sleep(4000);
  }
}

async function main() {
  await backfillSlugs();
  await backfillProfiles();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
