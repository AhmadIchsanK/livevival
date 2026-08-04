import { describe, expect, it } from "vitest";
import { isEmbeddableStreamUrl } from "../src/youtubeStreamFallback.mjs";

describe("isEmbeddableStreamUrl", () => {
  it("accepts a direct YouTube watch URL", () => {
    expect(isEmbeddableStreamUrl("https://www.youtube.com/watch?v=abc123")).toBe(true);
  });

  it("accepts a youtu.be short link", () => {
    expect(isEmbeddableStreamUrl("https://youtu.be/abc123")).toBe(true);
  });

  it("accepts a direct Twitch URL", () => {
    expect(isEmbeddableStreamUrl("https://twitch.tv/some_channel")).toBe(true);
  });

  it("rejects a Liquipedia Special:Stream redirect page", () => {
    expect(isEmbeddableStreamUrl("https://liquipedia.net/mobilelegends/Special:Stream/youtube/GOTF_Official")).toBe(false);
  });

  it("rejects null/empty", () => {
    expect(isEmbeddableStreamUrl(null)).toBe(false);
    expect(isEmbeddableStreamUrl("")).toBe(false);
  });

  it("rejects an unparseable URL instead of throwing", () => {
    expect(isEmbeddableStreamUrl("not a url")).toBe(false);
  });
});
