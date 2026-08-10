// Livevival — imports the canonical hero roster (name + icon) from
// Liquipedia so the admin panel and public site can show a real portrait
// next to every pick/ban instead of just text, and so pick/ban/roster data
// can be matched to a stable hero_id.
//
// Deliberately does NOT scrape the hand-styled "Portal:Heroes" grid page —
// that kind of page relies on template CSS classes that drift between
// tournaments' own overlay work and site redesigns (this is likely why
// scripts/import-liquipedia-team-rosters.mjs and
// import-liquipedia-region-rosters.mjs, which DO scrape hand-styled portal
// pages, have produced almost no rows in production).
//
// Names come from action=query&list=categorymembers&cmtitle=Category:Hero —
// the wiki's own categorization, stable across template changes.
//
// Icons: Liquipedia has a dedicated small square icon per hero, separate
// from the tall infobox portrait — filename convention
// "File:ML_icon_<HeroName>.png" (confirmed against a real URL the owner
// pasted from production: .../ML_icon_Aamon.png/85px-ML_icon_Aamon.png).
// Resolved via action=query&titles=File:...&prop=imageinfo rather than
// guessing the CDN path (MediaWiki shards file storage into a hash-prefixed
// directory — "1/14" in that example — that can't be computed without
// either the API or replicating MediaWiki's own hashing), which also
// degrades cleanly: if a hero's name doesn't match this convention exactly,
// the API just reports the file missing and this falls back to the old
// infobox-portrait scrape rather than erroring. Icons do NOT come from
// action=query&prop=pageimages: confirmed live that this wiki doesn't have
// the PageImages extension enabled at all ("Unrecognized value for
// parameter \"prop\": pageimages").
//
// Respects Liquipedia's API Terms of Use: custom User-Agent + contact
// email, only ever calls api.php, paced requests.
//
// Also scrapes lane/role/region metadata (owner request: keep these in
// sync with Liquipedia, same as name/icon). Deliberately reuses each
// hero's own infobox page rather than the hand-styled Portal:Heroes grid
// — same reasoning as the icon scrape above (drift-prone template CSS),
// and confirmed via a real job log (see PR) that Portal:Heroes' "Lane" /
// "Role" / "Region" tabs are just alternate groupings of that same grid,
// not a more reliable source. The per-hero infobox structure was
// confirmed live against Chou's page: `.infobox-description` cells
// labeled "Region:", "Role:", "Lane:" sit right next to their value cell
// — identical shape to the one backfill-player-photos.mjs already
// extracts "Name:"/"Nationality:" from, so getInfoboxRows() here is a
// deliberate copy of that helper (small enough, and each backfill/import
// script in this repo already keeps its own copy rather than sharing one
// — see backfill-hero-icons.mjs's note on the same tradeoff).
//
// role/lane/region are only ever filled in when null — like icon_url,
// once a value is scraped (or an admin sets one by hand) this script
// never overwrites it, so re-runs stay cheap: after the first full pass
// over the existing roster, only genuinely new heroes need the extra
// infobox fetch this does for metadata.
//
// SUSTAINED-THROTTLE FIX (confirmed via job 30967015229's real logs, run
// 2026-08-05T01:39Z, cancelled at the 90-minute cap): the "only fill a gap"
// logic above was never actually shrinking the backlog. 129 of 133 heroes'
// icon_url values still match the old /infobox/i pattern (never resolved
// to a small icon — see `needsUpgrade`) and 117 still have a null role/
// lane/region, so effectively the *entire* roster (132 of 133) needs at
// least one fetch every single run, not the handful "only new heroes"
// implied. Once Liquipedia's rate limiter engages a sustained block partway
// through a run (confirmed live: after ~15-20 clean requests, every
// following request — icon *and* metadata, for 5+ heroes straight — 429'd
// through all 6 of the shared client's default retries, ~7 minutes wasted
// per request with zero successes, for the rest of the run), the default
// retry budget can't ride it out: it just burns the 90-minute timeout on a
// handful of heroes without saving any of them, so the backlog barely
// moves. Two changes fix this, both already-established patterns in this
// repo (see backfill-hero-icons.mjs's BACKFILL_MAX_RETRIES, added for the
// identical symptom): a much smaller per-call retry budget so a throttled
// hero fails in ~1 minute instead of ~7 and the run can get through many
// more heroes instead of stalling on a few, and a hard per-run cap on how
// many heroes actually get fetched so a run can never again gamble its
// whole timeout on finishing the entire backlog in one pass — it just makes
// steady, bounded progress every 6 hours instead.

