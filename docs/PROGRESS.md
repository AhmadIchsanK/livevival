# Livevival feature audit — progress tracker

**Status (2026-08-02, later same day): the two remaining credential
blockers are now resolved.** Owner supplied the Telegram bot token +
chat ID and a YouTube Data API key. Both wired in (PRs #13–#15, see
below). The only genuinely open item is OCR real-world calibration,
which needs the admin to actually run a capture session (live or VOD) —
in progress, see "OCR calibration" below.

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
- [x] Heroes admin icon import: only 26/133 had icons. Fixed two gaps in
      the shared Liquipedia client (scripts/_liquipedia.mjs AND its worker
      counterpart worker/src/liquipediaClient.mjs) — neither passed
      redirects=1, so a hero page that's actually a redirect returned
      near-empty content silently; and the icon selector didn't try the
      confirmed .lightmode infobox variant first. Both fixes apply to
      every script using these shared clients, not just heroes.
- [x] Streams auto-detect started/ended: implemented as a DB trigger
      (recompute_stream_status(), fires on matches status/stream_id
      changes) rather than client-side polling — live the moment a linked
      match goes live, ended once every linked match is finished. Backfilled
      existing linked streams immediately. Mirrored in
      supabase/migrations/auto_sync_stream_status_from_matches.sql.
