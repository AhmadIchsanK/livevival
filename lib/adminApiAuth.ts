import { NextRequest } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Shared bearer-token -> is_admin()/is_super_admin() check used by every
// /api/admin/* route. Mirrors the pattern first written for
// /api/admin/refresh-liquipedia and /api/admin/create-admin — factored out
// now that several new routes (contributor add/revoke/promote, admin
// role-edit/delete) all need the identical caller-auth boilerplate.
export async function requireCaller(req: NextRequest, level: "admin" | "super_admin") {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return { error: "Missing Authorization header", status: 401 } as const;
  }

  const callerClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData } = await callerClient.auth.getUser();
  if (!userData?.user) {
    return { error: "Not authenticated", status: 401 } as const;
  }

  const rpcName = level === "super_admin" ? "is_super_admin" : "is_admin";
  const { data: allowed } = await callerClient.rpc(rpcName);
  if (!allowed) {
    return {
      error: level === "super_admin" ? "Super admin access required" : "Admin access required",
      status: 403,
    } as const;
  }

  const { data: adminRow } = await callerClient
    .from("admins")
    .select("id")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  return {
    callerClient,
    userId: userData.user.id,
    callerAdminId: (adminRow as { id: string } | null)?.id ?? null,
  } as const;
}

// Same 503-with-actionable-message pattern as the GITHUB_ACTIONS_TOKEN and
// original SUPABASE_SERVICE_ROLE_KEY checks elsewhere in this codebase.
export function requireServiceRoleClient(): { client: SupabaseClient } | { error: string; status: number } {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return {
      error: "Not configured — set SUPABASE_SERVICE_ROLE_KEY in this deployment's environment variables.",
      status: 503,
    };
  }
  return { client: createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey) };
}
