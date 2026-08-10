// Livevival — the real per-player detail scraper (despite the filename):
// gives players their own Liquipedia photo, real name, nationality, social
// links, birthdate, status, alternate IDs, nicknames, career winnings, and
// signature heroes, from each player's own page.
//
// import-team-details.mjs only ever inserted ign/role/team_id — it never
// captured a player's own Liquipedia page slug, so there was no way to
// fetch an individual photo for any of the 1620 rows (confirmed: 0/1620
// had photo_url or liquipedia_slug set). That importer now also captures
// each roster row's slug (from the roster table's own player link) at zero
// extra request cost, since it already fetches the team page once — this
// script just needs to (a) run that same team-page fetch again for any
// team with players still missing a slug, to actually populate it, then
// (b) fetch each now-slugged player's own page for the rest.
//
// No longer a true one-time backfill: as of the "keep player data always
// up to date" pass, phase 2 re-checks already-complete rows on a 7-day
// cadence too (see STALE_AFTER_MS below), not just rows with a genuine
// gap — provenance-guarded (see _provenance.mjs) so a re-check never
// silently reverts an admin's manual correction.
//
// Phase 2's DOM selectors below were confirmed against real rendered HTML
// for 5 players (AURORAA/Argentina, Lutpiii/Indonesia, Kairi/Philippines,
// Daniel (Indonesian player)/Indonesia, Bo Ye/Myanmar) fetched through this
// same client — not guessed. Notably:
//   - Every infobox row is `<div class="infobox-cell-2 infobox-description">
//     Label:</div><div style="width:50%">Value</div>` — labels seen include
//     "Name:", "Nationality:", "Born:", "Role:", "Team:", "Status:",
//     "Alternate IDs:", "Nickname(s):", "Approx. Total Winnings:",
//     "Signature Heroes:". "Role:"/"Team:" are deliberately NOT captured —
//     see fetchPlayerProfile's comment on why.
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
//   - "Born:" includes a computed age suffix ("September 21, 2005
//     (age 20)") stripped before date-parsing. "Signature Heroes:" is an
//     icon-only cell with no visible text at all — read from each icon
//     anchor's `title` attribute instead.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import {
  fetchRenderedPage,
  sleep,
  extractCountryCodes,
  extractInfoboxIconLinks,
  getInfoboxRows,
  parseMoneyString,
  splitBrSeparatedCell,
  extractAnchorTitlesFromCell,
  arrayOrNull,
} from "./_liquipedia.mjs";
import { fetchTeamPage, extractActiveRoster, upsertPlayerRole } from "./import-team-details.mjs";
import { getAdminEditedFields, buildProvenanceGuardedUpdate } from "./_provenance.mjs";

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

