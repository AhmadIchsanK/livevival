import { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";

// Promotes an existing approved contributor to an admin: reuses their
// existing auth user (they already have a password from applying — no new
// invite needed), inserts the admins row, then removes the contributors
// row (cascades their edit_requests — full history stays in activity_log
// via the log_activity trigger already on both tables, so nothing is
// actually lost, just moved out of the live queue).
export async function promoteContributorToAdmin(
  svc: SupabaseClient,
  contributor: { id: string; user_id: string; email: string; name: string },
  role: "admin" | "super_admin"
) {
  const { error: insertError } = await svc
    .from("admins")
    .insert({ user_id: contributor.user_id, email: contributor.email, role });
  if (insertError) throw new Error(insertError.message);

  const { error: deleteError } = await svc.from("contributors").delete().eq("id", contributor.id);
  if (deleteError) throw new Error(deleteError.message);

  await sendEmail(
    contributor.email,
    "Your LIVEVIVAL access has been upgraded",
    `<p>Hi ${contributor.name},</p><p>Your contributor account has been promoted to ${
      role === "super_admin" ? "Super Admin" : "Admin"
    }. Sign in with your existing password at the admin login.</p>`
  ).catch(() => {});
}