import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { apiQuery, fetchRenderedPage, sleep, splitBrSeparatedCell, arrayOrNull } from "./_liquipedia.mjs";
import { getAdminEditedFields, buildProvenanceGuardedUpdate } from "./_provenance.mjs";

const CATEGORY = process.env.LIQUIPEDIA_HERO_CATEGORY || "Category:Hero";

// Matches backfill-hero-icons.mjs's BACKFILL_MAX_RETRIES exactly (same
// failure mode, same fix): worst case per apiQuery/fetchRenderedPage call
// is 20s + 40s = 60s instead of the shared client's default ~7-minute/
// 6-retry budget. This script is safe to re-run indefinitely (every write
// is per-hero, immediate, and only fills a still-null/still-old-style
// field), so failing a throttled hero fast and letting the next 6-hourly
// run retry it (likely from a fresh runner/IP, so a fresh rate-limit
// window) beats burning the whole job timeout retrying the same handful of
// heroes.
const SAFE_RETRY_BUDGET = 2;

// Hard cap on how many heroes get an actual Liquipedia fetch (icon and/or
// metadata) in one run. Worst case if every attempted hero needs both
// fetches *and* both are fully throttled through SAFE_RETRY_BUDGET: 30 *
// ((60s retry wait + 4s pacing sleep) * 2 fetches) ≈ 64 minutes — well
// inside the 90-minute job timeout even with setup/checkout overhead, and
// far below it on any run that isn't fully throttled. Heroes beyond the cap
// are simply left for the next scheduled run (they stay in
// needsIconFetch/needsMetadataFetch since nothing was written for them).
const MAX_HEROES_PER_RUN = 30;

// Balance-patch-driven fields (stats, win rate, price) change far more
// often than a team's roster/socials — 3 days instead of teams' 7 keeps
// this closer to current without meaningfully increasing request volume
// (MAX_HEROES_PER_RUN already caps actual fetches regardless of how many
// heroes are technically "due").
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

const METADATA_COLUMNS = [
  "role",
  "lane",
  "region",
  "price_bp",
  "price_diamond",
  "specialty",
  "resource_bar",
  "voice_actors",
  "hp",
  "hp_regen",
  "energy",
  "energy_regen",
  "physical_attack",
  "physical_defense",
  "magic_power",
  "magic_defense",
  "attack_speed",
  "attack_speed_ratio",
  "movement_speed",
  "win_rate_pct",
  "win_rate_record",
  "release_year",
];

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function fetchAllHeroTitles() {
  const titles = [];
  let cmcontinue;
  do {
    const data = await apiQuery({
      action: "query",
      list: "categorymembers",
      cmtitle: CATEGORY,
      cmlimit: "500",
      cmtype: "page",
      ...(cmcontinue ? { cmcontinue } : {}),
    });
    const members = data.query?.categorymembers ?? [];
    for (const m of members) titles.push(m.title);
    cmcontinue = data.continue?.cmcontinue;
    if (cmcontinue) await sleep(4000);
  } while (cmcontinue);
  return titles;
}

async function fetchHeroSmallIcon(heroName) {
  const filename = `ML_icon_${heroName.replace(/ /g, "_")}.png`;
  const data = await apiQuery(
    {
      action: "query",
      titles: `File:${filename}`,
      prop: "imageinfo",
      iiprop: "url",
    },
    1,
    SAFE_RETRY_BUDGET
  );
  const pages = data.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  return page.imageinfo?.[0]?.url ?? null;
}

async function fetchHeroInfoboxPortrait(title) {
  const html = await fetchRenderedPage(title, 1, SAFE_RETRY_BUDGET);
  const $ = cheerio.load(html);
  // Same infobox structure confirmed on team pages: light/dark image
  // variants both under .infobox-image, light listed first. Try that
  // specific variant before falling back to the bare selector in case a
  // hero page's infobox doesn't split by mode at all.
  let src = $(".infobox-image.lightmode img").first().attr("src");
  if (!src) src = $(".infobox-image img").first().attr("src");
  if (!src) return null;
  return src.startsWith("http") ? src : `https://liquipedia.net${src}`;
}

