import { NextRequest, NextResponse } from "next/server";
import { requireCaller, requireServiceRoleClient } from "@/lib/adminApiAuth";
import { promoteContributorToAdmin } from "@/lib/contributorPromotion";

// Adds a new admin — super_admin only.
//
// If the email already belongs to an approved contributor, this promotes
// that existing account instead of inviting a new one: they already have a
// password, so no invite email is needed — see lib/contributorPromotion.ts.
// Otherwise it sends Supabase's own invite email with a link for the new
// admin to set their own password at /admin/set-password.
export async function POST(req: NextRequest) {
  const auth = await requireCaller(req, "super_admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const email: string | undefined = body?.email?.trim();
  const role: string | undefined = body?.role;
  if (!email || (role !== "admin" && role !== "super_admin")) {
    return NextResponse.json({ error: "email and role ('admin' | 'super_admin') are required" }, { status: 400 });
  }

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });

  const { data: existingAdmin } = await svc.client.from("admins").select("id").ilike("email", email).maybeSingle();
  if (existingAdmin) {
    return NextResponse.json({ error: "This email is already an admin." }, { status: 409 });
  }

  const { data: existingContributor } = await svc.client
    .from("contributors")
    .select("id, user_id, email, name")
    .ilike("email", email)
    .eq("status", "approved")
    .maybeSingle();

  if (existingContributor) {
    try {
      await promoteContributorToAdmin(
        svc.client,
        existingContributor as { id: string; user_id: string; email: string; name: string },
        role as "admin" | "super_admin"
      );
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to promote." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, promoted: true });
  }

  const origin = req.nextUrl.origin;
  const { data: invited, error: inviteError } = await svc.client.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${origin}/admin/set-password`,
  });
  if (inviteError || !invited?.user) {
    return NextResponse.json({ error: inviteError?.message ?? "Failed to invite user" }, { status: 502 });
  }

  const { error: insertError } = await svc.client.from("admins").insert({ user_id: invited.user.id, email, role });
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
