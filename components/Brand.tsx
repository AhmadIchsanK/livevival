// Livevival brand mark + wordmark — real exports from Livevival_Brand_Kit
// (see Livevival_Brand_Guide.pdf). icon.png is the "Simple Icon" variant,
// used standalone below the guide's 120px full-lockup minimum size;
// logo-dark-bg.png is the full lockup (mark + wordmark + tagline), for the
// site's dark surfaces only per the guide (there is no light-surface page
// in this app to warrant importing logo-light-bg.png too).

import Image from "next/image";

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
  return (
    <a href={href} className={`flex items-center group ${className}`}>
      <Image
        src="/logo/logo-dark-bg.png"
        alt="Livevival — Esports Live Score by RevivalTV"
        width={1248}
        height={352}
        priority
        className={`${imgClassName} object-contain transition-transform duration-300 group-hover:translate-x-0.5`}
      />
    </a>
  );
}