async function fetchHeroIcon(title) {
  const smallIcon = await fetchHeroSmallIcon(title);
  if (smallIcon) return smallIcon;
  // Falls back to the full portrait for any hero whose name doesn't match
  // the ML_icon_<Name>.png convention exactly — better than no image at all.
  // Extra pacing here since this is a second sequential request for the
  // same hero, on top of the caller's own per-hero sleep.
  await sleep(4000);
  return fetchHeroInfoboxPortrait(title);
}

// Same infobox-row lookup backfill-player-photos.mjs uses for player
// pages (`.infobox-description` label cell + its adjacent value cell) —
// deliberately duplicated rather than imported, matching this repo's
// existing per-script-copy convention for this exact helper.
function getInfoboxRows($) {
  const rows = new Map();
  $(".infobox-description").each((_, el) => {
    const label = $(el).text().trim().replace(/:$/, "").toLowerCase();
    rows.set(label, $(el).next());
  });
  return rows;
}

// Confirmed live against Chou's rendered infobox: Role/Lane values sit
// next to a small icon `<img>` with empty alt text, so cheerio's .text()
// on the value cell already returns just the label text. A hero flexed
// across two lanes/roles renders each on its own line via <br> — swapped
// for " / " first so those don't get silently concatenated with no
// separator.
function cleanInfoboxValue(cell) {
  if (!cell) return null;
  cell.find("br").replaceWith(" / ");
  const text = cell.text().replace(/\s+/g, " ").trim();
  return text || null;
}

// Confirmed against Ling's real infobox: "price" concatenates a Battle
// Points icon+number and a Diamond icon+number with no separator in plain
// text ("32000 599" for cell.text()) — walk the cell's own child nodes in
// DOM order instead, tracking which icon's alt text most recently
// preceded each number so the two currencies never get confused.
function parsePriceCell($, cell) {
  const result = { bp: null, diamond: null };
  if (!cell || cell.length === 0) return result;
  let currentLabel = null;
  cell.contents().each((_, node) => {
    if (node.type === "tag" && node.name === "img") {
      const alt = ($(node).attr("alt") || "").toLowerCase();
      if (alt.includes("battle")) currentLabel = "bp";
      else if (alt.includes("diamond")) currentLabel = "diamond";
      else currentLabel = null;
    } else if (node.type === "text" && currentLabel && result[currentLabel] == null) {
      const match = $(node).text().match(/\d+/);
      if (match) result[currentLabel] = Number(match[0]);
    }
  });
  return result;
}

