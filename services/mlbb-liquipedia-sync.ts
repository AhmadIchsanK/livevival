// Real-time MLBB data sync from Liquipedia
// Imports Tier S/A tournaments, matches, results, teams, and players with comprehensive data

import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const LIQUIPEDIA_BASE = "https://liquipedia.net/mobilelegends";
const SCRAPE_TIMEOUT = 30000;
const RATE_LIMIT_DELAY = 1500; // 1.5s between requests
const MAX_RETRIES = 3;
const RETRY_BACKOFF = 1000;

let lastRequestTime = 0;

async function delayForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    await new Promise((resolve) =>
      setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest)
    );
  }
  lastRequestTime = Date.now();
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      await delayForRateLimit();
      console.log(`[MLBB Sync] Fetching ${url} (attempt ${i + 1}/${retries})`);

      const response = await axios.get(url, {
        timeout: SCRAPE_TIMEOUT,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      return response.data;
    } catch (error) {
      const axiosError = error as AxiosError;
      console.error(`[MLBB Sync] Fetch failed (attempt ${i + 1}): ${axiosError.message}`);

      if (i < retries - 1) {
        const backoffTime = RETRY_BACKOFF * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      }
    }
  }

  throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

export interface MLBBTournament {
  name: string;
  tier: "S" | "A";
  region?: string;
  startDate?: string;
  endDate?: string;
  liquipediaUrl: string;
  prizePool?: string;
  teamCount?: number;
}

export interface MLBBTeam {
  name: string;
  region?: string;
  country?: string;
  liquipediaUrl: string;
}

export interface MLBBPlayer {
  name: string;
  ign?: string;
  role?: string;
  country?: string;
  team?: string;
  liquipediaUrl: string;
}

export interface MLBBMatch {
  tournament: string;
  teamA: string;
  teamB: string;
  bestOf?: number;
  result?: "teamA" | "teamB" | "draw";
  date?: string;
  stage?: string;
  liquipediaUrl: string;
}

// Fetch all active MLBB Tier S tournaments
export async function fetchMLBBTierSTournaments(): Promise<MLBBTournament[]> {
  try {
    console.log("[MLBB Sync] Fetching Tier S tournaments...");
    const url = `${LIQUIPEDIA_BASE}/Portal:Tournaments`;
    const html = await fetchWithRetry(url);
    const $ = cheerio.load(html);

    const tournaments: MLBBTournament[] = [];

    // Look for tournament cards with Tier S designation
    $("div.mw-parser-output").find("*:contains('Tier S')").closest("table, div").each((_, el) => {
      const $el = $(el);
      const link = $el.find("a[href*='/']").first();
      const href = link.attr("href");
      const text = link.text().trim();

      if (href && text && !tournaments.some((t) => t.name === text)) {
        const prizePoolMatch = $el.text().match(/\$[\d,]+([MK])?/);
        const prizePool = prizePoolMatch ? prizePoolMatch[0] : undefined;

        tournaments.push({
          name: text,
          tier: "S",
          liquipediaUrl: `${LIQUIPEDIA_BASE}${href}`,
          prizePool,
        });
      }
    });

    console.log(`[MLBB Sync] Found ${tournaments.length} Tier S tournaments`);
    return tournaments;
  } catch (error) {
    console.error("[MLBB Sync] Failed to fetch Tier S tournaments:", error);
    return [];
  }
}

