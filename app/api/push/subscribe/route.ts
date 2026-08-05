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

  // Plain insert, not .upsert()/onConflict — confirmed against the live DB
  // that .upsert() (even with ignoreDuplicates) makes postgrest-js request
  // the affected row back (an implicit RETURNING), and Postgres enforces
  // RLS on that RETURNING projection the same as a SELECT. This table
  // deliberately has no SELECT policy for anon/authenticated (subscription
  // endpoints/keys shouldn't be publicly readable), so that RETURNING check
  // always failed with "new row violates row-level security policy" even
  // though the INSERT's own WITH CHECK (unconditionally true) was never the
  // problem — reproduced directly against the DB: the identical INSERT
  // succeeds under role anon once RETURNING is dropped. A plain .insert()
  // never requests a row back, so it doesn't hit this at all. Re-tapping
  // "follow" for the same match hits the unique constraint instead — same
  // duplicate-key-is-fine pattern already used elsewhere in this codebase
  // (see worker/src/telegram.mjs's notifyOnce).
  const { error } = await supabase
    .from("push_subscriptions")
    .insert({ endpoint, p256dh, auth, entity_type: entityType, entity_id: entityId });

  if (error && !error.message.includes("duplicate key")) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
