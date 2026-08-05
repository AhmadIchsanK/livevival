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
} from "./_liquipedia.mjs";

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
    return;
  }

  const $ = cheerio.load(page.html);
  const logoUrl = extractLogoUrl($);
  const roster = extractActiveRoster($);
  const { location, region } = extractLocationAndRegion($);
  const socialLinks = extractSocialLinks($);

  const teamUpdate = {};
  if (!team.liquipedia_slug) teamUpdate.liquipedia_slug = page.canonicalTitle;
  if (!team.logo_url && logoUrl) teamUpdate.logo_url = logoUrl;
  // Same "only fill a gap, never overwrite" rule as logo_url/liquipedia_slug
  // above (and heroes.role/lane/region) — an admin's manual edit on any of
  // these is never clobbered by a re-scrape.
  if (!team.location && location) teamUpdate.location = location;
  if (!team.region && region) teamUpdate.region = region;
  if (socialLinks) {
    for (const column of SOCIAL_COLUMNS) {
      if (!team[column] && socialLinks[column]) teamUpdate[column] = socialLinks[column];
    }
  }
  if (Object.keys(teamUpdate).length > 0) {
    const { error } = await supabase.from("teams").update(teamUpdate).eq("id", team.id);
    if (error) console.error(`Failed to update team "${team.name}":`, error.message);
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

async function main() {
  const { data: teams, error } = await supabase
    .from("teams")
    .select(`id, name, liquipedia_slug, logo_url, location, region, ${SOCIAL_COLUMNS.join(", ")}`);
  if (error) throw error;

  const { data: players, error: playersError } = await supabase.from("players").select("team_id, role");
  if (playersError) throw playersError;
  const teamsWithMissingRole = new Set(players.filter((p) => p.team_id && !p.role).map((p) => p.team_id));

  // Re-fetching every team on every run (301 teams, Liquipedia rate-limited)
  // was the actual cause of the slow backfill: with retries, a full pass
  // routinely blew past GitHub Actions' 6h hard job cap and got force-
  // cancelled before reaching the back half of the team list — confirmed
  // via the last two scheduled runs of this workflow, both "cancelled" at
  // ~6h05m. Skip teams that already have a logo, a fully-roled known
  // roster, a location/region, and every social column; only re-fetch when
  // a new player shows up with no role yet or one of those team-level
  // fields is still a gap. location/region/socials are 100% null across
  // all 318 teams as of this field's introduction, so the very first run
  // after deploying it necessarily reprocesses close to the full team list
  // regardless — same shape of one-time cost the roster/logo backfill
  // already went through, and it converges the same way: each run only
  // re-touches teams still missing something, and the job's own
  // timeout-minutes/cron-interval combination (180 min, every 6h, no
  // overlapping runs) already tolerates spreading that convergence across
  // several scheduled cycles instead of finishing in one. Note this can
  // never fully "converge to zero" for a team whose real Liquipedia page
  // genuinely has no Location field or Links section — same accepted
  // tradeoff logo_url already has for a team with no logo on its page.
  const needsFetch = teams.filter(
    (t) =>
      !t.logo_url ||
      teamsWithMissingRole.has(t.id) ||
      !t.location ||
      !t.region ||
      SOCIAL_COLUMNS.some((c) => !t[c])
  );
  console.log(`Processing ${needsFetch.length} of ${teams.length} team(s) (rest already complete)...`);
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
