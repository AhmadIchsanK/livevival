// Livevival — imports player rosters from Liquipedia's regional Portal:Teams
// pages. Each team on these pages gets its own
// <table class="wikitable collapsible"> with the team name in the header
// and one row per player (IGN in the first cell, real name in the second).
// This covers far more teams than the main Portal:Teams page, which only
// lists the Top 10 by earnings.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { fetchRenderedPage, sleep } from "./_liquipedia.mjs";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const REGION_PAGES = [
  "Portal:Teams/Southeast Asia",
  "Portal:Teams/Rest of Asia",
  "Portal:Teams/EMEA",
  "Portal:Teams/South America",
  "Portal:Teams/North America",
  "Portal:Teams/China",
];

function extractRosters(html) {
  const $ = cheerio.load(html);
  const rosters = [];

  $("table.wikitable.collapsible").each((_, table) => {
    const $table = $(table);
    const teamName = $table.find("th .team-template-text a[title]").first().attr("title");
    if (!teamName) return;

    const players = $table
      .find("td .inline-player a[title]")
      .map((_, a) => $(a).attr("title"))
      .get()
      .filter(Boolean);

    if (players.length > 0) rosters.push({ teamName, players });
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

async function importRegion(pageTitle) {
  console.log(`Fetching ${pageTitle}...`);
  const html = await fetchRenderedPage(pageTitle);
  const rosters = extractRosters(html);
  console.log(`Found ${rosters.length} team roster(s) on ${pageTitle}`);

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
    }
  }
}

async function main() {
  for (const page of REGION_PAGES) {
    try {
      await importRegion(page);
    } catch (err) {
      console.error(`Failed processing ${page}:`, err.message);
    }
    await sleep(4000); // extra headroom beyond the documented 1 req/2s — see _liquipedia.mjs
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
