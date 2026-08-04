import { NextRequest, NextResponse } from "next/server";
import { requireCaller, requireServiceRoleClient } from "@/lib/adminApiAuth";

// "Add contributor manually" from Manage Admins — admin-created, so it
// skips the pending-application step entirely: status is 'approved' from
// the start, same authority level as approving a public application.
// Needs the service-role client because it also creates the auth user
// (same invite-by-email pattern as create-admin).
export async function POST(req: NextRequest) {
  const auth = await requireCaller(req, "admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const name: string | undefined = body?.name?.trim();
  const email: string | undefined = body?.email?.trim();
  const socialPlatform: string | undefined = body?.social_platform;
  const socialHandle: string | undefined = body?.social_handle?.trim();
  if (!name || !email || !socialPlatform || !socialHandle) {
    return NextResponse.json({ error: "name, email, social_platform, and social_handle are required" }, { status: 400 });
  }

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });

  const { data: existing } = await svc.client.from("contributors").select("id").ilike("email", email).maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "A contributor with this email already exists." }, { status: 409 });
  }

  const origin = req.nextUrl.origin;
  const { data: invited, error: inviteError } = await svc.client.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/contributor/set-password`,
  });
  if (inviteError || !invited?.user) {
    return NextResponse.json({ error: inviteError?.message ?? "Failed to invite user" }, { status: 502 });
  }

  const { error: insertError } = await svc.client.from("contributors").insert({
    user_id: invited.user.id,
    name,
    social_platform: socialPlatform,
    social_handle: socialHandle,
    email,
    status: "approved",
    decided_at: new Date().toISOString(),
    decided_by: auth.callerAdminId,
  });
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
