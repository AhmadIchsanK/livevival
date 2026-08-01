These are the source brand guide files, kept for reference. The site does
**not** import `tokens.css` directly — the values are translated into
`tailwind.config.ts` instead, since the codebase already themes entirely
through Tailwind's color/font extensions (the pre-existing `ink`/`paper`/
`signal` tokens), not CSS custom properties. Keeping one theming mechanism
avoids two sources of truth drifting apart.

Mapping from `tokens.css` to `tailwind.config.ts`:

| tokens.css                | Tailwind class    |
| -------------------------- | ----------------- |
| `--lv-black` (`#0A0A0A`)   | `bg-ink` / `text-ink` |
| `--lv-white` (`#FFFFFF`)   | `bg-paper` / `text-paper` |
| `--lv-red` (`#E31E2A`)     | `bg-signal` / `text-signal` |
| `--lv-red-dark` (`#B3131D`)| `signal-dark` |
| `--lv-red-light` (`#FF4757`)| `signal-light` |
| `--lv-black-soft` (`#141414`) | `surface` |
| `--lv-gray-500` (`#8A8A8A`) | `muted` |
| `--lv-win` (`#2ECC71`)     | `win` |
| `--lv-loss`                | `loss` |
| `--lv-font-display` (Rajdhani) | `font-display` |
| `--lv-font-body` (Inter)   | `font-sans` |
| `--lv-font-mono` (JetBrains Mono) | `font-mono` |
| `--lv-tracking-wide` (0.04em) | `tracking-brand` |

Logo/icon/favicon/social assets are used as-is under `public/logo/`,
`public/favicons/`, `public/app-icons/`, `public/social/` — see
`app/layout.tsx` for the `<head>` wiring (icons, manifest, Open Graph,
Twitter card) and `components/Brand.tsx` for the logo component.
