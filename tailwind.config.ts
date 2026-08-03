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
        muted: "#8A8A8A", // secondary text, timestamps / draw-neutral status
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
      },
      animation: {
        "lv-fade-up": "lv-fade-up 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
        "lv-pulse-glow": "lv-pulse-glow 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
