// Livevival brand mark + wordmark.
//
// NOTE: the actual RevivalTV logo files sent in chat were only visible as
// inline images, not saved anywhere on disk in this environment (only the
// Inter 18pt font files came through as real files under
// public/fonts/). This mark is an original geometric interpretation in the
// same spirit (a red angular wing/chevron reading as forward motion) rather
// than a traced reproduction of the source artwork — swap in the real
// SVG/PNG export under public/brand/ and repoint this component whenever
// it's available.

export function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M8 8 L46 8 L84 46 L52 62 L84 78 L46 92 L8 92 L46 62 Z" fill="currentColor" />
    </svg>
  );
}

export function BrandWordmark({
  className = "",
  tagline = true,
}: {
  className?: string;
  tagline?: boolean;
}) {
  return (
    <div className={className}>
      <p className="font-display font-extralight text-2xl sm:text-3xl tracking-tight leading-none text-paper">
        LIVE<span className="text-signal">VIVAL</span>
      </p>
      {tagline && (
        <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] text-white/40 mt-0.5 whitespace-nowrap">
          Esports Live Score <span className="text-white/25">by</span> RevivalTV
        </p>
      )}
    </div>
  );
}

export function BrandLockup({ href = "/", className = "" }: { href?: string; className?: string }) {
  return (
    <a href={href} className={`flex items-center gap-2.5 group ${className}`}>
      <BrandMark className="h-7 w-7 sm:h-8 sm:w-8 text-signal transition-transform duration-300 group-hover:translate-x-0.5" />
      <BrandWordmark />
    </a>
  );
}
