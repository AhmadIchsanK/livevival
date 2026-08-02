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
      cron, and manually triggered via workflow_dispatch on 2026-08-02 —
      check GitHub Actions for its run status; once it completes it
      backfills the (at last count) 1,100 null player roles / 301 null
      team logos.
- [x] Full brand kit applied (logo, colors, typography, favicons)
- [x] Matches admin + live console: optimistic status toggle (fixed the
      "slow LIVE" complaint — was a real UX bug, row vanished mid
      round-trip with no feedback), per-game map field + declare-winner
      control + previous-games summary, picks now record player_id so
      the scoreboard shows only the 5 players actually picked (role-
      ordered), delete added on objectives/key moments (picks/bans
      already had it)
- [x] Public match page: BO1/BO2/BO5/BO7 — page itself was already
      format-agnostic (counts real game wins); real bug was the admin
      match form's dropdown only offering BO1/BO3/BO5 despite the DB and
      importer supporting all five (confirmed 34 existing BO7 matches).
      Fixed the dropdown. Also switched picks display to the direct
      player_id link instead of a fragile hero-name text match.
- [x] Public /tournaments: search/tier-filter/sort added; completed
      section defaults to 8 most recent (uncapped when filtering);
      upcoming stays uncapped (already Tier S/A only)
- [x] Per-tournament finished page: FMVP (new tournaments.fmvp_player_id
      column, admin-settable via IGN autocomplete, shown only if set —
      Liquipedia doesn't expose this scrapably), total prize pool (summed
      from existing tournament_results data), team logos in standings,
      "Player performances" leaderboard built from existing player_stats
      (no new data source needed). "Advanced to next stage" scoped out —
      would need new scraper work to parse stage/bracket linkage that
      doesn't exist in the current data model.
- [x] Homepage: calendar already existed from a prior session — extended
      it to mark finished-match days too (previously only upcoming/live),
      recolored the day-marker to green. Investigated "MPL ID S18 not
      detected": tournament is correctly imported with correct dates, has
      zero matches yet same as every other upcoming tournament — looks
      like Liquipedia hasn't published those brackets, not an importer
      bug. That investigation found and fixed a real bug instead: bare-
      year date strings ("2026") parsed as Jan 1 via `new Date()`,
      corrupting 2 tournaments' end_date to before their start_date and
      misclassifying them as completed — fixed parser + repaired prod
      rows directly.
- [x] Team logos on public site: homepage cards, match detail header,
      per-tournament match list, tournament page standings.
- [ ] Heroes admin: icon auto-import bug — in progress
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
