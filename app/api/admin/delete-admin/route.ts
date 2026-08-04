import { NextRequest, NextResponse } from "next/server";
import { requireCaller, requireServiceRoleClient } from "@/lib/adminApiAuth";

// Deletes the auth user outright (admins.user_id -> auth.users is ON
// DELETE CASCADE, so the admins row goes with it automatically). Guards
// against self-deletion and against removing the last super_admin, since
// either would strand the account with nobody able to manage admins.
export async function POST(req: NextRequest) {
  const auth = await requireCaller(req, "super_admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const adminId: string | undefined = body?.adminId;
  if (!adminId) return NextResponse.json({ error: "adminId is required" }, { status: 400 });

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });

  const { data: target, error: fetchError } = await svc.client
    .from("admins")
    .select("user_id, role")
    .eq("id", adminId)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: "Admin not found" }, { status: 404 });

  const typedTarget = target as { user_id: string; role: string };

  if (typedTarget.user_id === auth.userId) {
    return NextResponse.json({ error: "You can't delete your own admin account." }, { status: 400 });
  }

  if (typedTarget.role === "super_admin") {
    const { count } = await svc.client.from("admins").select("id", { count: "exact", head: true }).eq("role", "super_admin");
    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: "Can't delete the last super admin." }, { status: 400 });
    }
  }

  const { error: deleteError } = await svc.client.auth.admin.deleteUser(typedTarget.user_id);
  if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
