"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { proxiedImageUrl } from "@/lib/proxiedImageUrl";

// A team logo that's black/near-black (or just close to this site's own
// near-black #0A0A0A background) visually disappears inside the flat
// translucent box every logo placement used before this — that box was
// always-on and never actually inspected the logo's own pixels. This
// samples the loaded image once (cached per URL) and switches to a solid
// white backing only when the logo is genuinely dark; anything else keeps
// the lighter translucent box that already reads fine against the page.
const darknessCache = new Map<string, boolean>();

function useIsDarkLogo(url: string | null | undefined): boolean {
  const [isDark, setIsDark] = useState(() => (url ? darknessCache.get(url) ?? false : false));
  useEffect(() => {
    if (!url) return;
    const cached = darknessCache.get(url);
    if (cached != null) {
      setIsDark(cached);
      return;
    }
    let cancelled = false;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const size = 24;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);
        let total = 0;
        let opaquePixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 20) continue; // skip transparent pixels
          total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          opaquePixels++;
        }
        const avgLuminance = opaquePixels > 0 ? total / opaquePixels : 255;
        const dark = avgLuminance < 60;
        darknessCache.set(url, dark);
        setIsDark(dark);
      } catch {
        // A cross-origin-tainted canvas would throw on getImageData —
        // shouldn't happen via our own same-origin proxy, but fail safe to
        // "not dark" (the existing translucent box) rather than crash.
      }
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url]);
  return isDark;
}

const SIZE_CLASSES = {
  sm: "w-10 h-10 p-1.5",
  md: "w-14 h-14 sm:w-16 sm:h-16 p-2",
  lg: "w-20 h-20 sm:w-24 sm:h-24 p-2.5",
  xl: "w-24 h-24 sm:w-32 sm:h-32 p-3",
};

export function TeamLogo({
  url,
  alt = "",
  size = "md",
  highlight = false,
  glow = false,
  className = "",
}: {
  url: string | null | undefined;
  alt?: string;
  size?: "sm" | "md" | "lg" | "xl";
  highlight?: boolean;
  // Soft ambient glow behind the logo — the hero-header treatment for the
  // public match page. Signal red only (brand colors stay fixed; no
  // per-team accent-color extraction from the source logo).
  glow?: boolean;
  className?: string;
}) {
  const proxied = proxiedImageUrl(url);
  const isDark = useIsDarkLogo(proxied);
  // Dark mode's rule is "a dark logo gets a solid white backing" (light
  // logos already read fine on the default translucent-white box, since
  // the page behind it is dark). Light mode needs the opposite pairing:
  // the page itself is light now, so a dark logo already reads fine on
  // the default translucent box, while a light logo is the one that
  // needs a solid (dark) backing to stay visible. Defaults to the
  // dark-mode pairing before mount/theme resolution to avoid a layout
  // jump on first paint.
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isLightTheme = mounted && resolvedTheme === "light";
  const wantsSolidBacking = isLightTheme ? !isDark : isDark;
  const solidBg = isLightTheme ? "bg-ink" : "bg-white";
  const translucentBg = isLightTheme ? "bg-black/10" : "bg-white/10";
  return (
    <div className={`relative flex items-center justify-center shrink-0 ${glow ? "" : className}`}>
      {glow && (
        <div className="absolute inset-0 -z-10 rounded-full bg-signal/30 blur-2xl scale-125" aria-hidden="true" />
      )}
      <div
        className={`${SIZE_CLASSES[size]} rounded-xl border flex items-center justify-center shrink-0 ${
          highlight ? "border-signal ring-1 ring-signal" : "border-white/10"
        } ${wantsSolidBacking ? solidBg : translucentBg} ${glow ? className : ""}`}
      >
        {proxied ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={proxied} alt={alt} className="w-full h-full object-contain" />
        ) : (
          <span className="text-white/20 text-xs">?</span>
        )}
      </div>
    </div>
  );
}
