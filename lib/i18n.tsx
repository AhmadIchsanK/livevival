"use client";

// Client-side language context. The active language is seeded from a cookie by
// the server root layout (so there's no EN→ID flash for Indonesian visitors),
// then persisted to both localStorage and the cookie whenever the user flips
// the toggle. useLanguage() exposes { lang, setLang, t } — t() is the string
// lookup with {placeholder} interpolation and an English fallback.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { translate, LANG_COOKIE, type Lang, type MsgKey } from "./messages";

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: MsgKey, vars?: Record<string, string | number>) => string;
};

const LanguageContext = createContext<Ctx | null>(null);

export function LanguageProvider({ initialLang = "en", children }: { initialLang?: Lang; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_COOKIE, l);
    } catch {
      /* private mode / storage disabled — the cookie below still carries it */
    }
    // Persist for the next SSR render so the choice survives a full reload.
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    // Keep the <html lang> attribute honest for a11y / SEO.
    try {
      document.documentElement.lang = l;
    } catch {
      /* noop */
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      lang,
      setLang,
      t: (key, vars) => translate(lang, key, vars),
    }),
    [lang, setLang]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

// Safe even outside a provider (falls back to English) so a stray component
// never crashes — though everything under the root layout is wrapped.
export function useLanguage(): Ctx {
  const ctx = useContext(LanguageContext);
  if (ctx) return ctx;
  return {
    lang: "en",
    setLang: () => {},
    t: (key, vars) => translate("en", key, vars),
  };
}
