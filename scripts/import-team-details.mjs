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

function extractLogoUrl($) {
  let src = $(".infobox-image.lightmode img").first().attr("src");
  if (!src) src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
}

function extractActiveRoster($) {
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
    const ign = $(cells[0]).find(".inline-player a[title]").first().attr("title");
    if (!ign) return;
    const roleRaw = $(cells[positionIdx]).text().trim();
    players.push({ ign, role: normalizeRole(roleRaw) });
  });
  return players;
}

// Fetches a team's page by slug, following redirects (handles cases like
// an older-imported team name that Liquipedia has since renamed/merged —
// e.g. "ONIC Esports" redirecting to "ONIC"). Returns null if the page
// genuinely doesn't exist under that slug, so the caller can skip cleanly
// instead of importing from an empty response.
async function fetchTeamPage(slug, attempt = 1) {
  const data = await apiQuery({ action: "parse", page: slug, prop: "text", redirects: "1" }, attempt);
  if (data.error) return null;
  const html = data.parse?.text?.["*"];
  if (!html) return null;
  return { html, canonicalTitle: data.parse?.title ?? slug };
}

async function upsertPlayerRole(teamId, ign, role) {
  const { data: existing, error: lookupError } = await supabase
    .from("players")
    .select("id, role")
    .eq("team_id", teamId)
    .ilike("ign", ign)
    .maybeSingle();
  if (lookupError) {
    console.error(`Failed to look up player "${ign}":`, lookupError.message);
    return;
  }

  if (existing) {
    // Never clobber a role an admin already set manually.
    if (!existing.role && role) {
      const { error } = await supabase.from("players").update({ role }).eq("id", existing.id);
      if (error) console.error(`Failed to backfill role for "${ign}":`, error.message);
    }
    return;
  }

  const { error } = await supabase.from("players").insert({ ign, role, team_id: teamId });
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
    await upsertPlayerRole(team.id, p.ign, p.role);
  }

  console.log(`${team.name}: ${logoUrl ? "logo found" : "no logo"}, ${roster.length} active roster row(s)`);
}

async function main() {
  const { data: teams, error } = await supabase.from("teams").select("id, name, liquipedia_slug, logo_url");
  if (error) throw error;

  console.log(`Processing ${teams.length} team(s)...`);
  for (const team of teams) {
    try {
      await importTeam(team);
    } catch (err) {
      console.error(`Failed processing team "${team.name}":`, err.message);
    }
    await sleep(4000); // extra headroom beyond the documented 1 req/2s — see _liquipedia.mjs
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
