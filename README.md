# Livevival — Phase 1 skeleton

This is a minimal, working Next.js site wired up to Supabase. It doesn't do anything
useful yet — its only job is to prove the full pipeline (code → GitHub → Vercel →
Supabase) works end to end before we build real features on top of it.

## Get this onto GitHub (no local git needed)

1. Unzip this folder on your computer.
2. Go to https://github.com/new — name the repository `livevival`, keep it **Public**
   (required later for the Liquipedia API terms), and click **Create repository**.
3. On the new repo's page, click **"uploading an existing file"**.
4. Drag the entire unzipped `livevival` folder (all its contents, including the
   hidden `.gitignore` file) into the upload box. Most browsers preserve the folder
   structure when you drag a whole folder — make sure the files land at the repo's
   root, not inside an extra `livevival/` subfolder.
5. Scroll down and click **Commit changes**.

## Deploy it to Vercel

1. Go to https://vercel.com/new
2. Click **Import** next to your `livevival` repository (Vercel should list it
   automatically since your accounts are linked through GitHub).
3. Before clicking Deploy, open **Environment Variables** and add two:
   - `NEXT_PUBLIC_SUPABASE_URL` — from Supabase Dashboard → your project →
     **Project Settings → API → Project URL**
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from the same API settings page,
     under **Project API keys → anon public**
4. Click **Deploy**. Vercel will build the project and give you a live URL like
   `livevival.vercel.app` within a minute or two.

## What "done" looks like

Visit your new `.vercel.app` URL. You should see a dark page that says **Livevival**
with a green dot and "Supabase connection: OK". If the dot is red, double-check the
two environment variable values against your Supabase dashboard, then redeploy
(Vercel → your project → Deployments → ⋯ → Redeploy).

Once that green dot shows up, Phase 1 is complete — tell me and we'll move to
Phase 2 (setting up the real database tables).

## Match automation

`supabase/schema.sql` adds the tables/columns for automated match tracking:
`streams` (one broadcast URL → many matches), `matches.state` /
`games.state` (the MATCH_NOT_STARTED → STREAM_ENDED lifecycle), and
`key_moments` additions for match tracking with screenshots.

The website supports two data sources for match updates:

1. **Liquipedia** (`update_source = 'liquipedia'`): Synced every 6 hours via GitHub Actions cron job
   - Runs `.github/workflows/liquipedia-import.yml` automatically
   - Updates schedule, scores, picks/bans, VOD links
   - Historical data backfill
   - Max 6-hour latency for data updates

2. **Local OCR** (`update_source = 'local_ocr'`): Real-time manual capture via admin console
   - Admins use the live admin panel (`/admin/matches/[id]/live`) to enter data
   - OCR can auto-detect team stats and picks with Tesseract.js
   - Full control over data accuracy
   - Can be toggled per-match as needed
   - Suitable for time-sensitive broadcasts
