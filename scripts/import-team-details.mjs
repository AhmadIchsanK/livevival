// Livevival — imports each team's logo and active-roster player roles
// straight from that team's own Liquipedia page, in one fetch per team.
//
// Replaces import-liquipedia-team-rosters.mjs (Portal:Teams "Top 10 by
// earnings" only) and import-liquipedia-region-rosters.mjs (six regional
// portal pages) — both scraped hand-styled portal aggregator pages and,
// per their own code comments, "produced almost no rows in production."
// A team's own page has a stable, consistently-structured roster table
// (confirmed against real rendered HTML for ONIC, Selangor Red Giants, and
// Team Liquid PH) plus the team's logo in the same single fetch — so this
// covers logo import too, which neither predecessor script did at all.
//
// Structure this relies on:
//   <h3 id="Active">Active</h3>
//   <div class="table2 table2--generic"><table class="table2__table">
//     <tr class="table2__row--head"><th>ID</th><th>Name</th><th>Position</th>...</tr>
//     <tr class="table2__row--body">
//       <td><span class="inline-player"><a title="IGN">IGN</a></span></td>
//       <td>Real name</td>
//       <td>Position text, e.g. "EXP Lane", "Jungler", "Middle", "Gold Lane", "Roamer"</td>
//       ...
//     </tr>
//   .infobox-image.lightmode img — team logo (falls back to any
//   .infobox-image img if no light/dark variant split exists)
//
// Only the "Active" section is scraped — "Inactive"/"Former" sections
// exist on most team pages but are historical rosters going back years,
// not useful for matching current picks/bans to current players.
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, only ever calls api.php, paced requests.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import {
  apiQuery,
  sleep,
  COUNTRY_NAME_TO_CODE,
  REGION_BY_COUNTRY_CODE,
  extractCountryCodes,
  getInfoboxRows,
  extractInfoboxIconLinks,
  parseMoneyString,
} from "./_liquipedia.mjs";
import { getAdminEditedFields, buildProvenanceGuardedUpdate } from "./_provenance.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Liquipedia's "Position" column text varies slightly by team/patch era
// (e.g. "EXP Lane" vs "EXP Laner", "Middle" vs "Mid Lane") — normalize to
// the fixed role list used by the admin Players page. Anything that
// doesn't match a known pattern (subs marked "Flex", multi-role text,
// coach/analyst rows that slipped through) is left null rather than
// guessed at.
const ROLE_PATTERNS = [
  [/^exp\s*lane?r?$/i, "Exp Laner"],
  [/^jungler?$/i, "Jungler"],
  [/^mid(dle)?(\s*lane?r?)?$/i, "Mid Laner"],
  [/^gold\s*lane?r?$/i, "Gold Laner"],
  [/^roam(er)?$/i, "Roamer"],
];
function normalizeRole(raw) {
  const trimmed = (raw ?? "").trim();
  for (const [re, canonical] of ROLE_PATTERNS) {
    if (re.test(trimmed)) return canonical;
  }
  return null;
}

export function extractLogoUrl($) {
  let src = $(".infobox-image.lightmode img").first().attr("src");
  if (!src) src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
}

