// Small icon-button row for a team's website + socials, rendered beneath
// the team name on the public teams page (and in the mini-profile preview).
// This codebase has no icon library dependency (see PlayerLinks, which
// renders text-abbreviation badges for the same reason) — these are minimal
// inline SVGs in the same currentColor/16x16-viewBox style already used by
// ViewToggle, so no new dependency is introduced.
export type TeamLinkFields = {
  website_url?: string | null;
  twitter_url?: string | null;
  instagram_url?: string | null;
  facebook_url?: string | null;
  youtube_url?: string | null;
  discord_url?: string | null;
};

const LINKS: { key: keyof TeamLinkFields; label: string; icon: React.ReactNode }[] = [
  {
    key: "website_url",
    label: "Website",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
        <ellipse cx="8" cy="8" rx="2.6" ry="6.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M1.5 8h13" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    key: "twitter_url",
    label: "X",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M1.5 1.5l5.2 6.9-5.5 6.1h1.7l4.8-5.3 3.7 5.3h3.1l-5.4-7.3 5.1-5.7h-1.7l-4.5 5-3.4-5H1.5z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  {
    key: "instagram_url",
    label: "Instagram",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="11.8" cy="4.2" r="0.9" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "facebook_url",
    label: "Facebook",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M9.4 14.3V8.7h1.7l.26-2H9.4V5.4c0-.58.16-.97 1-.97h1.06V2.65A14 14 0 0010 2.55c-1.5 0-2.53.92-2.53 2.6v1.55H5.8v2h1.67v5.6"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    key: "youtube_url",
    label: "YouTube",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1" y="3.3" width="14" height="9.4" rx="2.6" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6.6 6.2l4 2-4 2z" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "discord_url",
    label: "Discord",
    icon: (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M4.2 3.6A11 11 0 0111.8 3.6l.4.9c1.6.5 2.3 1.5 2.3 1.5.6 3.2-.2 5-.2 5s-1.1 1-2.4 1.3l-.5-1s.4-.2.8-.5c-1.9.9-4.7.9-6.6 0 .4.3.8.5.8.5l-.5 1c-1.3-.3-2.4-1.3-2.4-1.3s-.8-1.8-.2-5c0 0 .7-1 2.3-1.5l.4-.9z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
        <ellipse cx="6.1" cy="8.9" rx="1" ry="1.1" fill="currentColor" />
        <ellipse cx="9.9" cy="8.9" rx="1" ry="1.1" fill="currentColor" />
      </svg>
    ),
  },
];

export function TeamSocialLinks({ team, className = "" }: { team: TeamLinkFields; className?: string }) {
  const present = LINKS.filter((l) => team[l.key]);
  if (present.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {present.map((l) => (
        <a
          key={l.key}
          href={team[l.key] as string}
          target="_blank"
          rel="noopener noreferrer"
          title={l.label}
          aria-label={l.label}
          onClick={(e) => e.stopPropagation()}
          className="w-6 h-6 flex items-center justify-center rounded-full border border-white/10 text-white/50 hover:text-signal hover:border-signal/50 hover:bg-signal/10 transition-colors"
        >
          {l.icon}
        </a>
      ))}
    </div>
  );
}
