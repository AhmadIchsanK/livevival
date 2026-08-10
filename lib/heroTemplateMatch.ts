// Client-side hero-icon template matching for the draft-detection assist in
// app/admin/matches/[id]/live/page.tsx — plain Canvas 2D pixel comparison,
// no external CV library, kept in its own module so that already-enormous
// page doesn't grow further and so this logic reads/tests independently.
//
// This exists to cross-check, not replace, the AI-vision reading of the
// draft board: a vision model reads hero_name as text off a small icon,
// which is exactly the kind of read that goes wrong on a blurry stream or a
// hero with a long/similar name. Comparing the icon's own pixels against a
// cache of the real hero portraits sidesteps that failure mode entirely —
// it either looks like Hero X or it doesn't, independent of what any text
// happened to render as.

export type HeroIconCacheEntry = { id: string; name: string; data: Uint8ClampedArray };
export type HeroIconCache = HeroIconCacheEntry[];

// Small enough that every per-tick comparison (crop x ~20 slots x ~120
// heroes) stays sub-frame-budget; large enough that a hero's dominant
// colors/silhouette still survive the downscale.
const TEMPLATE_SIZE = 32;

// Every crop and every hero icon goes through this same fixed-size
// normalization before comparison, so a wildly different source resolution
// (a 1080p broadcast crop vs. a small scraped portrait) never skews the
// distance math — only relative color/shape differences do.
function downscale(source: CanvasImageSource, sw: number, sh: number): Uint8ClampedArray | null {
  const canvas = document.createElement("canvas");
  canvas.width = TEMPLATE_SIZE;
  canvas.height = TEMPLATE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE);
  try {
    return ctx.getImageData(0, 0, TEMPLATE_SIZE, TEMPLATE_SIZE).data;
  } catch {
    // A tainted canvas (an icon served cross-origin without CORS headers)
    // throws here — caught so one bad icon can't take down the whole cache
    // build or a whole capture tick.
    return null;
  }
}

// Crops one calibrated draft-slot region out of the current video frame and
// downscales it — mirrors cropCanvasFor() in the live console page, but
// deliberately keeps color (that page's version grayscales for Tesseract;
// this comparison needs the color signal grayscale would throw away).
export function downscaleVideoRegion(
  video: HTMLVideoElement,
  box: { xPct: number; yPct: number; wPct: number; hPct: number }
): Uint8ClampedArray | null {
  const sx = (box.xPct / 100) * video.videoWidth;
  const sy = (box.yPct / 100) * video.videoHeight;
  const sw = (box.wPct / 100) * video.videoWidth;
  const sh = (box.hPct / 100) * video.videoHeight;
  if (sw < 4 || sh < 4) return null;

  const full = document.createElement("canvas");
  full.width = video.videoWidth;
  full.height = video.videoHeight;
  const fullCtx = full.getContext("2d");
  if (!fullCtx) return null;
  fullCtx.drawImage(video, 0, 0);

  const crop = document.createElement("canvas");
  crop.width = sw;
  crop.height = sh;
  const cropCtx = crop.getContext("2d");
  if (!cropCtx) return null;
  cropCtx.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
  return downscale(crop, sw, sh);
}

// Builds the in-memory 32x32 icon cache once per session — call lazily
// (only once a match actually reaches the draft phase), since most admin
// sessions on this page never touch draft detection at all and every hero
// icon is a real network fetch.
export async function buildHeroIconCache(
  heroes: { id: string; name: string; icon_url: string | null }[],
  proxiedUrl: (url: string | null | undefined) => string | undefined
): Promise<HeroIconCache> {
  const entries = await Promise.all(
    heroes.map(
      (h) =>
        new Promise<HeroIconCacheEntry | null>((resolve) => {
          const src = proxiedUrl(h.icon_url);
          if (!src) {
            resolve(null);
            return;
          }
          const img = new Image();
          // Belt-and-suspenders: our own /api/image-proxy already re-serves
          // Liquipedia icons same-origin (so getImageData already works
          // without this), but any icon_url that ever points somewhere else
          // needs explicit CORS opt-in or the canvas taints silently.
          img.crossOrigin = "anonymous";
          img.onload = () => {
            const data = downscale(img, img.naturalWidth || TEMPLATE_SIZE, img.naturalHeight || TEMPLATE_SIZE);
            resolve(data ? { id: h.id, name: h.name, data } : null);
          };
          img.onerror = () => resolve(null);
          img.src = src;
        })
    )
  );
  return entries.filter((e): e is HeroIconCacheEntry => e !== null);
}

// Mean per-channel pixel distance, normalized to a 0..1 similarity score —
// deliberately the simplest possible metric (no histograms, no feature
// descriptors). At 32x32 a crude distance already separates most heroes
// cleanly since portraits differ a lot in raw color/composition; a fancier
// metric would cost more CPU per tick for no measurable accuracy gain here.
function similarity(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 4) {
    // Step by 4 (RGBA stride): compare RGB only, skip alpha — both sides are
    // opaque crops/icons, so alpha carries no discriminating signal.
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  const pixelCount = n / 4;
  if (pixelCount === 0) return 0;
  const maxSum = pixelCount * 3 * 255;
  return 1 - sum / maxSum;
}

export type HeroMatch = { id: string; name: string; score: number };

// Best-guess hero for one cropped draft slot, or null if nothing clears the
// confidence bar. Returning null below threshold matters as much as the
// match itself: a low-confidence guess is worse than admitting uncertainty,
// since reconcileDraftSlot() (in the live console page) trusts a non-null
// template match over whatever the AI-vision text read said.
export function bestHeroMatch(cropData: Uint8ClampedArray, cache: HeroIconCache, threshold = 0.75): HeroMatch | null {
  let best: HeroMatch | null = null;
  for (const entry of cache) {
    const score = similarity(cropData, entry.data);
    if (!best || score > best.score) best = { id: entry.id, name: entry.name, score };
  }
  return best && best.score >= threshold ? best : null;
}
