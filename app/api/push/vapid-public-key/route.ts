import { NextResponse } from "next/server";

// Hands the client the VAPID public key it needs for PushManager.subscribe.
// Read server-side from VAPID_PUBLIC_KEY (no NEXT_PUBLIC_ prefix) rather
// than baking it into the client bundle at build time — this is the same
// key the worker's send path uses under the identical env var name, so
// there's exactly one place this ever needs to be set per deployment
// (Vercel), and rotating it needs no rebuild.
//
// Same clear-503 pattern as /api/admin/refresh-liquipedia when a key this
// route needs isn't provisioned yet — the "follow" button reads this and
// no-ops with an explanatory message instead of throwing.
export async function GET() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) {
    return NextResponse.json(
      { error: "Push notifications aren't configured yet — set VAPID_PUBLIC_KEY." },
      { status: 503 }
    );
  }
  return NextResponse.json({ publicKey });
}
