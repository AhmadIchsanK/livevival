// Renders a player's Liquipedia-sourced nationality (players.country_codes,
// an ISO 3166-1 alpha-2 array — up to 2 entries for a dual-nationality
// player) as a flag with a readable hover/label, without hosting or
// proxying flag image assets: every ISO code maps deterministically to a
// pair of Unicode regional indicator symbols, which render as an emoji
// flag on every platform that ships flag emoji (all major OSes/browsers
// except some Linux desktop stacks, which fall back to showing the two
// letters — still legible, just not a pretty icon).
export function countryCodeToFlagEmoji(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return upper;
  const REGIONAL_INDICATOR_OFFSET = 0x1f1e6 - 65; // "A".charCodeAt(0)
  return String.fromCodePoint(
    ...Array.from(upper).map((c) => c.charCodeAt(0) + REGIONAL_INDICATOR_OFFSET)
  );
}

// Only needs to cover countries that actually show up in an MLBB
// playerbase (the scraper's own COUNTRY_NAME_TO_CODE table in
// scripts/backfill-player-photos.mjs is the source of truth for which
// codes can appear) — falls back to showing the bare code for anything
// not listed here rather than guessing a name.
const COUNTRY_NAMES: Record<string, string> = {
  ID: "Indonesia",
  PH: "Philippines",
  MY: "Malaysia",
  SG: "Singapore",
  MM: "Myanmar",
  KH: "Cambodia",
  TH: "Thailand",
  VN: "Vietnam",
  LA: "Laos",
  BN: "Brunei",
  TL: "East Timor",
  BR: "Brazil",
  AR: "Argentina",
  CL: "Chile",
  PE: "Peru",
  CO: "Colombia",
  MX: "Mexico",
  BO: "Bolivia",
  EC: "Ecuador",
  PY: "Paraguay",
  UY: "Uruguay",
  VE: "Venezuela",
  DO: "Dominican Republic",
  US: "United States",
  CA: "Canada",
  CN: "China",
  KR: "South Korea",
  JP: "Japan",
  IN: "India",
  PK: "Pakistan",
  BD: "Bangladesh",
  NP: "Nepal",
  LK: "Sri Lanka",
  TR: "Turkey",
  RU: "Russia",
  UA: "Ukraine",
  KZ: "Kazakhstan",
  UZ: "Uzbekistan",
  MN: "Mongolia",
  SA: "Saudi Arabia",
  AE: "United Arab Emirates",
  KW: "Kuwait",
  QA: "Qatar",
  EG: "Egypt",
  MA: "Morocco",
  DZ: "Algeria",
  TN: "Tunisia",
  NG: "Nigeria",
  ZA: "South Africa",
  AU: "Australia",
  NZ: "New Zealand",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  ES: "Spain",
  PT: "Portugal",
  IT: "Italy",
  PL: "Poland",
  SE: "Sweden",
};

export function countryCodeToName(code: string): string {
  const upper = code.trim().toUpperCase();
  return COUNTRY_NAMES[upper] ?? upper;
}
