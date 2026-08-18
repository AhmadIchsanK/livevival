"use client";

import { useLanguage } from "@/lib/i18n";

// Compact two-state ID / EN switch, sits next to the theme toggle in the top
// right of every page. Flipping it re-renders the whole tree in the chosen
// language and persists the choice (cookie + localStorage) for next visit.
export function LanguageToggle({ className = "" }: { className?: string }) {
  const { lang, setLang } = useLanguage();
  return (
    <div
      role="group"
      aria-label="Language"
      className={`flex items-center h-8 rounded-md border border-white/10 overflow-hidden text-[11px] font-semibold ${className}`}
    >
      <button
        type="button"
        onClick={() => setLang("id")}
        aria-pressed={lang === "id"}
        title="Ganti ke Bahasa Indonesia"
        className={`px-2 h-full transition-colors ${
          lang === "id" ? "bg-signal text-white" : "text-white/60 hover:bg-white/10"
        }`}
      >
        ID
      </button>
      <button
        type="button"
        onClick={() => setLang("en")}
        aria-pressed={lang === "en"}
        title="Switch to English"
        className={`px-2 h-full transition-colors ${
          lang === "en" ? "bg-signal text-white" : "text-white/60 hover:bg-white/10"
        }`}
      >
        EN
      </button>
    </div>
  );
}
