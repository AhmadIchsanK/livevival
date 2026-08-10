import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";

const LIQUIPEDIA_BASE = "https://liquipedia.net/counterstrike";
const SCRAPE_TIMEOUT = 30000;
const RATE_LIMIT_DELAY = 2000; // 2s between requests to avoid rate limiting
const MAX_RETRIES = 3;
const RETRY_BACKOFF = 1000; // 1s base backoff

let lastRequestTime = 0;

async function delayForRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      await delayForRateLimit();
      console.log(`[Scraper] Fetching ${url} (attempt ${i + 1}/${retries})`);

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
      console.error(`[Scraper] Fetch failed (attempt ${i + 1}): ${axiosError.message}`);

      if (i < retries - 1) {
        const backoffTime = RETRY_BACKOFF * Math.pow(2, i);
        console.log(`[Scraper] Retrying in ${backoffTime}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffTime));
      }
    }
  }

  throw new Error(`Failed to fetch ${url} after ${retries} retries`);
}

export interface ScrapedTournament {
  id: string;
  name: string;
  tier: string;
  liquipediaUrl: string;
  startDate?: string;
  endDate?: string;
}

export interface ScrapedMatch {
  id: string;
  status: "scheduled" | "live" | "finished";
  scheduledAt: string | null;
  format: string | null;
  tournament: {
    id: string;
    name: string;
    tier: string;
  };
  teamA: {
    id: string;
    name: string;
  } | null;
  teamB: {
    id: string;
    name: string;
  } | null;
  streamUrl: string | null;
}

export async function scrapeUpcomingTournaments(): Promise<ScrapedTournament[]> {
  try {
    const url = `${LIQUIPEDIA_BASE}/Upcoming_matches`;
    const html = await fetchWithRetry(url);
    const $ = cheerio.load(html);

    const tournaments: ScrapedTournament[] = [];
    const seen = new Set<string>();

    // Look for tournament links and names
    $("table.wikitable a[href*='/']").each((_, el) => {
      const $link = $(el);
      const href = $link.attr("href") || "";
      const text = $link.text().trim();

      if (href.includes("/") && text && !seen.has(text)) {
        const parts = href.split("/");
        const pageTitle = parts[parts.length - 1];

        // Simple tier detection based on URL patterns
        let tier = "Other";
        if (pageTitle.includes("Major")) tier = "Major";
        else if (pageTitle.includes("International")) tier = "International";
        else if (pageTitle.includes("Regional")) tier = "Regional";

        tournaments.push({
          id: pageTitle.toLowerCase().replace(/\s+/g, "-"),
          name: text,
          tier,
          liquipediaUrl: `https://liquipedia.net${href}`,
        });

        seen.add(text);
      }
    });

    console.log(`[Scraper] Found ${tournaments.length} tournaments`);
    return tournaments.slice(0, 50); // Limit to 50 to avoid overload
  } catch (error) {
    console.error("[Scraper] Error scraping tournaments:", error);
    return [];
  }
}

export async function scrapeMatchesForTournament(tournamentUrl: string): Promise<ScrapedMatch[]> {
  try {
    const html = await fetchWithRetry(tournamentUrl);
    const $ = cheerio.load(html);

    const matches: ScrapedMatch[] = [];
    const tournamentName = $("h1").first().text().trim();

    // Look for match tables
    $("table.wikitable tr").each((_, row) => {
      const $cells = $(row).find("td");
      if ($cells.length < 3) return;

      const dateText = $cells.eq(0).text().trim();
      const timeText = $cells.eq(1).text().trim();
      const matchText = $cells.eq(2).text().trim();

      if (!matchText || !dateText) return;

      const [teamA, teamB] = matchText.split("vs").map((t) => t.trim());
      if (!teamA || !teamB) return;

      const scheduledAt = dateText && timeText ? new Date(`${dateText} ${timeText}`).toISOString() : null;

      matches.push({
        id: `${tournamentName}-${teamA}-${teamB}-${Date.now()}`,
        status: "scheduled",
        scheduledAt,
        format: null,
        tournament: {
          id: tournamentName.toLowerCase().replace(/\s+/g, "-"),
          name: tournamentName,
          tier: "Other",
        },
        teamA: { id: teamA.toLowerCase().replace(/\s+/g, "-"), name: teamA },
        teamB: { id: teamB.toLowerCase().replace(/\s+/g, "-"), name: teamB },
        streamUrl: null,
      });
    });

    console.log(`[Scraper] Found ${matches.length} matches for ${tournamentName}`);
    return matches;
  } catch (error) {
    console.error("[Scraper] Error scraping matches:", error);
    return [];
  }
}

export async function scrapeAllUpcomingMatches(): Promise<ScrapedMatch[]> {
  try {
    const tournaments = await scrapeUpcomingTournaments();
    const allMatches: ScrapedMatch[] = [];

    for (const tournament of tournaments.slice(0, 5)) {
      // Limit to 5 tournaments to avoid timeout
      const matches = await scrapeMatchesForTournament(tournament.liquipediaUrl);
      allMatches.push(...matches);
    }

    console.log(`[Scraper] Total matches scraped: ${allMatches.length}`);
    return allMatches;
  } catch (error) {
    console.error("[Scraper] Error in scrapeAllUpcomingMatches:", error);
    return [];
  }
}
