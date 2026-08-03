// Livevival brand mark + wordmark — real exports from Livevival_Brand_Kit
// (see Livevival_Brand_Guide.pdf). icon.png is the "Simple Icon" variant,
// used standalone below the guide's 120px full-lockup minimum size;
// logo-dark-bg.png/logo-light-bg.png are the full lockup (mark + wordmark
// + tagline) built for each surface — the wordmark itself is white-filled,
// so on a light page it rendered as near-invisible light-on-light text
// until this switched to the light-surface export based on theme.

"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";

export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <Image
      src="/logo/icon.png"
      alt="Livevival"
      width={200}
      height={175}
      className={`${className} object-contain`}
    />
  );
}

export function BrandLockup({
  href = "/",
  className = "",
  imgClassName = "h-9 w-auto",
}: {
  href?: string;
  className?: string;
  imgClassName?: string;
}) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Defaults to the dark-surface lockup before the theme resolves client-
  // side (matches the app's default theme, avoids a flash-of-wrong-logo).
  const src = mounted && resolvedTheme === "light" ? "/logo/logo-light-bg.png" : "/logo/logo-dark-bg.png";

  return (
    <a href={href} className={`flex items-center group ${className}`}>
      <Image
        src={src}
        alt="Livevival — Esports Live Score by RevivalTV"
        width={1248}
        height={352}
        priority
        className={`${imgClassName} object-contain transition-transform duration-300 group-hover:translate-x-0.5`}
      />
    </a>
  );
}