- [x] Stream auto-import (~2min) + per-game VOD auto-import (hourly+):
      **already fully working** via the existing always-on worker
      (deployed on Railway, confirmed healthy and ticking every 20s live
      in the logs) — syncTournamentSchedule() auto-creates+links a stream
      the moment Liquipedia's match popup has a YouTube URL, and
      syncTournamentFinishedMatches() writes per-game vod_url from
      Liquipedia's "Watch Game N" links every tick, both running every
      ~20s for any tournament with a live/imminent match — far exceeds
      both the 2-minute and 1-hour asks. The public match page already
      prioritizes per-game vod_url and falls back to the whole-stream URL
      exactly as requested. The only unmet piece is the MLBB-official-
      YouTube-channel fallback for matches where Liquipedia itself has no
      per-game VOD — the owner offered this as an alternative ("or we can
      always check..."), not a hard requirement, and I didn't build it:
      no YouTube Data API key available, and I can't verify a channel-ID/
      RSS-based scraper against real content from this sandboxed session
      (same network block as Liquipedia). Flagging as backlog, not faking
      it blind.
- [x] OCR automation foundation: found that a full vision-AI pipeline
      (Groq vision model + screenshot capture + winner-confirmation
      frames — orphaned env vars still on the Railway service: 
      GROQ_API_KEY, GROQ_VISION_MODEL, SCREENSHOT_BUCKET,
      WINNER_CONFIRMATION_FRAMES) was already built in a prior session and
      *deliberately replaced* by the current Liquipedia-polling worker
      (see commit d9a9fe5, "Replace Groq vision worker with always-on
      Liquipedia poller"). That's the right call to stick with — Liquipedia
      polling already automates status/score/picks/bans/results for every
      match on update_source='liquipedia', which is the large majority of
      what "auto-detect match status" was asking for. The remaining local-
      OCR system (browser screen capture + Tesseract.js, calibrated
      capture_regions, for matches manually flagged update_source=
      'local_ocr') already existed reading timer/gold/kill-banner text —
      added one honest improvement: auto-transition to GAME_STARTED once
      the timer becomes readable. Deliberately did NOT attempt icon-based
      auto-detection of the draft/pick-ban phase — the existing code
      already documents why (hero icons have no text, scoreboard rows
      vary too much for reliable OCR) and I have no way to verify vision
      logic against a real stream from this sandbox, so forcing it would
      repeat the exact "shipped blind, worked in ~20% of cases" mistake
      already fixed once this session (team-roster scrapers).
- [x] Telegram bot infrastructure — outbound-only (no bot commands,
      no webhook). Automatic from the always-on worker: match went live,
      15-min-before reminder, per-game result, match finished — deduped
      via a new `telegram_notifications` table. Admin-controlled from the
      live console for what the worker can't automate (Liquipedia has no
      live picks/bans feed for an in-progress series): an "Announce
      draft" button and a per-key-moment post button, plus automatic
      game/match results specifically for `update_source='local_ocr'`
      matches, which the worker skips entirely. New `/api/telegram/notify`
      route authorizes via the caller's own Supabase session + `is_admin()`
      RPC, no service-role key needed in the Next.js deployment.
      **Cannot go live without a BotFather token only the owner can
      create** — everything else is built and will start working the
      moment `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set (see the
      header comment in `worker/src/telegram.mjs` for the exact steps).
- [x] Fan feature recommendations writeup — `docs/fan-feature-recommendations.md`,
      also published as a Claude Artifact during the session. Grouped into
      catching-up features, stay-in-the-loop features, deeper-stats
      features, and smaller polish items, each tagged by whether it's
      buildable now with existing data or needs new collection/integration
      work.

- [x] Fixed the actual cause of the slow team-logo/player-role backfill
      (PR #13): `import-team-details.mjs` was re-fetching all 301 teams
      from Liquipedia on every single 6h run, even ones already fully
      populated — unlike the hero-icon importer, which already skipped
      completed rows. With Liquipedia's rate limiting, a full re-scan
      routinely exceeded GitHub Actions' 6h hard job cap and got force-
      cancelled before reaching the back half of the team list (confirmed:
      the two most recent scheduled runs both died at ~6h05m). Now skips
      any team that already has a logo and a fully-roled known roster.
      Cancelled the stale in-flight run and triggered fresh runs on the
      fix immediately rather than waiting for the next cron.
- [x] Telegram bot activated (PR was infrastructure-only before this):
      owner provided `TELEGRAM_BOT_TOKEN` and a chat ID, both set on the
      Railway worker. Chat ID given as `1004485997391` (positive, no
      sign) — this exactly matches Telegram's `-100<10 digits>`
      supergroup/channel ID format with the leading `-100` sign dropped
      (`1004485997391` = `100` + `4485997391`), so it was set as
      `-1004485997391`. **Not verified against the live Telegram API** —
      this sandbox's network denies `api.telegram.org` outbound (confirmed
      via a 403 on the proxy tunnel, same class of block as
      `liquipedia.net`/`*.supabase.co`), so this is inference from
      Telegram's documented ID scheme, not a tested value. If bot messages
      don't show up in the target group, this sign is the first thing to
      check. **Still needed:** the same two vars on the Next.js app's
      Vercel project (no Vercel tool available in this session) — without
      it, the worker's automatic notifications work but the admin
      console's "Announce draft"/key-moment buttons (which call
      `/api/telegram/notify` in the Next.js deployment) won't.
- [x] MLBB official YouTube channel VOD fallback built (PR #14): owner
      supplied a YouTube Data API key, set as `YOUTUBE_API_KEY` on the
      Railway worker. New `worker/src/youtubeVodFallback.mjs` searches
      @mlbbesportsofficial (channel ID confirmed live via `channels.list`:
      `UCMncR-XXNXhMyJELEgCrHlg`) for a matching "Game N" upload when a
      finished game still has no vod_url after Liquipedia's own per-game
      links. Requires both team names AND a "Game N" title match before
      accepting a result. Gated to at most once/hour, scans a 14-day
      backlog window, no-ops if the key is ever unset. Found and fixed a
      real bug this depended on: `finishedMatchSync.mjs`'s upsert always
      wrote `vod_url` including `null`, which would've erased whatever
      this fallback found on the very next tick — now only written when
      Liquipedia actually has a value.
- [ ] OCR calibration: owner confirmed testing against a past VOD
      (paused/replayed in a browser tab) instead of a live stream — the
      capture code (`getDisplayMedia`) is source-agnostic, this works and
      is arguably better for calibration (repeatable, no time pressure).
      Not yet run — this is the one item that needs a human at the
      keyboard, not something to build further blind.

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
- MLBB official YouTube channel as a fallback VOD source (owner offered
  this as optional, not required) — needs either a YouTube Data API key
  or a channel-ID/RSS scraper I can't verify against real content from
  this sandbox (same liquipedia.net-style network block). Not built.

## Data backfill status (as of 2026-08-02 ~06:35 UTC)

The team-logo/player-role scraper (`import-team-details.mjs`) and the
now-fixed hero-icon scraper are both mid-backfill: 28/301 teams have a
logo, 119/1,119 players have a role, 39/133 heroes have an icon — all up
from 0/0/26 respectively when this session started, so the fixes are
confirmed working, just slow. Progress stalled for a stretch (likely
Liquipedia's short-term rate limiter, not a bug — the same pattern that
required cancelling one earlier stuck run). Not intervening further:
these are `continue-on-error` cron jobs that already run every 6h
regardless (`liquipedia-import.yml`, `liquipedia-import-details.yml`),
so the backfill completes on its own schedule even if this particular
manually-triggered run stalls out. No admin action needed.
