import { NextRequest, NextResponse } from "next/server";
import { requireCaller, requireServiceRoleClient } from "@/lib/adminApiAuth";
import { flags } from "@/lib/featureFlags";
import type { IngestPayload } from "@/lib/reconstruction/persistence";

// Reconstruction shadow persistence sink (spec Phase 1).
// POST /api/admin/reconstruction/ingest   (admin bearer token required)
//
// The admin capture loop posts the newly-confirmed events + current snapshot
// here after each shadow tick; this route persists them with the service-role
// key. Writes are idempotent:
//   - game_events:          upsert ON CONFLICT (game_id, event_id) → ignore
//   - confirmed_game_state: upsert ON CONFLICT (game_id) → update
// so a retried/duplicated tick never double-counts. Gated by
// RECONSTRUCTION_PERSISTENCE (returns 204 when off) so the tables can exist
// without anything writing until persistence is deliberately enabled. This
// never touches legacy tables and never affects public reads (which stay on
// the legacy path until RECONSTRUCTION_PUBLIC_READS is separately enabled).
export async function POST(req: NextRequest) {
  if (!flags.reconstructionPersistence) {
    // Disabled — accept-and-ignore so the client's fire-and-forget call is a
    // clean no-op rather than an error it has to handle.
    return new NextResponse(null, { status: 204 });
  }
  const auth = await requireCaller(req, "admin");
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const svc = requireServiceRoleClient();
  if ("error" in svc) return NextResponse.json({ error: svc.error }, { status: svc.status });
  const supabase = svc.client;

  let payload: IngestPayload;
  try {
    payload = (await req.json()) as IngestPayload;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!payload?.gameId || !payload.snapshot) {
    return NextResponse.json({ error: "missing gameId/snapshot" }, { status: 400 });
  }

  // Events: idempotent append. onConflict on the (game_id, event_id) unique
  // constraint, ignoreDuplicates so a re-delivered event is a no-op.
  if (Array.isArray(payload.events) && payload.events.length > 0) {
    const { error } = await supabase
      .from("game_events")
      .upsert(payload.events, { onConflict: "game_id,event_id", ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: `events: ${error.message}` }, { status: 500 });
  }

  // Snapshot: one row per game, monotonic state_version. Guard against an
  // out-of-order write regressing the version (safe retry behavior).
  const { data: existing } = await supabase
    .from("confirmed_game_state")
    .select("state_version")
    .eq("game_id", payload.gameId)
    .maybeSingle();
  const existingVersion = (existing as { state_version: number } | null)?.state_version ?? -1;
  if (payload.snapshot.state_version >= existingVersion) {
    const { error } = await supabase
      .from("confirmed_game_state")
      .upsert(
        {
          game_id: payload.snapshot.game_id,
          match_id: payload.snapshot.match_id,
          status: payload.snapshot.status,
          state_version: payload.snapshot.state_version,
          timer_seconds: payload.snapshot.timer_seconds,
          state: payload.snapshot.state,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "game_id" }
      );
    if (error) return NextResponse.json({ error: `snapshot: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true, events: payload.events?.length ?? 0, stateVersion: payload.snapshot.state_version });
}
