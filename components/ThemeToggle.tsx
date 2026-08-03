"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

// Simple two-state (not light/dark/system) toggle — resolvedTheme already
// accounts for a "system" preference under the hood, so a sun/moon flip is
// enough without a 3-way picker. Renders nothing until mounted: next-themes
// can't know the real theme on the server, and guessing would flash/mismatch.
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <div className={`w-8 h-8 ${className}`} />;

  const isDark = resolvedTheme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className={`w-8 h-8 rounded-md border border-white/10 hover:border-signal/50 hover:bg-signal/10 flex items-center justify-center text-sm transition-colors duration-200 ${className}`}
    >
      {isDark ? "☀️" : "🌙"}
    </button>
  );
}
