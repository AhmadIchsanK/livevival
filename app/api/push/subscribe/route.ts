import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Stores a browser's push subscription for one match/tournament "follow".
// No auth required — following is a public fan-facing action, same as
// this repo's other unauthenticated public writes. The anon key is enough
// here because push_subscriptions' RLS policy explicitly allows public
// INSERT (see the migration); there's no service-role credential in this
// deployment for this route to use even if it wanted one.
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

const VALID_ENTITY_TYPES = ["match", "tournament"];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const endpoint: string | undefined = body?.endpoint;
  const p256dh: string | undefined = body?.p256dh;
  const auth: string | undefined = body?.auth;
  const entityType: string | undefined = body?.entityType;
  const entityId: string | undefined = body?.entityId;

  if (!endpoint || !p256dh || !auth || !entityType || !entityId) {
    return NextResponse.json(
      { error: "Missing one of: endpoint, p256dh, auth, entityType, entityId." },
      { status: 400 }
    );
  }
  if (!VALID_ENTITY_TYPES.includes(entityType)) {
    return NextResponse.json({ error: `entityType must be one of: ${VALID_ENTITY_TYPES.join(", ")}` }, { status: 400 });
  }

  // ignoreDuplicates (INSERT ... ON CONFLICT DO NOTHING) rather than a real
  // upsert — re-tapping "follow" for the same match in the same browser
  // just no-ops instead of erroring on the unique constraint or piling up
  // duplicate rows that would each fire a separate push. Deliberately not
  // ON CONFLICT DO UPDATE: that requires an UPDATE RLS policy too, which
  // this table intentionally doesn't have (see the migration) since the
  // anon key should only ever be able to insert here.
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      { endpoint, p256dh, auth, entity_type: entityType, entity_id: entityId },
      { onConflict: "endpoint,entity_type,entity_id", ignoreDuplicates: true }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
