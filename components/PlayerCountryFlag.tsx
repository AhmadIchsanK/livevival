import { countryCodeToFlagEmoji, countryCodeToName } from "@/lib/countryFlag";

// players.country_codes can hold 1 or 2 ISO codes (Liquipedia lists dual
// nationality for a handful of players) — the owner asked for "flag only,
// hover to know which country or add 2 country code as indicator", so this
// renders both: an emoji flag per code (hover = full country name) plus
// the raw codes as a small text badge underneath.
export function PlayerCountryFlag({ codes, className = "" }: { codes: string[] | null | undefined; className?: string }) {
  if (!codes || codes.length === 0) return null;
  return (
    <div className={`flex flex-col items-center gap-0.5 ${className}`}>
      <span className="text-base leading-none" title={codes.map(countryCodeToName).join(" / ")}>
        {codes.map((c) => countryCodeToFlagEmoji(c)).join(" ")}
      </span>
      <span className="text-[9px] text-white/40 uppercase tracking-wide">{codes.join("/")}</span>
    </div>
  );
}
