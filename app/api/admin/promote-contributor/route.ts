import { NextRequest, NextResponse } from "next/server";
import { requireCaller, requireServiceRoleClient } from "@/lib/adminApiAuth";
import { promoteContributorToAdmin } from "@/lib/contributorPromotion";

// Explicit "Promote" button in Manage Admins — same effect as create-admin
// auto-detecting a matching contributor email, just triggered directly on
// a specific contributor row. super_admin only, since it's equivalent to
// adding a new admin.
export async function POST(req: NextRequest) {
  const auth = await requireCaller(req, "super_admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => null);
  const contributorId: string | undefined = body?.contributorId;
  const role: string | undefined = body?.role;
  if (!contributorId || (role !== "admin" && role !== "super_admin")) {
    return NextResponse.json({ error: "contributorId and role ('admin'|'super_admin') are required" }, { status: 400 });
  }

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });

  const { data: contributor, error: fetchError } = await svc.client
    .from("contributors")
    .select("id, user_id, email, name")
    .eq("id", contributorId)
    .maybeSingle();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  if (!contributor) return NextResponse.json({ error: "Contributor not found" }, { status: 404 });

  const typedContributor = contributor as { id: string; user_id: string; email: string; name: string };

  const { data: existingAdmin } = await svc.client
    .from("admins")
    .select("id")
    .eq("user_id", typedContributor.user_id)
    .maybeSingle();
  if (existingAdmin) return NextResponse.json({ error: "This person is already an admin." }, { status: 409 });

  try {
    await promoteContributorToAdmin(svc.client, typedContributor, role as "admin" | "super_admin");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to promote." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
