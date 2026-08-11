import { NextResponse } from "next/server";
import { getMatchState } from "@/lib/confirmedState";

// Public confirmed-state API (spec §26, §27) — the stable contract the public
// live page can consume without knowing the source of the data or running any
// validation itself (spec: "the frontend must NOT run validation logic").
//
// GET /api/public/match-state/:id
//
// Returns the confirmed game state for every game in the match: timer, team
// kills, per-player K/D/A, net worth (with xx.xK display), objectives, turret
// state, plus a per-game stateVersion for reconnect/missed-update detection.
// Exposes ONLY confirmed data — never candidate or rejected observations.
//
// During an OCR gap this endpoint keeps returning the last confirmed values
// (they are persisted; nothing writes zeros when a reading is missing), so a
// public client refresh/reconnect never resets live stats to zero.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const payload = await getMatchState(params.id);
    if (!payload) {
      return NextResponse.json({ error: "match not found" }, { status: 404 });
    }
    return NextResponse.json(payload, {
      headers: {
        // Short edge cache; live clients poll/subscribe for fresher data.
        "Cache-Control": "public, s-maxage=5, stale-while-revalidate=15",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
