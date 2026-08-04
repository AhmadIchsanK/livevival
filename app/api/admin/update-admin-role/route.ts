import { NextRequest, NextResponse } from "next/server";
import { requireCaller, requireServiceRoleClient } from "@/lib/adminApiAuth";

// admins has no client-side UPDATE policy at all (only "read own admin
// row" SELECT) — role edits have to go through the service role, gated to
// super_admin here.
export async function POST(req: NextRequest) {
  const auth = await requireCaller(req, "super_admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const adminId: string | undefined = body?.adminId;
  const role: string | undefined = body?.role;
  if (!adminId || (role !== "admin" && role !== "super_admin")) {
    return NextResponse.json({ error: "adminId and role ('admin'|'super_admin') are required" }, { status: 400 });
  }

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });

  const { data: target, error: fetchError } = await svc.client.from("admins").select("role").eq("id", adminId).maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: "Admin not found" }, { status: 404 });

  if ((target as { role: string }).role === "super_admin" && role === "admin") {
    const { count } = await svc.client.from("admins").select("id", { count: "exact", head: true }).eq("role", "super_admin");
    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: "Can't demote the last super admin." }, { status: 400 });
    }
  }

  const { error: updateError } = await svc.client.from("admins").update({ role }).eq("id", adminId);
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
