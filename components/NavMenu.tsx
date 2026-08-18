"use client";

import { useState } from "react";
import { useLanguage } from "@/lib/i18n";
import type { MsgKey } from "@/lib/messages";

const NAV_LINKS: { href: string; key: MsgKey }[] = [
  { href: "/matches", key: "nav.matches" },
  { href: "/tournaments", key: "nav.tournaments" },
  { href: "/players", key: "nav.players" },
  { href: "/teams", key: "nav.teams" },
  { href: "/heroes", key: "nav.heroes" },
  { href: "/apply-contributor", key: "nav.applyContributor" },
  { href: "/api/public/rss", key: "nav.rss" },
];

// Replaces the old bare "Tournaments" text link — a burger button opening
// a small dropdown to every public data-browse page (tournaments, players,
// teams, heroes), not just the one this used to point at. Theme-aware via
// the same paper/white tokens every other component already uses, so it
// needs no separate light/dark styling of its own.
export function NavMenu() {
  const [open, setOpen] = useState(false);
  const { t } = useLanguage();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("nav.openMenu")}
        aria-expanded={open}
        className="w-9 h-9 rounded-md border border-white/10 hover:border-signal/50 hover:bg-signal/10 flex items-center justify-center transition-colors duration-200"
      >
        <span className="sr-only">{t("nav.menu")}</span>
        <div className="space-y-[3px]">
          <span className="block w-4 h-0.5 bg-paper rounded-full" />
          <span className="block w-4 h-0.5 bg-paper rounded-full" />
          <span className="block w-4 h-0.5 bg-paper rounded-full" />
        </div>
      </button>
      {open && (
        <>
          {/* Click-outside catcher, not a visible backdrop — a dropdown,
              not a full-screen modal. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-48 z-50 rounded-lg border border-white/10 bg-ink shadow-xl overflow-hidden">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="block px-4 py-2.5 text-sm text-paper hover:text-signal hover:bg-white/5 transition-colors"
              >
                {t(l.key)}
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
