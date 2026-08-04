"use client";

import { proxiedImageUrl } from "@/lib/proxiedImageUrl";

// Every hero icon on the site should look and behave the same: a rounded
// square cropped tight on the face (object-cover + object-top — Liquipedia's
// hero art is a tall full-body render, so top-anchoring the crop is what
// actually shows the face instead of the waist/legs).
//
// The hover preview (name + full uncropped picture) is disabled for now —
// reported as "not working properly" in production. The crop itself is
// unaffected; only the `hover`-driven popup below was removed. Re-enabling:
// restore a `useState` hover flag on the wrapper div's onMouseEnter/Leave
// and the popup block that used to render under the banned-strike div.
const SIZE_CLASSES = {
  xs: "w-6 h-6",
  sm: "w-10 h-10",
  md: "w-12 h-12 sm:w-14 sm:h-14",
  lg: "w-16 h-16 sm:w-20 sm:h-20",
  xl: "w-24 h-24 sm:w-28 sm:h-28",
};

export function HeroIcon({
  url,
  name,
  size = "md",
  banned = false,
  className = "",
}: {
  url: string | null | undefined;
  name?: string | null;
  size?: keyof typeof SIZE_CLASSES;
  // Desaturates the crop and strikes a diagonal bar across it — the site's
  // existing "this hero was banned" treatment, kept as-is here.
  banned?: boolean;
  className?: string;
}) {
  const proxied = proxiedImageUrl(url);

  if (!proxied) {
    return <div className={`${SIZE_CLASSES[size]} rounded-lg bg-white/5 border border-white/10 shrink-0 ${className}`} />;
  }

  return (
    <div className={`relative shrink-0 ${SIZE_CLASSES[size]} ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={proxied}
        alt={name ?? ""}
        className={`w-full h-full rounded-lg object-cover object-top border border-white/10 ${banned ? "opacity-50 grayscale" : ""}`}
      />
      {banned && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden="true">
          <div className="w-[150%] h-[2px] bg-signal/80 rotate-45" />
        </div>
      )}
    </div>
  );
}
