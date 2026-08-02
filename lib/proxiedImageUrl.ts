// Liquipedia-hosted images (team logos, hero icons, tournament logos) fail
// to load with a direct cross-origin <img src>, most likely Liquipedia's
// own hotlink/referrer protection — see app/api/image-proxy/route.ts for
// the fix and the evidence. Every render site should route through this
// instead of using logo_url/icon_url directly.
export function proxiedImageUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith("https://liquipedia.net/")) return url;
  return `/api/image-proxy?url=${encodeURIComponent(url)}`;
}
