// Shared "was this field ever hand-edited by an admin" check, used by any
// scraper that periodically re-checks an already-complete row (as opposed
// to the older gap-fill-only pattern of just skipping any row with no
// nulls left). Without this, a periodic re-scrape would silently revert
// an admin's manual correction the next time it ran.
//
// Built on `activity_log` (added by the admin/contributor migration —
// see add_admin_roles_contributors_activity_log.sql): a `security definer`
// trigger already logs every INSERT/UPDATE on teams/heroes/players with
// `actor_id` set to auth.uid() at write time. Confirmed via direct query
// that a scraper's service-role writes land with actor_id = null, while a
// real logged-in admin's edit lands with their real UUID — so "was the
// last real change to this field made by a human" is answerable purely
// from existing data, no new per-row admin-edit columns needed.
import { createClient } from "@supabase/supabase-js";

/**
 * Returns the set of column names on `tableName` row `rowId` whose current
 * value was last set by a real admin (non-null actor_id) rather than a
 * scraper (null actor_id) or never changed since insert. Callers should
 * skip overwriting any field in this set when refreshing an already
 * non-null value — a null field has nothing to protect and can always be
 * gap-filled regardless.
 *
 * Walks changed_at desc so the FIRST entry that actually changed a given
 * field's value is that field's most recent real change — every field is
 * resolved independently and only once (whichever entry answers it first
 * wins), so this is one query per row, not one per field.
 */
export async function getAdminEditedFields(supabase, tableName, rowId) {
  const { data, error } = await supabase
    .from("activity_log")
    .select("actor_id, old_data, new_data")
    .eq("table_name", tableName)
    .eq("row_id", rowId)
    .order("changed_at", { ascending: false })
    .limit(200);
  if (error || !data) return new Set();

  const resolved = new Set();
  const adminEdited = new Set();
  for (const entry of data) {
    const oldData = entry.old_data ?? {};
    const newData = entry.new_data ?? {};
    const fields = new Set([...Object.keys(oldData), ...Object.keys(newData)]);
    for (const field of fields) {
      if (resolved.has(field)) continue;
      const before = JSON.stringify(oldData[field] ?? null);
      const after = JSON.stringify(newData[field] ?? null);
      if (before === after) continue;
      resolved.add(field);
      if (entry.actor_id) adminEdited.add(field);
    }
  }
  return adminEdited;
}

/**
 * Builds the update payload for a periodic re-scrape: for each candidate
 * field, gap-fills unconditionally when the current row has no value yet,
 * otherwise only overwrites when the scraped value actually differs AND
 * the field wasn't last set by a human (per getAdminEditedFields). Returns
 * {payload, skipped} — skipped lists fields left alone because of an
 * admin edit, for callers that want to log it.
 */
export function buildProvenanceGuardedUpdate(currentRow, scrapedFields, adminEditedFields) {
  const payload = {};
  const skipped = [];
  for (const [field, value] of Object.entries(scrapedFields)) {
    if (value === undefined || value === null) continue;
    const current = currentRow[field];
    if (current === null || current === undefined) {
      payload[field] = value;
      continue;
    }
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    if (adminEditedFields.has(field)) {
      skipped.push(field);
      continue;
    }
    payload[field] = value;
  }
  return { payload, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Ad-hoc smoke test: node scripts/_provenance.mjs <table> <rowId>
  const [, , tableName, rowId] = process.argv;
  if (!tableName || !rowId) {
    console.error("Usage: node scripts/_provenance.mjs <table> <rowId>");
    process.exit(1);
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const fields = await getAdminEditedFields(supabase, tableName, rowId);
  console.log(`Admin-edited fields on ${tableName}/${rowId}:`, [...fields]);
}
