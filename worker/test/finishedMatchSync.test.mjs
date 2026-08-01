import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { extractFinishedMatches, heroesIn, isRightSide } from "../src/finishedMatchSync.mjs";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/finished-popup.html", import.meta.url)),
  "utf8"
);

describe("extractFinishedMatches", () => {
  const $ = cheerio.load(fixture);
  const matches = extractFinishedMatches($);

  it("only returns popups that are finished and have both team names", () => {
    expect(matches).toHaveLength(1);
  });

  it("extracts the winner and timestamp", () => {
    const [m] = matches;
    expect(m.leftName).toBe("Team Alpha");
    expect(m.rightName).toBe("Team Beta");
    expect(m.leftWon).toBe(true);
    expect(m.timestamp).toBe(1700000000);
  });

  it("groups picks per game by pairing consecutive grid rows", () => {
    const [m] = matches;
    expect(m.games).toHaveLength(2);

    const [game1, game2] = m.games;
    expect(game1.gameNumber).toBe(1);
    expect(game1.left).toEqual({ picks: ["Hero One", "Hero Two"], won: true });
    expect(game1.right).toEqual({ picks: ["Hero Three", "Hero Four"], won: false });

    expect(game2.gameNumber).toBe(2);
    expect(game2.left).toEqual({ picks: ["Hero Five", "Hero Six"], won: false });
    expect(game2.right).toEqual({ picks: ["Hero Seven", "Hero Eight"], won: true });
  });

  it("attaches bans from the veto rows to the matching game number", () => {
    const [m] = matches;
    const [game1, game2] = m.games;
    expect(game1.leftBans).toEqual(["Ban Left One"]);
    expect(game1.rightBans).toEqual(["Ban Right One"]);
    expect(game2.leftBans).toEqual(["Ban Left Two"]);
    expect(game2.rightBans).toEqual(["Ban Right Two"]);
  });

  it("maps VOD footer links to their game number", () => {
    const [m] = matches;
    expect(m.vods).toEqual({
      1: "https://youtube.com/watch?v=game1",
      2: "https://youtube.com/watch?v=game2",
    });
  });

  it("skips a popup with no data-finished attribute", () => {
    expect(matches.some((m) => m.leftName === "Team Gamma")).toBe(false);
  });

  it("skips a finished popup whose opponent is still TBD", () => {
    expect(matches.some((m) => m.leftName === "Team Epsilon")).toBe(false);
  });
});

describe("isRightSide", () => {
  it("is true only when the element carries the right-side thumb class", () => {
    const $ = cheerio.load(
      '<div class="brkts-champion-icon brkts-popup-body-element-thumbs-right"></div><div class="brkts-champion-icon"></div>'
    );
    const icons = $(".brkts-champion-icon");
    expect(isRightSide($, icons[0])).toBe(true);
    expect(isRightSide($, icons[1])).toBe(false);
  });
});

describe("heroesIn", () => {
  it("collects the title attribute of every hero link in a container", () => {
    const $ = cheerio.load('<div id="c"><a title="Hero A"></a><a title="Hero B"></a></div>');
    expect(heroesIn($, $("#c"))).toEqual(["Hero A", "Hero B"]);
  });

  it("returns an empty array when there are no hero links", () => {
    const $ = cheerio.load('<div id="c"></div>');
    expect(heroesIn($, $("#c"))).toEqual([]);
  });
});
