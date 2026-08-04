import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Adds a new admin — super_admin only. Same caller-auth pattern as
// /api/admin/refresh-liquipedia (bearer token -> anon-key client scoped to
// the caller -> is_admin() RPC), plus an is_super_admin() check on top
// since regular admins can't add new admins.
//
// Creating the actual Supabase Auth user needs the service-role key (this
// is the first route in the app to need it — every other admin route so
// far has avoided it). That key isn't provisioned in this deployment as of
// this writing (confirmed: no SUPABASE_SERVICE_ROLE_KEY anywhere in
// app/ or .env.local, only in scripts/GitHub Actions secrets) — it needs
// to be added to the Vercel project's env vars before this route works in
// production. Fails with a clear 503 rather than a generic error if unset,
// matching refresh-liquipedia's GITHUB_ACTIONS_TOKEN-missing pattern.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return NextResponse.json({ error: "Missing Authorization header" }, { status: 401 });
  }

  const callerClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData } = await callerClient.auth.getUser();
  if (!userData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: isSuperAdmin } = await callerClient.rpc("is_super_admin");
  if (!isSuperAdmin) {
    return NextResponse.json({ error: "Super admin access required" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const email: string | undefined = body?.email?.trim();
  const role: string | undefined = body?.role;
  if (!email || (role !== "admin" && role !== "super_admin")) {
    return NextResponse.json({ error: "email and role ('admin' | 'super_admin') are required" }, { status: 400 });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return NextResponse.json(
      { error: "Not configured — set SUPABASE_SERVICE_ROLE_KEY in this deployment's environment variables." },
      { status: 503 }
    );
  }

  const adminClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey);

  // Sends Supabase's own invite email with a link for the new admin to set
  // their own password — avoids us generating/storing a temp password.
  const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(email);
  if (inviteError || !invited?.user) {
    return NextResponse.json({ error: inviteError?.message ?? "Failed to invite user" }, { status: 502 });
  }

  const { error: insertError } = await adminClient
    .from("admins")
    .insert({ user_id: invited.user.id, email, role });
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
