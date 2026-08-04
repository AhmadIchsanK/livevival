import { NextRequest, NextResponse } from "next/server";
import { requireCaller, requireServiceRoleClient } from "@/lib/adminApiAuth";

// Full removal, not just a status flip — the point is that the email is
// completely free again afterward so the person can reapply from scratch.
// Order matters: the contributors row goes first (cascades their
// edit_requests per the migration), then the auth user itself, since
// contributors.user_id -> auth.users has no ON DELETE action and would
// block deleting the auth user first.
export async function POST(req: NextRequest) {
  const auth = await requireCaller(req, "admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const contributorId: string | undefined = body?.contributorId;
  if (!contributorId) return NextResponse.json({ error: "contributorId is required" }, { status: 400 });

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });

  const { data: contributor, error: fetchError } = await svc.client
    .from("contributors")
    .select("user_id")
    .eq("id", contributorId)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!contributor) return NextResponse.json({ error: "Contributor not found" }, { status: 404 });

  const { error: deleteRowError } = await svc.client.from("contributors").delete().eq("id", contributorId);
  if (deleteRowError) return NextResponse.json({ error: deleteRowError.message }, { status: 500 });

  const { error: deleteUserError } = await svc.client.auth.admin.deleteUser(
    (contributor as { user_id: string }).user_id
  );
  if (deleteUserError) return NextResponse.json({ error: deleteUserError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
