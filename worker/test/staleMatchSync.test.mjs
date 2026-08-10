process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

import { describe, expect, it, vi } from "vitest";
import { thresholdHours, findStaleMatches, forceFinishStaleMatches } from "../src/staleMatchSync.mjs";

describe("thresholdHours", () => {
  it("matches the admin's own BO3 number exactly", () => {
    expect(thresholdHours("BO3")).toBe(6);
  });

  it("scales with max games for other formats", () => {
    expect(thresholdHours("BO1")).toBe(4);
    expect(thresholdHours("BO5")).toBe(8);
    expect(thresholdHours("BO7")).toBe(11);
  });

  it("falls back to the BO3 threshold for an unknown/missing format", () => {
    expect(thresholdHours(null)).toBe(6);
    expect(thresholdHours("nonsense")).toBe(6);
  });
});

function fakeSupabase(matches) {
  return {
    from(table) {
      expect(table).toBe("matches");
      return {
        select: () => ({
          eq: () => ({
            neq: () => Promise.resolve({ data: matches, error: null }),
          }),
          in: (col, ids) => ({
            neq: (neqCol, neqVal) =>
              Promise.resolve({
                data: matches.filter((m) => ids.includes(m.id) && m[neqCol] !== neqVal),
                error: null,
              }),
          }),
        }),
        update: (payload) => ({
          eq: (col, id) => {
            const m = matches.find((x) => x.id === id);
            if (m) Object.assign(m, payload);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}

describe("findStaleMatches", () => {
  it("only returns liquipedia matches past their format's threshold", async () => {
    const now = Date.now();
    const supabase = fakeSupabase([
      {
        id: "fresh",
        format: "BO3",
        scheduled_at: new Date(now - 2 * 3600_000).toISOString(),
        tournament_id: "t1",
        tournaments: { id: "t1", name: "Fresh Cup", liquipedia_slug: "Fresh_Cup" },
      },
      {
        id: "stale",
        format: "BO3",
        scheduled_at: new Date(now - 7 * 3600_000).toISOString(),
        tournament_id: "t1",
        tournaments: { id: "t1", name: "Fresh Cup", liquipedia_slug: "Fresh_Cup" },
      },
      {
        id: "no-slug",
        format: "BO1",
        scheduled_at: new Date(now - 10 * 3600_000).toISOString(),
        tournament_id: "t2",
        tournaments: { id: "t2", name: "Custom Cup", liquipedia_slug: null },
      },
    ]);

    const stale = await findStaleMatches(supabase);
    expect(stale.map((m) => m.id)).toEqual(["stale"]);
  });
});

describe("forceFinishStaleMatches", () => {
  it("skips force-closing a match the refresh resolved to finished", async () => {
    const now = Date.now();
    const matches = [
      {
        id: "resolved-by-refresh",
        format: "BO3",
        status: "live",
        scheduled_at: new Date(now - 7 * 3600_000).toISOString(),
        tournament_id: "t1",
        tournaments: { id: "t1", name: "Fresh Cup", liquipedia_slug: "Fresh_Cup" },
      },
    ];
    const supabase = fakeSupabase(matches);
    // Simulate the refresh finding a real Liquipedia result mid-sweep.
    const refreshFn = vi.fn(async () => {
      matches[0].status = "finished";
    });

    await forceFinishStaleMatches(supabase, refreshFn);

    expect(refreshFn).toHaveBeenCalledOnce();
    expect(matches[0].custom_state_label).toBeUndefined();
  });

  it("force-closes with a flagged label when the refresh finds nothing", async () => {
    const now = Date.now();
    const matches = [
      {
        id: "still-stuck",
        format: "BO3",
        status: "live",
        scheduled_at: new Date(now - 7 * 3600_000).toISOString(),
        tournament_id: "t1",
        tournaments: { id: "t1", name: "Fresh Cup", liquipedia_slug: "Fresh_Cup" },
      },
    ];
    const supabase = fakeSupabase(matches);
    const refreshFn = vi.fn(async () => {});

    await forceFinishStaleMatches(supabase, refreshFn);

    expect(matches[0].status).toBe("finished");
    expect(matches[0].custom_state_label).toBe("Auto-closed after 6h — no Liquipedia result yet");
  });
});
