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
import { apiQuery, sleep } from "./_liquipedia.mjs";

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

  const teamUpdate = {};
  if (!team.liquipedia_slug) teamUpdate.liquipedia_slug = page.canonicalTitle;
  if (!team.logo_url && logoUrl) teamUpdate.logo_url = logoUrl;
  if (Object.keys(teamUpdate).length > 0) {
    const { error } = await supabase.from("teams").update(teamUpdate).eq("id", team.id);
    if (error) console.error(`Failed to update team "${team.name}":`, error.message);
  }

  for (const p of roster) {
    await upsertPlayerRole(team.id, p.ign, p.role, p.slug);
  }

  console.log(`${team.name}: ${logoUrl ? "logo found" : "no logo"}, ${roster.length} active roster row(s)`);
}

async function main() {
  const { data: teams, error } = await supabase.from("teams").select("id, name, liquipedia_slug, logo_url");
  if (error) throw error;

  const { data: players, error: playersError } = await supabase.from("players").select("team_id, role");
  if (playersError) throw playersError;
  const teamsWithMissingRole = new Set(players.filter((p) => p.team_id && !p.role).map((p) => p.team_id));

  // Re-fetching every team on every run (301 teams, Liquipedia rate-limited)
  // was the actual cause of the slow backfill: with retries, a full pass
  // routinely blew past GitHub Actions' 6h hard job cap and got force-
  // cancelled before reaching the back half of the team list — confirmed
  // via the last two scheduled runs of this workflow, both "cancelled" at
  // ~6h05m. Skip teams that already have a logo and a fully-roled known
  // roster; only re-fetch when a new player shows up with no role yet.
  const needsFetch = teams.filter((t) => !t.logo_url || teamsWithMissingRole.has(t.id));
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
