import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Lets an admin kick off a Liquipedia sync on demand instead of waiting for
// the next cron tick (every 6h for tournaments/matches, every 6h offset by
// 3h for finished-match details) — same auth pattern as
// /api/telegram/notify: a service-role key isn't configured in this
// deployment, so the caller's own Supabase session + is_admin() RPC is
// what gates this, not a shared secret.
//
// Dispatches the actual GitHub Actions workflow rather than running the
// scraper inline — these jobs can take tens of minutes even after the
// stuck-workflow fixes, far past what a Vercel serverless function can
// run for, and they already have the correct rate-limit pacing/retry
// logic built in.
const WORKFLOWS: Record<string, string> = {
  tournaments: "liquipedia-import.yml",
  details: "liquipedia-import-details.yml",
};

const REPO_OWNER = "AhmadIchsanK";
const REPO_NAME = "livevival";

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
  const workflow: string | undefined = body?.workflow;
  const workflowFile = workflow ? WORKFLOWS[workflow] : undefined;
  if (!workflowFile) {
    return NextResponse.json(
      { error: `workflow must be one of: ${Object.keys(WORKFLOWS).join(", ")}` },
      { status: 400 }
    );
  }

  const token = process.env.GITHUB_ACTIONS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "Not configured — set GITHUB_ACTIONS_TOKEN (a GitHub PAT with Actions: write on this repo)." },
      { status: 503 }
    );
  }

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    return NextResponse.json({ error: `GitHub API error (${res.status}): ${errText}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