function parseNumericCell(cell) {
  if (!cell) return null;
  const match = cell.text().replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// "2196W : 2139L (50.66%)" — the percentage is what's actually useful to
// sort/filter on; the W/L record is kept as-is alongside it rather than
// parsed further (not worth two more integer columns for a value this
// rarely displayed on its own).
function parseWinRateCell(cell) {
  if (!cell) return { pct: null, record: null };
  const text = cell.text().trim();
  const pctMatch = text.match(/\(([\d.]+)%\)/);
  const record = text.replace(/\s*\([\d.]+%\)\s*$/, "").trim() || null;
  return { pct: pctMatch ? Number(pctMatch[1]) : null, record };
}

// Some heroes' "Release Date" field is only a bare year ("2019"); without
// a reliable full date across the whole roster, this is stored as
// release_year rather than a `date` column that would need guessing a
// month/day that was never actually on the page.
function parseReleaseYear(cell) {
  if (!cell) return null;
  const match = cell.text().match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

function extractHeroMetadata($) {
  const rows = getInfoboxRows($);
  const price = parsePriceCell($, rows.get("price"));
  const winRate = parseWinRateCell(rows.get("win rate"));
  return {
    role: cleanInfoboxValue(rows.get("role")),
    lane: cleanInfoboxValue(rows.get("lane")),
    region: cleanInfoboxValue(rows.get("region")),
    price_bp: price.bp,
    price_diamond: price.diamond,
    specialty: arrayOrNull(splitBrSeparatedCell($, rows.get("specialty"))),
    resource_bar: cleanInfoboxValue(rows.get("resource bar")),
    voice_actors: arrayOrNull(splitBrSeparatedCell($, rows.get("voice actor(s)"))),
    hp: parseNumericCell(rows.get("hp")),
    hp_regen: parseNumericCell(rows.get("hp regen")),
    energy: parseNumericCell(rows.get("energy")),
    energy_regen: parseNumericCell(rows.get("energy regen")),
    physical_attack: parseNumericCell(rows.get("physical attack")),
    physical_defense: parseNumericCell(rows.get("physical defense")),
    magic_power: parseNumericCell(rows.get("magic power")),
    magic_defense: parseNumericCell(rows.get("magic defense")),
    attack_speed: parseNumericCell(rows.get("attack speed")),
    attack_speed_ratio: parseNumericCell(rows.get("attack speed ratio")),
    movement_speed: parseNumericCell(rows.get("movement speed")),
    win_rate_pct: winRate.pct,
    win_rate_record: winRate.record,
    release_year: parseReleaseYear(rows.get("release date")),
  };
}

async function fetchHeroMetadata(title) {
  const html = await fetchRenderedPage(title, 1, SAFE_RETRY_BUDGET);
  const $ = cheerio.load(html);
  return extractHeroMetadata($);
}

async function upsertHero(name, iconUrl, metadata) {
  const { data: existing } = await supabase
    .from("heroes")
    .select(`id, icon_url, last_liquipedia_sync_at, ${METADATA_COLUMNS.join(", ")}`)
    .eq("name", name)
    .maybeSingle();

  if (existing) {
    const update = {};
    // Fill in a missing icon, or upgrade an old infobox-portrait URL (this
    // script's own earlier output, before the small-icon source existed) to
    // the new small icon — but never touch a value that's neither: that's
    // either already a good small icon or something an admin set by hand.
    // Kept as its own rule (not routed through the generic provenance
    // guard below) since "only overwrite this one specific low-quality
    // state" isn't the same rule as "only overwrite when not admin-edited."
    const isUpgradeable = !existing.icon_url || /infobox/i.test(existing.icon_url);
    if (iconUrl && isUpgradeable && iconUrl !== existing.icon_url) update.icon_url = iconUrl;

    if (metadata) {
      const hasExistingValues = METADATA_COLUMNS.some((f) => existing[f] != null);
      const adminEditedFields = hasExistingValues
        ? await getAdminEditedFields(supabase, "heroes", existing.id)
        : new Set();
      const { payload, skipped } = buildProvenanceGuardedUpdate(existing, metadata, adminEditedFields);
      Object.assign(update, payload);
      if (skipped.length > 0) console.log(`  ${name}: kept admin-edited value(s) for ${skipped.join(", ")}`);
      // Only stamp when a metadata fetch actually happened this run — this
      // is what the staleness check orders by, so stamping it on every
      // call (even the ones where `metadata` is null because this hero
      // wasn't due/didn't fit this run's cap) would make a never-refreshed
      // hero look freshly synced and let it silently fall out of rotation.
      update.last_liquipedia_sync_at = new Date().toISOString();
    }

    if (Object.keys(update).length === 0) return;
    const { error } = await supabase.from("heroes").update(update).eq("id", existing.id);
    if (error) console.error(`Failed to update "${name}":`, error.message);
    return;
  }

  const { error } = await supabase.from("heroes").insert({
    name,
    liquipedia_slug: name.replace(/ /g, "_"),
    icon_url: iconUrl,
    last_liquipedia_sync_at: new Date().toISOString(),
    ...Object.fromEntries(METADATA_COLUMNS.map((f) => [f, metadata?.[f] ?? null])),
  });
  if (error && !error.message.includes("duplicate key")) {
    console.error(`Failed to insert hero "${name}":`, error.message);
  } else if (!error) {
    console.log(`Added hero: ${name}${iconUrl ? "" : " (no icon found)"}`);
  }
}

async function main() {
  console.log(`Fetching hero list from ${CATEGORY}...`);
  const titles = await fetchAllHeroTitles();
  console.log(`Found ${titles.length} hero page(s)`);

  if (titles.length === 0) {
    console.error(
      `No pages found in "${CATEGORY}" — the category name may differ on this wiki. ` +
        `Set LIQUIPEDIA_HERO_CATEGORY to override.`
    );
    console.error("Looking up real category names containing 'hero' to help pick the right one...");
    try {
      const discovery = await apiQuery({ action: "query", list: "allcategories", acprefix: "Hero", aclimit: "50" });
      const candidates = (discovery.query?.allcategories ?? []).map((c) => c["*"] ?? c.category);
      console.error(candidates.length > 0 ? `Candidates: ${candidates.join(", ")}` : "No categories starting with 'Hero' found either.");
    } catch (err) {
      console.error("Category discovery failed:", err.message);
    }
    process.exit(1);
  }

  // Only fetch a per-hero page for heroes that don't already have a *good*
  // icon — this is what makes re-runs cheap (a handful of new/renamed
  // heroes per patch) instead of re-fetching all ~130 pages every 6 hours
  // forever. "Good" excludes the old infobox-portrait URLs this script used
  // to produce before the small-icon source existed, so those get upgraded
  // once and then left alone.
  const { data: existingHeroes } = await supabase
    .from("heroes")
    .select(`name, icon_url, last_liquipedia_sync_at, ${METADATA_COLUMNS.join(", ")}`);
  const needsUpgrade = new Set(
    (existingHeroes ?? []).filter((h) => !h.icon_url || /infobox/i.test(h.icon_url)).map((h) => h.name)
  );
  // Gap-fill: any hero missing so much as one of the now much-larger
  // METADATA_COLUMNS set (previously just role/lane/region) still needs a
  // fetch every run until nothing's left null.
  const heroHasGap = (h) => METADATA_COLUMNS.some((f) => h[f] == null);
  const now = Date.now();
  const isStale = (h) =>
    !h.last_liquipedia_sync_at || now - new Date(h.last_liquipedia_sync_at).getTime() > STALE_AFTER_MS;
  const gapHeroes = new Set((existingHeroes ?? []).filter(heroHasGap).map((h) => h.name));
  // Periodic refresh: an already-complete hero whose stats/win-rate could
  // have moved with a balance patch since the last check — this is the
  // part that makes hero data actually stay "always up to date" instead
  // of freezing the moment every column first fills in.
  const staleHeroes = new Set((existingHeroes ?? []).filter((h) => !heroHasGap(h) && isStale(h)).map((h) => h.name));
  const knownNames = new Set((existingHeroes ?? []).map((h) => h.name));
  const needsIconFetch = new Set(titles.filter((t) => !knownNames.has(t) || needsUpgrade.has(t)));
  const needsMetadataFetch = new Set(
    titles.filter((t) => !knownNames.has(t) || gapHeroes.has(t) || staleHeroes.has(t))
  );

  console.log(`${needsIconFetch.size} of ${titles.length} hero(es) need an icon fetch this run`);
  console.log(
    `${needsMetadataFetch.size} of ${titles.length} hero(es) need a metadata fetch this run ` +
      `(${gapHeroes.size} with a gap, ${staleHeroes.size} complete-but-stale)`
  );

  // Cap actual fetching to MAX_HEROES_PER_RUN (see header comment). Gap-
  // fill heroes (never-scraped data) are prioritized over pure staleness
  // re-checks (already-good data just due for a refresh) when both
  // compete for the same run's budget — titles are processed in page
  // order within each group, so this still naturally advances through the
  // roster over successive scheduled runs rather than always reattempting
  // a fixed subset. Anything past the cap still gets upserted below (so a
  // brand-new hero's row exists even before its own fetch happens) but
  // with no network fetch, leaving it flagged as needing one on the next
  // run.
  const needsAnyFetch = [
    ...titles.filter((t) => needsIconFetch.has(t) || gapHeroes.has(t) || !knownNames.has(t)),
    ...titles.filter((t) => staleHeroes.has(t) && !needsIconFetch.has(t) && !gapHeroes.has(t)),
  ];
  const fetchableThisRun = new Set(needsAnyFetch.slice(0, MAX_HEROES_PER_RUN));
  console.log(
    `${fetchableThisRun.size} of ${needsAnyFetch.length} hero(es) needing work will actually be fetched this run (capped at ${MAX_HEROES_PER_RUN})`
  );

  for (const title of titles) {
    let iconUrl = null;
    if (needsIconFetch.has(title) && fetchableThisRun.has(title)) {
      try {
        iconUrl = await fetchHeroIcon(title);
      } catch (err) {
        console.error(`Failed to fetch icon for "${title}":`, err.message);
      }
      await sleep(4000);
    }

    let metadata = null;
    if (needsMetadataFetch.has(title) && fetchableThisRun.has(title)) {
      try {
        metadata = await fetchHeroMetadata(title);
      } catch (err) {
        console.error(`Failed to fetch role/lane/region for "${title}":`, err.message);
      }
      await sleep(4000);
    }

    await upsertHero(title, iconUrl, metadata);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
