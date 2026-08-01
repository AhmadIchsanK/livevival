"use client";

import { usePathname } from "next/navigation";

// Lightweight, dependency-free page transition: keys the wrapper by route so
// React remounts it on navigation, and a CSS animation (see globals.css)
// fades + lifts the new page in. No router/link overrides, no extra
// package — just enough to make navigating between pages feel like one
// continuous app instead of a hard cut.
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="lv-page-enter">
      {children}
    </div>
  );
}
