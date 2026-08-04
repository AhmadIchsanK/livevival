import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractMatches, parseFormat } from "../src/scheduleSync.mjs";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/schedule-popup.html", import.meta.url)),
  "utf8"
);

describe("parseFormat", () => {
  it("reads a valid Bo-N format", () => {
    expect(parseFormat("Bo3")).toBe("BO3");
    expect(parseFormat("Bo1")).toBe("BO1");
  });

  it("is case-insensitive", () => {
    expect(parseFormat("bo5")).toBe("BO5");
  });

  it("rejects an N that isn't a known series length", () => {
    expect(parseFormat("Bo9")).toBeNull();
  });

  it("returns null when there is no Bo-N pattern at all", () => {
    expect(parseFormat("Best of 3")).toBeNull();
    expect(parseFormat("")).toBeNull();
  });
});

describe("extractMatches", () => {
  const matches = extractMatches(fixture);

  it("only returns popups that have both teams and a timestamp", () => {
    expect(matches).toHaveLength(2);
  });

  it("extracts a finished match with its format and VOD link", () => {
    const m = matches.find((x) => x.teamAName === "Team Alpha");
    expect(m).toEqual({
      teamAName: "Team Alpha",
      teamBName: "Team Beta",
      timestamp: 1700000000,
      finished: true,
      format: "BO3",
      youtubeUrl: "https://youtube.com/watch?v=abc123",
      streamUrl: null,
    });
  });

  it("extracts a scheduled match with no VOD but a live-stream link, resolved to an absolute URL", () => {
    const m = matches.find((x) => x.teamAName === "Team Gamma");
    expect(m).toEqual({
      teamAName: "Team Gamma",
      teamBName: "Team Delta",
      timestamp: 4102444800,
      finished: false,
      format: "BO5",
      youtubeUrl: null,
      streamUrl: "https://liquipedia.net/mobilelegends/Special:Stream/youtube/GOTF_Official",
    });
  });

  it("skips a popup whose opponent is still TBD", () => {
    expect(matches.some((x) => x.teamAName === "Team Epsilon")).toBe(false);
  });

  it("skips a popup with no timer/timestamp", () => {
    expect(matches.some((x) => x.teamAName === "Team Zeta")).toBe(false);
  });
});