export function extractActiveRoster($) {
  const heading = $("h3#Active, h2#Active").first();
  if (heading.length === 0) return [];
  const table = heading
    .closest(".mw-heading2, .mw-heading3, .mw-heading")
    .next(".table2--generic")
    .find("table.table2__table")
    .first();
  if (table.length === 0) return [];

  const headers = table.find("tr.table2__row--head th").map((_, th) => $(th).text().trim()).get();
  const positionIdx = headers.findIndex((h) => /position/i.test(h));
  if (positionIdx === -1) return [];

  const players = [];
  table.find("tr.table2__row--body").each((_, row) => {
    const $row = $(row);
    const cells = $row.find("td");
    // Prefer the anchor's visible text over its title attribute — for a
    // red-linked (missing) player page, MediaWiki auto-fills title with its
    // own tooltip text "PlayerName (page does not exist)", which was
    // silently getting stored as the player's actual name. The link text
    // itself is always just the clean name.
    const $link = $(cells[0]).find(".inline-player a[title]").first();
    const ign = $link.text().trim() || $link.attr("title")?.replace(/\s*\(page does not exist\)\s*$/i, "").trim();
    if (!ign) return;
    // Defends against a country/region name landing in the `ign` cell — a
    // flag/section-header row misread as a real roster row (confirmed as
    // the shape of 11 real production rows, e.g. ign="Indonesia" on a real
    // team_id — see COUNTRY_NAME_TO_CODE's own comment for the full story).
    // No currently-live team page reproduces this against this function as
    // written, but nothing structurally prevents a future regression from
    // doing it again, so reject an exact country-name match outright rather
    // than relying on it never happening.
    if (COUNTRY_NAME_TO_CODE[ign.trim().toLowerCase()]) {
      console.warn(`  skipping roster row: ign "${ign}" looks like a country name, not a player`);
      return;
    }
    const roleRaw = $(cells[positionIdx]).text().trim();
    // The roster link's href is that player's own Liquipedia page slug
    // when one exists (a red link — no individual page — has no href at
    // all, or points to index.php?...&redlink=1, neither of which is a
    // usable slug). Stashing it here means backfill-player-photos.mjs can
    // fetch each player's own infobox portrait later without an extra
    // categorymembers-style discovery pass — one fetch per team (already
    // happening) captures every rostered player's slug at zero extra cost.
    const href = $link.attr("href");
    const slug =
      href && href.startsWith("/mobilelegends/") && !href.includes("redlink=1")
        ? decodeURIComponent(href.replace(/^\/mobilelegends\//, ""))
        : null;
    players.push({ ign, role: normalizeRole(roleRaw), slug });
  });
  return players;
}

// Team infoboxes list a "Location:" row (occasionally "Country:" on older
// pages) the same `.infobox-description` / next-sibling shape confirmed for
// player infoboxes (see backfill-player-photos.mjs's header comment) — free
// text, e.g. "Jakarta, Indonesia", sometimes with an inline flag icon next
// to it. Region has no equivalent direct infobox field on team pages (unlike
// tournament/hero infoboxes), so it's derived from the same location value:
// first via the flag icon's own ISO code (most reliable — same
// extractCountryCodes helper used for player nationality), falling back to
// a plain country-name match inside the location text when there's no flag
// to read. Either the flag or the name-match coming up empty just leaves
// region null rather than guessing — most reliably-derivable case is a
// single-country market matching COUNTRY_NAME_TO_CODE (see
// REGION_BY_COUNTRY_CODE's own comment in _liquipedia.mjs for what "region"
// means here).
export function extractLocationAndRegion($) {
  const rows = getInfoboxRows($);
  const cell = rows.get("location") || rows.get("country");
  if (!cell || cell.length === 0) return { location: null, region: null };

  const location = cell.text().trim().replace(/\s+/g, " ") || null;
  if (!location) return { location: null, region: null };

  const codes = extractCountryCodes($, cell);
  let code = codes && codes.length > 0 ? codes[0] : null;
  if (!code) {
    // No flag icon in the cell (some older team pages just list plain
    // text) — fall back to matching a known country name inside the
    // location text itself. Longest names first so "united arab emirates"
    // wins over any shorter name that happens to be a substring of it.
    const lower = location.toLowerCase();
    const names = Object.keys(COUNTRY_NAME_TO_CODE).sort((a, b) => b.length - a.length);
    const matched = names.find((name) =>
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)
    );
    if (matched) code = COUNTRY_NAME_TO_CODE[matched];
  }

  const region = code ? REGION_BY_COUNTRY_CODE[code] ?? null : null;
  return { location, region };
}

// Confirmed against ONIC's real infobox: "created" is a clean ISO date
// ("2018-07-26"), "approx. total winnings" is a dollar-formatted string
// ("$2,651,695") parsed via the shared parseMoneyString helper.
export function extractFoundedAndWinnings($) {
  const rows = getInfoboxRows($);
  const createdCell = rows.get("created");
  const winningsCell = rows.get("approx. total winnings");
  const createdText = createdCell?.text().trim();
  const founded = createdText && /^\d{4}-\d{2}-\d{2}$/.test(createdText) ? createdText : null;
  const winnings = winningsCell ? parseMoneyString(winningsCell.text()) : null;
  return { founded, winnings };
}

// Domains that unambiguously identify a specific social platform — checked
// before anything icon-class-based since a link's own href is a much more
// stable signal than an icon filename/CSS class that Liquipedia could
// restyle at any time (e.g. the X/Twitter rebrand already happened once).
const SOCIAL_DOMAIN_TO_COLUMN = [
  [/(^|\.)x\.com$/i, "twitter_url"],
  [/(^|\.)twitter\.com$/i, "twitter_url"],
  [/(^|\.)instagram\.com$/i, "instagram_url"],
  [/(^|\.)facebook\.com$/i, "facebook_url"],
  [/(^|\.)fb\.com$/i, "facebook_url"],
  [/(^|\.)youtube\.com$/i, "youtube_url"],
  [/(^|\.)youtu\.be$/i, "youtube_url"],
  [/(^|\.)discord\.gg$/i, "discord_url"],
  [/(^|\.)discord\.com$/i, "discord_url"],
];

// Platforms Liquipedia's icon-links block commonly includes that this
// schema has no column for (Twitch, TikTok, Reddit, VK, Weibo, Bilibili,
// plus the wiki's own self-links) — recognized explicitly so an unmatched
// link from one of these never gets misfiled into website_url below.
const KNOWN_NON_WEBSITE_DOMAINS = [
  /(^|\.)twitch\.tv$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)vk\.com$/i,
  /(^|\.)weibo\.com$/i,
  /(^|\.)bilibili\.com$/i,
  /(^|\.)liquipedia\.net$/i,
  /(^|\.)wikipedia\.org$/i,
];

