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

  // Optional per-tournament targeting: a comma-separated list of liquipedia_slug
  // values re-syncs just those, bypassing the past-year window and table order —
  // the exact override used to repair a single tournament fast (e.g. when a
  // finished match hasn't picked up its result yet) instead of waiting for a
  // full pass to reach it. Blank/absent = normal full pass.
  const rawSlugs: unknown = body?.tournamentSlugs;
  const tournamentSlugs =
    typeof rawSlugs === "string"
      ? rawSlugs.split(",").map((s) => s.trim()).filter(Boolean).join(",")
      : "";

  // Audit-log helper — best-effort; a logging failure must never block the sync.
  const logTrigger = async (status: "dispatched" | "error", detail?: string) => {
    try {
      await supabase.from("sync_log").insert({
        triggered_by: userData.user?.email ?? userData.user?.id ?? null,
        workflow,
        tournament_slugs: tournamentSlugs || null,
        status,
        detail: detail ?? null,
      });
    } catch {
      /* audit log is non-critical */
    }
  };

  const token = process.env.GITHUB_ACTIONS_TOKEN;
  if (!token) {
    await logTrigger("error", "GITHUB_ACTIONS_TOKEN not configured");
    return NextResponse.json(
      { error: "Not configured — set GITHUB_ACTIONS_TOKEN (a GitHub PAT with Actions: write on this repo)." },
      { status: 503 }
    );
  }

  // Both workflows expose a `tournament_slugs` workflow_dispatch input; only
  // send it when targeting, so a full pass keeps the input at its blank default.
  const inputs = tournamentSlugs ? { tournament_slugs: tournamentSlugs } : undefined;

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    await logTrigger("error", `GitHub API ${res.status}: ${errText}`.slice(0, 500));
    return NextResponse.json({ error: `GitHub API error (${res.status}): ${errText}` }, { status: 502 });
  }

  await logTrigger("dispatched");
  return NextResponse.json({ ok: true, targeted: tournamentSlugs || null });
}
