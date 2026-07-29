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