// "September 21, 2005 (age 20)" — the computed age suffix needs stripping
// before date-parsing; confirmed against Kairi's real infobox.
function parseBornDate(cell) {
  if (!cell) return null;
  const raw = cell.text().replace(/\s*\(age\s*\d+\)\s*$/i, "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

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

  // "team" and "role" are deliberately NOT captured here even though
  // they're on the page — team_id/role are already derived from the more
  // authoritative team roster table (import-team-details.mjs), and a
  // player's own page lags behind real roster moves just as often as that
  // table does; storing both risks the two disagreeing with each other.
  const bornDate = parseBornDate(rows.get("born"));
  const status = rows.get("status")?.text().trim() || null;
  const alternateIds = arrayOrNull(splitBrSeparatedCell($, rows.get("alternate ids")));
  const nicknames = arrayOrNull(splitBrSeparatedCell($, rows.get("nickname(s)")));
  const totalWinnings = rows.get("approx. total winnings")
    ? parseMoneyString(rows.get("approx. total winnings").text())
    : null;
  // "signature heroes" renders as icon-only links with no visible text at
  // all — confirmed against Kairi's real page (cell.text() comes back
  // empty) — read from each icon anchor's title attribute instead.
  const signatureHeroes = arrayOrNull(extractAnchorTitlesFromCell($, rows.get("signature heroes")));

  return {
    photoUrl: photoUrl || null,
    realName,
    countryCodes,
    links,
    bornDate,
    status,
    alternateIds,
    nicknames,
    totalWinnings,
    signatureHeroes,
  };
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

const PROFILE_COLUMNS = [
  "photo_url",
  "real_name",
  "country_codes",
  "links",
  "born_date",
  "status",
  "alternate_ids",
  "nicknames",
  "total_winnings",
  "signature_heroes",
];
// A player's own infobox changes less often than a hero's balance-patch-
// driven stats but more often than a team's — 7 days matches teams'
// cadence, well inside what the shared rate-limit budget can absorb given
// MAX_PROFILES_PER_RUN already caps actual fetch volume regardless.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// Same "converge over several runs, never gamble the whole timeout"
// pattern as import-liquipedia-heroes.mjs — caps how many complete-but-
// stale players get re-checked on top of however many still have a
// genuine gap (gap-fill rows are never capped).
const MAX_STALE_REFRESH_PER_RUN = 60;

async function backfillProfiles() {
  const { data: allSlugged, error } = await supabase
    .from("players")
    .select(`id, ign, liquipedia_slug, last_liquipedia_sync_at, ${PROFILE_COLUMNS.join(", ")}`)
    .not("liquipedia_slug", "is", null);
  if (error) throw error;

  const now = Date.now();
  const hasGap = (p) => PROFILE_COLUMNS.some((c) => p[c] == null);
  const isStale = (p) =>
    !p.last_liquipedia_sync_at || now - new Date(p.last_liquipedia_sync_at).getTime() > STALE_AFTER_MS;

  const gapFillPlayers = allSlugged.filter(hasGap);
  const staleCompletePlayers = allSlugged
    .filter((p) => !hasGap(p) && isStale(p))
    .sort((a, b) => new Date(a.last_liquipedia_sync_at ?? 0) - new Date(b.last_liquipedia_sync_at ?? 0))
    .slice(0, MAX_STALE_REFRESH_PER_RUN);
  const players = [...gapFillPlayers, ...staleCompletePlayers];

  console.log(
    `Phase 2: ${players.length} of ${allSlugged.length} slugged player(s): ${gapFillPlayers.length} with a gap, ` +
      `${staleCompletePlayers.length} complete-but-stale (rest already fresh)`
  );

  for (const p of players) {
    const title = p.liquipedia_slug.replace(/_/g, " ");
    try {
      const profile = await fetchPlayerProfile(title);
      const scrapedFields = {
        photo_url: profile.photoUrl,
        real_name: profile.realName,
        country_codes: profile.countryCodes,
        links: profile.links,
        born_date: profile.bornDate,
        status: profile.status,
        alternate_ids: profile.alternateIds,
        nicknames: profile.nicknames,
        total_winnings: profile.totalWinnings,
        signature_heroes: profile.signatureHeroes,
      };

      const hasExistingValues = PROFILE_COLUMNS.some((c) => p[c] != null);
      const adminEditedFields = hasExistingValues
        ? await getAdminEditedFields(supabase, "players", p.id)
        : new Set();
      const { payload: update, skipped } = buildProvenanceGuardedUpdate(p, scrapedFields, adminEditedFields);
      update.last_liquipedia_sync_at = new Date().toISOString();

      // Every field that came back empty this run, whether or not it was
      // already set — surfaced so a human scanning the job log can tell a
      // real gap (this player's page genuinely has no listed nationality)
      // from a broken selector (the same field is empty for everyone).
      const stillMissing = Object.entries(scrapedFields)
        .filter(([, v]) => v == null)
        .map(([k]) => k);

      const { error: updateError } = await supabase.from("players").update(update).eq("id", p.id);
      if (updateError) {
        console.error(`Failed to save profile for "${p.ign}":`, updateError.message);
        continue;
      }
      const savedFields = Object.keys(update).filter((f) => f !== "last_liquipedia_sync_at");
      console.log(
        `${p.ign}: saved ${savedFields.length > 0 ? savedFields.join(", ") : "nothing new"}` +
          `${skipped.length ? ` (kept admin-edited: ${skipped.join(", ")})` : ""}` +
          `${stillMissing.length ? ` (page has no ${stillMissing.join("/")})` : ""}`
      );
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
