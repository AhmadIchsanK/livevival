import { supabase } from "@/lib/supabaseClient";

export type FieldDiff = Record<string, { before: unknown; after: unknown }>;

export type EntityType = "tournament" | "team" | "player" | "hero" | "match" | "stream";

// Builds the {field: {before, after}} shape every contributor edit-request
// form submits — only includes fields that actually changed, so the
// admin-side diff view (app/admin/contributor-requests) only shows what's
// really being proposed.
export function buildFieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[]
): FieldDiff {
  const diff: FieldDiff = {};
  for (const field of fields) {
    const b = before[field] ?? null;
    const a = after[field] ?? null;
    if (b !== a) diff[field] = { before: b, after: a };
  }
  return diff;
}

export async function getCurrentContributorId(): Promise<string | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return null;
  const { data } = await supabase.from("contributors").select("id").eq("user_id", userId).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function submitEditRequest({
  entityType,
  entityId,
  action,
  proposedChanges,
  contributorId,
}: {
  entityType: EntityType;
  entityId: string | null;
  action: "create" | "update";
  proposedChanges: FieldDiff;
  contributorId: string;
}) {
  return supabase.from("edit_requests").insert({
    contributor_id: contributorId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    proposed_changes: proposedChanges,
  });
}