// Fetch all active MLBB Tier A tournaments
export async function fetchMLBBTierATournaments(): Promise<MLBBTournament[]> {
  try {
    console.log("[MLBB Sync] Fetching Tier A tournaments...");
    const url = `${LIQUIPEDIA_BASE}/Portal:Tournaments`;
    const html = await fetchWithRetry(url);
    const $ = cheerio.load(html);

    const tournaments: MLBBTournament[] = [];

    // Look for tournament cards with Tier A designation
    $("div.mw-parser-output").find("*:contains('Tier A')").closest("table, div").each((_, el) => {
      const $el = $(el);
      const link = $el.find("a[href*='/']").first();
      const href = link.attr("href");
      const text = link.text().trim();

      if (href && text && !tournaments.some((t) => t.name === text)) {
        const prizePoolMatch = $el.text().match(/\$[\d,]+([MK])?/);
        const prizePool = prizePoolMatch ? prizePoolMatch[0] : undefined;

        tournaments.push({
          name: text,
          tier: "A",
          liquipediaUrl: `${LIQUIPEDIA_BASE}${href}`,
          prizePool,
        });
      }
    });

    console.log(`[MLBB Sync] Found ${tournaments.length} Tier A tournaments`);
    return tournaments;
  } catch (error) {
    console.error("[MLBB Sync] Failed to fetch Tier A tournaments:", error);
    return [];
  }
}

// Fetch tournament details including matches and results
export async function fetchTournamentDetails(
  tournamentUrl: string
): Promise<{ matches: MLBBMatch[]; teams: MLBBTeam[] }> {
  try {
    console.log(`[MLBB Sync] Fetching tournament details: ${tournamentUrl}`);
    const html = await fetchWithRetry(tournamentUrl);
    const $ = cheerio.load(html);

    const matches: MLBBMatch[] = [];
    const teams: MLBBTeam[] = [];

    // Extract tournament name
    const tournamentName = $("h1").first().text().trim();

    // Find all match tables
    $("table.wikitable").each((_, table) => {
      $(table).find("tbody tr").each((_, row) => {
        const $row = $(row);
        const cells = $row.find("td");

        if (cells.length >= 3) {
          const teamALink = $row.find("td").eq(0).find("a[href*='/']").first();
          const teamBLink = $row.find("td").eq(2).find("a[href*='/']").first();

          const teamA = teamALink.text().trim();
          const teamB = teamBLink.text().trim();

          if (teamA && teamB) {
            // Try to extract score/result
            const scoreText = $row.find("td").eq(1).text().trim();
            let result: "teamA" | "teamB" | "draw" | undefined;

            if (scoreText.includes(teamA) || scoreText.startsWith("1")) result = "teamA";
            else if (scoreText.includes(teamB) || scoreText.startsWith("2")) result = "teamB";
            else if (scoreText === "0-0") result = "draw";

            matches.push({
              tournament: tournamentName,
              teamA,
              teamB,
              result,
              liquipediaUrl: tournamentUrl,
            });

            // Collect teams
            if (!teams.some((t) => t.name === teamA)) {
              teams.push({
                name: teamA,
                liquipediaUrl: `${LIQUIPEDIA_BASE}${teamALink.attr("href") || ""}`,
              });
            }

            if (!teams.some((t) => t.name === teamB)) {
              teams.push({
                name: teamB,
                liquipediaUrl: `${LIQUIPEDIA_BASE}${teamBLink.attr("href") || ""}`,
              });
            }
          }
        }
      });
    });

    console.log(`[MLBB Sync] Found ${matches.length} matches and ${teams.length} teams`);
    return { matches, teams };
  } catch (error) {
    console.error("[MLBB Sync] Failed to fetch tournament details:", error);
    return { matches: [], teams: [] };
  }
}

// Fetch team roster and player details
export async function fetchTeamRoster(teamUrl: string): Promise<MLBBPlayer[]> {
  try {
    console.log(`[MLBB Sync] Fetching team roster: ${teamUrl}`);
    const html = await fetchWithRetry(teamUrl);
    const $ = cheerio.load(html);

    const players: MLBBPlayer[] = [];

    // Find roster table
    $("table.wikitable").each((_, table) => {
      $(table).find("tbody tr").each((_, row) => {
        const $row = $(row);
        const cells = $row.find("td");

        if (cells.length >= 2) {
          const playerLink = $row.find("a[href*='/']").first();
          const playerName = playerLink.text().trim();

          if (playerName) {
            // Try to extract role from columns
            const roleCell = cells.eq(1).text().trim();
            const role = roleCell || undefined;

            players.push({
              name: playerName,
              role,
              liquipediaUrl: `${LIQUIPEDIA_BASE}${playerLink.attr("href") || ""}`,
            });
          }
        }
      });
    });

    console.log(`[MLBB Sync] Found ${players.length} players in roster`);
    return players;
  } catch (error) {
    console.error("[MLBB Sync] Failed to fetch team roster:", error);
    return [];
  }
}

