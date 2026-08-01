import { spawn } from "node:child_process";
import youtubedl from "youtube-dl-exec";

// Cache the resolved direct media URL per source URL for a short while —
// re-resolving on every single frame grab is wasteful and can get you
// rate-limited by the platform. YouTube's signed URLs are usually valid
// for several hours.
const resolvedUrlCache = new Map(); // sourceUrl -> { directUrl, expiresAt }

async function resolveDirectUrl(sourceUrl) {
  const cached = resolvedUrlCache.get(sourceUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.directUrl;

  let info;
  try {
    info = await youtubedl(sourceUrl, {
      format: "best[height<=720]",
      getUrl: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
  } catch (err) {
    // Surface the real failure instead of letting a cryptic downstream
    // "not valid JSON" error be the only thing that shows up in logs —
    // common causes: YouTube serving a bot-check page to a datacenter IP
    // (Railway's included), an expired/removed video, or a private stream.
    const detail = err?.stderr || err?.message || String(err);
    throw new Error(`yt-dlp failed to resolve stream URL: ${detail.slice(0, 500)}`);
  }
  const directUrl = String(info).trim().split("\n")[0];
  if (!directUrl || directUrl.startsWith("<") || directUrl.includes("<!DOCTYPE")) {
    throw new Error(
      `yt-dlp returned something that isn't a video URL (looks like an HTML page, not a stream link): "${directUrl.slice(0, 200)}"`
    );
  }

  resolvedUrlCache.set(sourceUrl, {
    directUrl,
    expiresAt: Date.now() + 30 * 60 * 1000, // re-resolve every 30 min to be safe
  });
  return directUrl;
}

/**
 * Grabs a single JPEG frame from a livestream URL.
 * Requires ffmpeg to be present on PATH (install it in the worker's
 * Dockerfile / Railway build — see worker/README.md).
 *
 * @returns {Promise<Buffer>} JPEG bytes
 */
export async function captureFrame(sourceUrl) {
  const directUrl = await resolveDirectUrl(sourceUrl);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-i", directUrl,
      "-frames:v", "1",
      "-q:v", "3",
      "-f", "image2pipe",
      "-vcodec", "mjpeg",
      "pipe:1",
    ]);

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", () => {}); // ffmpeg logs progress to stderr; ignore unless debugging
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0 && chunks.length === 0) {
        // If this happens repeatedly for one stream, the direct URL likely
        // expired early — drop it from the cache so the next call re-resolves.
        resolvedUrlCache.delete(sourceUrl);
        reject(new Error(`ffmpeg exited with code ${code} and produced no frame`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
