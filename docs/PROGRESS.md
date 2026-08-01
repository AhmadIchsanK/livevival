# Livevival feature audit — progress tracker

Working from the owner's full feature request (admin CRUD audit + public
site audit + fan features + future Telegram bot). This file is the source
of truth for what's done vs. pending — updated as each piece lands.
Continuation happens autonomously via a scheduled Routine that resumes
this session; if you're reading this cold (new session, heavily
summarized context), check `git log --oneline -30` across branches and
this file together to reconstruct state before doing anything.

Standing authorization from the owner (2026-08-01): pick priorities, keep
going without asking, all PR creation/merges pre-approved, find your own
alternative for anything blocked, resume after any interruption
(including credit-limit resets) until the list below is done or genuinely
blocked on something only the owner can supply (a credential, a design
decision with no reasonable default).

## Done (merged to main)

- [x] RLS enabled on heroes/tournament_results/capture_regions (was
      silently disabled in prod — anyone with the anon key could write to
      these tables)
- [x] Teams admin: logo field, short_name display fix, merge-duplicates
      action (`merge_teams` RPC)
- [x] Players admin: role dropdown (5 standard roles), role filter, sort
- [x] Tournaments admin: Ongoing/Upcoming/Completed sections, status
      filter, sort
- [x] Streams admin: auto-fetch YouTube title → overlay hint, thumbnail
      preview, tournament filter, sort, fixed tournament_id edit bug
- [x] New scraper `scripts/import-team-details.mjs` — replaces two
      broken importers, pulls team logo + per-player role from each
      team's own Liquipedia page in one fetch. Wired into the 6-hourly
      cron. **Not yet run against prod data** — needs a cron fire or
      manual `workflow_dispatch` to actually backfill the 1,100 null
      player roles / 301 null team logos.
- [x] Full brand kit applied (logo, colors, typography, favicons)

## In progress / pending — in priority order

- [ ] Matches admin + live console: slow LIVE toggle, live console data
      display (per-game results, per-player hero picks, role-ordered
      pick/ban, map setting), full CRUD in console
- [ ] Public match page: BO1/BO2/BO5/BO7 display (reported limited to
      BO3), VOD/picks-bans/KDA audit
- [ ] Public /tournaments: filter/search/sort, default-view rules
- [ ] Per-tournament finished page: rank/FMVP/prizepool/advancement,
      team+player achievement sections
- [ ] Homepage: month calendar view (green match-days), tournament
      coverage audit (MPL ID S18 missing, "not all Tier S/A included")
- [ ] Team logos on public site (match cards, tournament pages)
- [ ] Heroes admin: icon auto-import bug
- [ ] Streams: auto-detect started/ended
- [ ] Stream auto-import (~2min delay) + per-game VOD auto-import
      (Liquipedia hourly, MLBB YouTube channel fallback)
- [ ] OCR automation foundation (capture_regions-driven, auto phase
      detection) — will ship as far as buildable without live
      calibration; flagging that clearly rather than claiming it's fully
      verified against a real stream
- [ ] Telegram bot infrastructure — will be built and ready to deploy,
      but **cannot go live without a BotFather token only the owner can
      create**. This is a hard blocker I can't find an alternative for;
      everything else about the bot (notification logic, admin controls)
      will be built regardless.
- [ ] Fan feature recommendations writeup

## Known hard blockers (not workaroundable, flagged not skipped)

- This sandbox's outbound network denies `liquipedia.net` and
  `*.supabase.co` directly (browser/curl) — confirmed via proxy 403s.
  Doesn't block production (GitHub Actions runners have normal network),
  only blocks live-testing scrapers *from this session*. Worked around
  for the team-roster scraper by having the owner paste sample HTML;
  same approach if another scraper needs real-markup verification.
- Telegram bot token — inherently a credential only the account owner can
  mint via @BotFather. Infrastructure will be built regardless.
- OCR real-world accuracy — genuinely needs the admin's PC running the
  capture page against a real live stream to calibrate/verify. Will ship
  the most complete pipeline possible and say plainly what's unverified.