// Sync all data to database
export async function syncMLBBDataToDatabase(): Promise<{
  tournamentsCount: number;
  matchesCount: number;
  teamsCount: number;
  playersCount: number;
}> {
  try {
    console.log("[MLBB Sync] Starting comprehensive MLBB data sync...");
    const startTime = Date.now();

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

    // Fetch all tournaments
    const tierSTournaments = await fetchMLBBTierSTournaments();
    const tierATournaments = await fetchMLBBTierATournaments();
    const allTournaments = [...tierSTournaments, ...tierATournaments];

    console.log(`[MLBB Sync] Syncing ${allTournaments.length} tournaments...`);

    let totalMatches = 0;
    let totalTeams = 0;
    let totalPlayers = 0;

    // Sync each tournament
    for (const tournament of allTournaments) {
      try {
        // Upsert tournament
        const { error: tournamentError } = await supabase
          .from("tournaments")
          .upsert(
            {
              id: tournament.name.toLowerCase().replace(/\s+/g, "-"),
              name: tournament.name,
              tier: tournament.tier,
              liquipedia_url: tournament.liquipediaUrl,
              prize_pool: tournament.prizePool,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "id" }
          );

        if (tournamentError) {
          console.warn(`[MLBB Sync] Error syncing tournament ${tournament.name}:`, tournamentError);
          continue;
        }

        // Fetch tournament details
        const { matches, teams } = await fetchTournamentDetails(tournament.liquipediaUrl);
        totalMatches += matches.length;
        totalTeams += teams.length;

        // Sync teams
        for (const team of teams) {
          try {
            const { error: teamError } = await supabase
              .from("teams")
              .upsert(
                {
                  id: team.name.toLowerCase().replace(/\s+/g, "-"),
                  name: team.name,
                  region: team.region,
                  country: team.country,
                  liquipedia_url: team.liquipediaUrl,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "id" }
              );

            if (!teamError) {
              // Fetch and sync team roster
              const players = await fetchTeamRoster(team.liquipediaUrl);
              totalPlayers += players.length;

              for (const player of players) {
                try {
                  await supabase
                    .from("players")
                    .upsert(
                      {
                        id: player.name.toLowerCase().replace(/\s+/g, "-"),
                        name: player.name,
                        ign: player.ign || player.name,
                        role: player.role,
                        country: player.country,
                        team_id: team.name.toLowerCase().replace(/\s+/g, "-"),
                        liquipedia_url: player.liquipediaUrl,
                        updated_at: new Date().toISOString(),
                      },
                      { onConflict: "id" }
                    );
                } catch (err) {
                  console.debug(`[MLBB Sync] Player sync skipped (table may not exist)`);
                }
              }
            }
          } catch (err) {
            console.debug(`[MLBB Sync] Team sync skipped: ${team.name}`);
          }
        }
      } catch (err) {
        console.warn(`[MLBB Sync] Tournament ${tournament.name} sync failed, continuing...`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[MLBB Sync] Sync completed in ${duration}ms: ${allTournaments.length} tournaments, ${totalMatches} matches, ${totalTeams} teams, ${totalPlayers} players`
    );

    return {
      tournamentsCount: allTournaments.length,
      matchesCount: totalMatches,
      teamsCount: totalTeams,
      playersCount: totalPlayers,
    };
  } catch (error) {
    console.error("[MLBB Sync] Comprehensive sync failed:", error);
    throw error;
  }
}
