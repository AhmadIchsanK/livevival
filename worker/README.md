# Livevival worker — always-on Liquipedia poller

This is a separate, always-on Node.js process (Railway, not Vercel —
serverless functions can't stay alive polling on a tight loop). It replaces
the old Groq-vision livestream watcher: instead of reading a video frame,
it re-fetches Liquipedia's own match data every ~20 seconds for whichever
tournaments currently have a live or soon-to-start match, and writes
schedule, score, per-game winners, picks/bans, and VOD links straight to
Supabase.

## Why a separate process instead of just running the cron more often

GitHub Actions cron has a practical floor around 5 minutes between runs.
Getting materially closer to real-time for a match that's live right now
needs a long-running loop, not a faster schedule — that's this process.
Everything that ISN'T time-sensitive (discovering brand-new tournaments,
historical backfill, team/hero rosters) stays on the existing 6-hourly
`.github/workflows/liquipedia-import.yml` cron; this worker only ever
touches tournaments that already have a match in progress or starting soon.

## What it does, every tick (`POLL_INTERVAL_SECONDS`, default 20s)

1. Finds every match with `update_source = 'liquipedia'`, not yet
   `finished`, scheduled within the last `RECENT_WINDOW_HOURS` (default 6)
   or the next `IMMINENT_WINDOW_HOURS` (default 2).
2. Groups those by tournament (one Liquipedia page fetch covers every match
   in that tournament, not one fetch per match).
3. Re-parses that tournament's bracket page and:
   - updates `matches.status`/`format`/`stream_id` (schedule sync)
   - if a match is now finished on Liquipedia: writes `games`
     (per-game winner + VOD), `hero_picks_bans` (with `hero_id` resolved
     against the `heroes` table), and the series winner (finished-match
     sync)

## `update_source` — the admin's escape hatch

A match defaults to `update_source = 'liquipedia'`. If Liquipedia won't have
a piece of live detail in time (it only reflects what wiki editors have
entered), an admin can flip a match to `update_source = 'local_ocr'` from
its live console — this worker then skips that match entirely, and the
admin's local-capture session (in the Next.js admin app, not this worker)
becomes the sole writer for it. This worker never overwrites a
`local_ocr` match, even for schedule fields.

## Environment variables

- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — service role, since this
  writes to tables directly and bypasses RLS.
- `POLL_INTERVAL_SECONDS` (default 20), `IMMINENT_WINDOW_HOURS` (default 2),
  `RECENT_WINDOW_HOURS` (default 6) — all optional, tune as needed.

No `GROQ_*` variables are used anymore — safe to remove them from the
Railway service.

## Rate limiting

`liquipediaClient.mjs` enforces a process-wide minimum 2-second gap between
any two Liquipedia requests, matching their API Terms of Use, regardless of
how many tournaments are active in a given tick.

## Running it

```bash
npm install
npm start
```

On Railway: this service already points at this `worker/` subdirectory
with `npm start` as the start command — no change needed there, just the
env var cleanup above and a redeploy.
