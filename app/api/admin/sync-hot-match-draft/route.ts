import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Lets an admin re-check one Hot match's hero picks/bans against
// Liquipedia when the live OCR draft tracker got a hero wrong — same auth
// pattern as /api/admin/refresh-liquipedia (caller's own session +
// is_admin() RPC, no service-role key configured in this deployment), and
// the same "dispatch a GitHub Actions workflow instead of running the
// scraper inline" reasoning: a Vercel serverless function's runtime isn't
// long enough for Liquipedia's rate-limit-paced fetch/retry cycle.
//
// Scoped to a single match — see scripts/sync-hot-match-picks-bans.mjs for
// why this never touches kill stats, the moment list, or match/game state,
// only which hero was picked/banned.
const REPO_OWNER = "AhmadIchsanK";
const REPO_NAME = "livevival";
const WORKFLOW_FILE = "sync-hot-match-draft.yml";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: isAdmin } = await supabase.rpc("is_admin");
  if (!isAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const matchId: string | undefined = body?.matchId;
  if (!matchId) {
    return NextResponse.json({ error: "matchId is required" }, { status: 400 });
  }

  const token = process.env.GITHUB_ACTIONS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Not configured — set GITHUB_ACTIONS_TOKEN (a GitHub PAT with Actions: write on this repo)." },
      { status: 503 }
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { match_id: matchId } }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json({ error: `GitHub API error (${res.status}): ${errText}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
