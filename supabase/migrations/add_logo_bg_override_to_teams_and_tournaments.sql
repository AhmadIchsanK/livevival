-- Manual admin override for TeamLogo's backing-box color (components/TeamLogo.tsx),
-- for the rare logo the automatic light/dark luminance sampler gets wrong.
-- One of 'white' | 'grey' | 'ink' | 'surface' (see LOGO_BG_OVERRIDES in
-- TeamLogo.tsx) or null to keep today's auto-detected backing.
alter table teams
  add column if not exists logo_bg_override text;

alter table tournaments
  add column if not exists logo_bg_override text;

comment on column teams.logo_bg_override is
  'Manual admin override for TeamLogo backing color (white/grey/ink/surface). Null falls back to auto luminance-based detection.';
comment on column tournaments.logo_bg_override is
  'Manual admin override for TeamLogo backing color (white/grey/ink/surface). Null falls back to auto luminance-based detection.';