// Fallback only for when the href's own domain doesn't decide it — the icon
// class name Liquipedia actually uses for a team's homepage link varies
// ("lp-link", "lp-website", "lp-home" have all been seen across different
// wikis' skins), so this covers whichever of those shows up without
// depending on any single one.
const WEBSITE_ICON_CLASSES = new Set(["website", "link", "home", "homepage", "site", "official"]);

function columnForLink(platform, href) {
  let host;
  try {
    host = new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null; // not a real absolute URL — nothing usable to store
  }

  for (const [re, column] of SOCIAL_DOMAIN_TO_COLUMN) {
    if (re.test(host)) return column;
  }
  if (KNOWN_NON_WEBSITE_DOMAINS.some((re) => re.test(host))) return null;
  if (platform && WEBSITE_ICON_CLASSES.has(platform)) return "website_url";

  // Domain isn't a recognized social platform and isn't a recognized
  // non-website platform either — Liquipedia's Links section conventionally
  // opens with the team's own official-site link, so treat an otherwise
  // unclassified icon-links entry as that.
  return "website_url";
}

// Reclassifies the generic {platform: href} map from
// extractInfoboxIconLinks (shared with player-page parsing) into this
// table's actual column names, using each href's own domain as the primary
// signal (see columnForLink). Returns null if the page's Links section
// yielded nothing at all.
export function extractSocialLinks($) {
  const iconLinks = extractInfoboxIconLinks($);
  if (!iconLinks) return null;

  const result = {};
  for (const [platform, href] of Object.entries(iconLinks)) {
    if (!href || !href.startsWith("http")) continue;
    const column = columnForLink(platform.toLowerCase(), href);
    if (column && !result[column]) result[column] = href;
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Fetches a team's page by slug, following redirects (handles cases like
// an older-imported team name that Liquipedia has since renamed/merged —
// e.g. "ONIC Esports" redirecting to "ONIC"). Returns null if the page
// genuinely doesn't exist under that slug, so the caller can skip cleanly
// instead of importing from an empty response.
export async function fetchTeamPage(slug, attempt = 1, maxRetries) {
  const data = await apiQuery({ action: "parse", page: slug, prop: "text", redirects: "1" }, attempt, maxRetries);
  if (data.error) return null;
  const html = data.parse?.text?.["*"];
  if (!html) return null;
  return { html, canonicalTitle: data.parse?.title ?? slug };
}

export async function upsertPlayerRole(teamId, ign, role, slug) {
  const { data: existing, error: lookupError } = await supabase
    .from("players")
    .select("id, role, liquipedia_slug")
    .eq("team_id", teamId)
    .ilike("ign", ign)
    .maybeSingle();
  if (lookupError) {
    console.error(`Failed to look up player "${ign}":`, lookupError.message);
    return;
  }

  if (existing) {
    // Never clobber a role an admin already set manually. liquipedia_slug
    // is scraper-only (nothing else ever writes it), so it's always safe
    // to backfill once missing.
    const update = {};
    if (!existing.role && role) update.role = role;
    if (!existing.liquipedia_slug && slug) update.liquipedia_slug = slug;
    if (Object.keys(update).length > 0) {
      const { error } = await supabase.from("players").update(update).eq("id", existing.id);
      if (error) console.error(`Failed to backfill "${ign}":`, error.message);
    }
    return;
  }

  const { error } = await supabase.from("players").insert({ ign, role, team_id: teamId, liquipedia_slug: slug });
  if (error && !error.message.includes("duplicate key")) {
    console.error(`Failed to add player "${ign}":`, error.message);
  }
}

async function importTeam(team) {
  const slug = team.liquipedia_slug || team.name.trim().replace(/ /g, "_");
  const page = await fetchTeamPage(slug);
  if (!page) {
    console.warn(`No Liquipedia page found for "${team.name}" (tried slug "${slug}") — skipping`);
    await supabase.from("teams").update({ last_liquipedia_sync_at: new Date().toISOString() }).eq("id", team.id);
    return;
  }

  const $ = cheerio.load(page.html);
  const logoUrl = extractLogoUrl($);
  const roster = extractActiveRoster($);
  const { location, region } = extractLocationAndRegion($);
  const socialLinks = extractSocialLinks($);
  const { founded, winnings } = extractFoundedAndWinnings($);

  const scrapedFields = {
    liquipedia_slug: page.canonicalTitle,
    logo_url: logoUrl,
    location,
    region,
    founded_date: founded,
    total_winnings: winnings,
  };
  for (const column of SOCIAL_COLUMNS) {
    if (socialLinks?.[column]) scrapedFields[column] = socialLinks[column];
  }

  // Only worth the extra round trip when the row already has values to
  // protect — a brand-new/mostly-empty row has nothing an admin could have
  // edited yet.
  const hasExistingValues = Object.keys(scrapedFields).some((f) => team[f] != null);
  const adminEditedFields = hasExistingValues
    ? await getAdminEditedFields(supabase, "teams", team.id)
    : new Set();
  const { payload: teamUpdate, skipped } = buildProvenanceGuardedUpdate(team, scrapedFields, adminEditedFields);
  teamUpdate.last_liquipedia_sync_at = new Date().toISOString();

  const { error } = await supabase.from("teams").update(teamUpdate).eq("id", team.id);
  if (error) console.error(`Failed to update team "${team.name}":`, error.message);
  if (skipped.length > 0) {
    console.log(`  ${team.name}: kept admin-edited value(s) for ${skipped.join(", ")}`);
  }

  for (const p of roster) {
    await upsertPlayerRole(team.id, p.ign, p.role, p.slug);
  }

  console.log(
    `${team.name}: ${logoUrl ? "logo found" : "no logo"}, ${roster.length} active roster row(s), ` +
      `${location ? `location "${location}"` : "no location"}${region ? ` (region "${region}")` : ""}, ` +
      `${socialLinks ? Object.keys(socialLinks).length : 0} social link(s)`
  );
}

const SOCIAL_COLUMNS = ["website_url", "twitter_url", "instagram_url", "facebook_url", "youtube_url", "discord_url"];
const SCRAPED_TEAM_COLUMNS = [
  "logo_url",
  "location",
  "region",
  "founded_date",
  "total_winnings",
  ...SOCIAL_COLUMNS,
];
// A team's own page realistically doesn't change often — 7 days balances
// staying current against not burning the shared rate-limit budget on
// re-confirming rows that are almost always still correct.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// Caps how many already-complete-but-stale rows get re-checked in one run,
// on top of however many still have a genuine gap (gap-fill rows are never
// capped) — same "converge over several runs, never gamble the whole
// timeout" pattern as import-liquipedia-heroes.mjs's icon backfill.
const MAX_STALE_REFRESH_PER_RUN = 40;

async function main() {
  const { data: teams, error } = await supabase
    .from("teams")
    .select(`id, name, liquipedia_slug, last_liquipedia_sync_at, ${SCRAPED_TEAM_COLUMNS.join(", ")}`);
  if (error) throw error;

  const { data: players, error: playersError } = await supabase.from("players").select("team_id, role");
  if (playersError) throw playersError;
  const teamsWithMissingRole = new Set(players.filter((p) => p.team_id && !p.role).map((p) => p.team_id));

  // Re-fetching every team on every run (301+ teams, Liquipedia rate-
  // limited) was the actual cause of the slow original backfill: with
  // retries, a full pass routinely blew past GitHub Actions' 6h hard job
  // cap and got force-cancelled before reaching the back half of the team
  // list — confirmed via the last two scheduled runs of this workflow,
  // both "cancelled" at ~6h05m. Two independent selection reasons feed the
  // same run now: (1) gap-fill — any team missing a value in one of
  // SCRAPED_TEAM_COLUMNS, or with a rostered player still missing a role —
  // is never capped, since these are the highest-value/lowest-cost rows to
  // fix; (2) periodic refresh — an already-complete team whose
  // last_liquipedia_sync_at is older than STALE_AFTER_MS gets re-checked
  // too (capped at MAX_STALE_REFRESH_PER_RUN, oldest-synced first), so a
  // roster/social/logo change on an otherwise-"done" team's page still
  // eventually reaches this scraper instead of being frozen forever the
  // moment every column first fills in. buildProvenanceGuardedUpdate (see
  // importTeam above) is what makes re-checking an already-filled row
  // safe: it only overwrites a non-null value when that specific field's
  // last real change wasn't a human admin edit. The job's own
  // timeout-minutes/cron-interval combination (180 min, every 6h, no
  // overlapping runs) tolerates spreading a large gap-fill backlog across
  // several scheduled cycles instead of finishing in one; this can never
  // fully "converge to zero" for a team whose real Liquipedia page
  // genuinely has no Location field or Links section — same accepted
  // tradeoff logo_url already had for a team with no logo on its page.
  const now = Date.now();
  const hasGap = (t) =>
    SCRAPED_TEAM_COLUMNS.some((c) => t[c] == null) || teamsWithMissingRole.has(t.id);
  const isStale = (t) =>
    !t.last_liquipedia_sync_at || now - new Date(t.last_liquipedia_sync_at).getTime() > STALE_AFTER_MS;

  const gapFillTeams = teams.filter(hasGap);
  const staleCompleteTeams = teams
    .filter((t) => !hasGap(t) && isStale(t))
    .sort((a, b) => new Date(a.last_liquipedia_sync_at ?? 0) - new Date(b.last_liquipedia_sync_at ?? 0))
    .slice(0, MAX_STALE_REFRESH_PER_RUN);
  const needsFetch = [...gapFillTeams, ...staleCompleteTeams];

  console.log(
    `Processing ${needsFetch.length} of ${teams.length} team(s): ${gapFillTeams.length} with a gap, ` +
      `${staleCompleteTeams.length} complete-but-stale (rest already fresh)...`
  );
  for (const team of needsFetch) {
    try {
      await importTeam(team);
    } catch (err) {
      console.error(`Failed processing team "${team.name}":`, err.message);
    }
    await sleep(4000); // extra headroom beyond the documented 1 req/2s — see _liquipedia.mjs
  }
}

// Guarded so backfill-player-photos.mjs can import fetchTeamPage/
// extractActiveRoster/upsertPlayerRole above without triggering a full
// 301-team scrape as an import side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
