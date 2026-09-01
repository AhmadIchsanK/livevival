import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Livevival brand palette — see Livevival_Brand_Guide.pdf ("Color Palette").
        // ink/paper/white are CSS-variable triples (defined in globals.css,
        // flipped by the `.light` class next-themes toggles on <html>) so
        // every existing bg-ink/text-paper/bg-white/NN/border-white/NN
        // className across the whole app becomes theme-aware for free —
        // no per-file dark:/light: rewrites needed. signal and every other
        // color stay literal: the brand red/black identity itself doesn't
        // change between themes, only which one is the "background" side.
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        paper: "rgb(var(--color-paper) / <alpha-value>)",
        white: "rgb(var(--color-white) / <alpha-value>)",
        signal: "#E31E2A", // Brand Red — logo, live badges, CTAs, links
        "signal-dim": "#E31E2A33",
        "signal-dark": "#B3131D", // hover / pressed states
        "signal-light": "#FF4757", // live-dot pulse, highlights
        surface: "#141414", // cards, panels, table rows
        // "Apex Live" tiered charcoal surfaces (design system) — used by the
        // refreshed .lv-card / .lv-glass component classes below. Additive: the
        // existing bg-white/NN utilities keep working everywhere unchanged.
        "surface-2": "#1A1A1A", // elevated cards
        "surface-3": "#201F1F", // raised panels / popovers
        "surface-hi": "#2A2A2A", // hover / active fills
        "border-subtle": "#262626", // 1px card/section hairlines
        muted: "#8A8A8A", // secondary text, timestamps / draw-neutral status
        // Accent system: cyan = win-probability / statistical edge, gold = MVP /
        // tournament winner / premium highlight (per the Apex Live spec).
        cyan: "#06B6D4",
        "cyan-light": "#4CD7F6",
        gold: "#FBBF24",
        "gold-dim": "#946E00",
        win: "#2ECC71",
        loss: "#E31E2A",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"], // Inter — body/UI
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"], // Rajdhani — headings, scoreboard
        mono: ["var(--font-mono)", "monospace"], // JetBrains Mono — timers, exact figures
      },
      letterSpacing: {
        brand: "0.04em", // matches the wordmark's tracking on all-caps headings
      },
      keyframes: {
        "lv-fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "lv-pulse-glow": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        // Breathing ambient red glow for LIVE cards (Apex Live: "soft outer
        // glow of the Primary Red applied to the card to denote urgency").
        "lv-live-glow": {
          "0%, 100%": { boxShadow: "0 0 0 1px rgba(227,30,42,0.35), 0 0 22px -6px rgba(227,30,42,0.45)" },
          "50%": { boxShadow: "0 0 0 1px rgba(227,30,42,0.55), 0 0 36px -4px rgba(227,30,42,0.7)" },
        },
      },
      animation: {
        "lv-fade-up": "lv-fade-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
        "lv-pulse-glow": "lv-pulse-glow 2s ease-in-out infinite",
        "lv-live-glow": "lv-live-glow 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
