// Livevival — supplementary import: player rosters for the Top 10 highest-
// earning teams on Liquipedia's Portal:Teams page.
//
// Note on scope: Portal:Teams, read through the compliant public API, only
// exposes a "Top 10 Most Earnings" section and a disbanded-teams list — the
// full region-tabbed team browser you see on the live site is a client-side
// widget that doesn't come through the static API response. So this is NOT
// a comprehensive team importer. Comprehensive team coverage already comes
// for free as a side effect of scripts/import-liquipedia-matches.mjs, which
// creates a team row for every team it sees competing in an actual bracket.
// This script adds something that one doesn't: real player rosters.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";

const WIKI_API = "https://liquipedia.net/mobilelegends/api.php";
const USER_AGENT =
  "LivevivalBot/1.0 (https://livevival.vercel.app; contact: rigel@rawwy.ae)";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchRenderedPage(pageTitle) {
  const url = new URL(WIKI_API);
  url.searchParams.set("action", "parse");
  url.searchParams.set("page", pageTitle);
  url.searchParams.set("prop", "text");
  url.searchParams.set("format", "json");

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip" },
  });
  if (!res.ok) throw new Error(`Liquipedia API returned ${res.status} for ${pageTitle}`);
  const data = await res.json();
  return data.parse?.text?.["*"] ?? "";
}

function extractRosters(html) {
  const $ = cheerio.load(html);
  const rosters = [];

  $(".tp-rank-card").each((_, card) => {
    const $card = $(card);
    const teamName = $card.find(".tp-team-name").first().text().trim();
    if (!teamName) return;

    const players = $card
      .find(".tp-team-box .tp-name a[title]")
      .map((_, a) => $(a).attr("title"))
      .get()
      .filter(Boolean);

    rosters.push({ teamName, players });
  });

  return rosters;
}

async function getOrCreateTeamId(name) {
  const { data: existing } = await supabase
    .from("teams")
    .select("id")
    .ilike("name", name.trim())
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from("teams")
    .insert({ name: name.trim() })
    .select("id")
    .single();
  if (error) {
    console.error(`Failed to create team "${name}": ${error.message}`);
    return null;
  }
  return created.id;
}

async function importRosters() {
  const html = await fetchRenderedPage("Portal:Teams");
  const rosters = extractRosters(html);
  console.log(`Found ${rosters.length} team rosters on Portal:Teams`);

  for (const { teamName, players } of rosters) {
    const teamId = await getOrCreateTeamId(teamName);
    if (!teamId) continue;

    for (const ign of players) {
      const { data: existing } = await supabase
        .from("players")
        .select("id")
        .eq("team_id", teamId)
        .ilike("ign", ign)
        .maybeSingle();
      if (existing) continue;

      const { error } = await supabase.from("players").insert({ ign, team_id: teamId });
      if (error) console.error(`Failed to add player "${ign}" to ${teamName}: ${error.message}`);
      else console.log(`Added ${ign} to ${teamName}`);
    }
  }
}

importRosters().catch((err) => {
  console.error(err);
  process.exit(1);
});
