import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerMatch, detectMatchState, detectMatchStateDetailed, normalizeBannerText } from "./ocrBanners.ts";

test("kill banner: tolerant match on stylized/fragmented OCR text", () => {
  assert.equal(bannerMatch("SAVAGE!!")?.type, "savage");
  assert.equal(bannerMatch("S A V A G E")?.type, "savage");
  assert.equal(bannerMatch("MANIACC")?.type, "maniac");
  assert.equal(bannerMatch("TRIPLE")?.type, "triple_kill", "'KILL' often not read cleanly");
  assert.equal(bannerMatch("Kairi DOUBLE KILL")?.type, "double_kill");
  assert.equal(bannerMatch("12:34"), null, "no letters → no banner");
});

test("match state: REPLAY / PAUSE / crystal (VICTORY/DEFEAT) detection", () => {
  assert.equal(detectMatchState("REPLAY"), "replay");
  assert.equal(detectMatchState("· REPLAY ·"), "replay");
  assert.equal(detectMatchState("PAUSED"), "pause");
  assert.equal(detectMatchState("VICTORY"), "crystal");
  assert.equal(detectMatchState("DEFEAT"), "crystal");
  assert.equal(detectMatchState(""), null);
  assert.equal(detectMatchState("07:03"), null, "plain timer is not a match-state event");
});

test("match state: crystal/end-game outranks replay if both somehow present", () => {
  assert.equal(detectMatchState("REPLAY VICTORY"), "crystal");
});

test("match state detailed: exposes the matched keyword for diagnostics", () => {
  const v = detectMatchStateDetailed("V I C T O R Y !");
  assert.equal(v.state, "crystal");
  assert.equal(v.keyword, "VICTORY");
  assert.equal(v.normalized, "VICTORY");
  assert.equal(detectMatchStateDetailed("DEFEAT").keyword, "DEFEAT");
  assert.equal(detectMatchStateDetailed("Base Destroyed").keyword, "BASEDESTROYED");
  assert.equal(detectMatchStateDetailed("· REPLAY ·").state, "replay");
  assert.equal(detectMatchStateDetailed("Technical Pause").state, "pause");
  assert.deepEqual(detectMatchStateDetailed("07:03"), { state: null, keyword: null, normalized: "" });
});

test("normalizeBannerText strips to uppercase letters", () => {
  assert.equal(normalizeBannerText("S.a-v/a g3e!"), "SAVAGE");
});
