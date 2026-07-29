# Livevival worker — automated match & key-moment detection

This is a separate, always-on Node.js process. It does **not** run on Vercel
(serverless functions can't stay alive watching a stream) — deploy it as its
own Railway service, alongside the Nukhba bot pattern you're already using.

## What it does

Every few seconds, for each stream row with `status IN ('scheduled','live')`:
1. Grabs one frame from the livestream (`ffmpeg` + `yt-dlp`).
2. Sends it to Groq's vision model, asking for structured JSON: current
   phase, visible team names, a winner if a result screen is showing, and
   whether a SAVAGE/MANIAC/LORD_STEAL/etc. banner is up.
3. Figures out which scheduled match (if the stream covers several) is
   currently live, by matching visible team names against the schedule.
4. Advances `matches.state` / `games.state` through the requested lifecycle,
   requiring several consecutive agreeing frames before committing a winner.
5. Logs key moments to `key_moments` with `source='auto'`, a confidence
   score, and an uploaded screenshot.

Admins can flip `matches.auto_managed = false` at any point (e.g. from the
live console) to fall back to fully manual control for a specific match —
the worker skips any match with that flag off.

## Requirements on the host

- **Node 20+**
- **ffmpeg** on PATH — on Railway, add a `nixpacks.toml` with:
  ```toml
  [phases.setup]
  nixPkgs = ["ffmpeg"]
  ```
- `yt-dlp`-compatible extraction via the `youtube-dl-exec` npm package
  (it vendors its own binary, no separate install needed).

## Environment variables

Copy `.env.example` to `.env` and fill in:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — service role, not anon, since
  this writes to tables directly and bypasses RLS.
- `GROQ_API_KEY` — from console.groq.com.
- `GROQ_VISION_MODEL` — double-check the current vision-capable model name
  on Groq's docs before deploying; model availability changes over time.
- Polling intervals and the winner-confirmation frame count are tunable —
  see the comments in `.env.example`.

## Supabase Storage setup (one-time)

Create a public bucket named `key-moment-screenshots` (or whatever you set
`SCREENSHOT_BUCKET` to) so `keyMoments.mjs` can upload frames and get back a
public URL for the site to display.

## Running it

```bash
npm install
npm start
```

On Railway: point a new service at this `worker/` subdirectory, set the env
vars above, and set the start command to `npm start`.

## Overlay support (requirement #9)

Rather than hardcoding pixel coordinates per tournament overlay, the Groq
prompt asks the model to reason over the whole frame. For a tournament whose
HUD is unusual enough to confuse the default prompt, set
`streams.overlay_template` to a short free-text hint (e.g. "kill banners
appear in a red ticker at the very top of the screen") — it gets appended to
the prompt for that stream only.

## Known limitations / next tuning steps

- Winner detection depends entirely on the result screen being legible in
  the captured frame — a heavily animated victory sequence may need the
  confirmation-frame count raised.
- Liquipedia doesn't publish livestream URLs — those still need to be
  attached to a `streams` row manually (or via the existing YouTube-title
  detection flow in the admin panel) until/unless a per-tournament stream
  source becomes available.
- This polls one frame at a time per stream; if you're watching many
  concurrent streams, watch your Groq rate limits.
