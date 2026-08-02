# Fan feature recommendations

Prepared alongside the admin/public-site audit (see `docs/PROGRESS.md`).
Filtered against the stated goal: keep a fan updated on matches even when
they can't watch live, and give them the full picture later — picks,
bans, score, VOD, moments — whenever they check back.

A richer, formatted version of this was published as a Claude Artifact
during the session; this file is the durable, git-tracked copy.

Readiness tags:
- **Ready now** — buildable with data already in the database
- **Needs new data** — needs a new import/collection path first
- **Needs new integration** — needs a new external service/credential

## 1. Catching up, not just watching

- **Match recap card** (Ready now) — one auto-generated summary per
  finished match: final score, series MVP, both teams' full draft, and
  the key-moments timeline, assembled into a single "what happened" view
  instead of four separate sections. Directly closes the "unable to
  watch fully" gap — the single highest-leverage item on this list.
- **Shareable result image** (Needs new data) — an auto-generated PNG
  (team logos, final score, tournament badge) sized for social sharing,
  one click from any finished match page.
- **Head-to-head history** (Ready now) — "RRQ leads the all-time series
  7–4" plus the last 5 meetings, on any match page. Pure aggregation over
  matches already stored.

## 2. Not missing what's next

- **Follow a team** (Needs new data) — pick favorite teams (a
  browser-stored list is enough to start), homepage reorders to put
  their matches first.
- **Web push notifications** (Needs new integration) — browser
  notifications for followed-team matches going live, independent of the
  Telegram bot, for fans who'll never join that group.

## 3. Understanding the game, not just the score

- **Hero meta tracker** (Ready now) — pick/ban rates and win rate per
  hero across a tournament or patch, built entirely from
  `hero_picks_bans`, which is already populated.
- **Player profile pages** (Ready now) — career KDA trend, signature
  heroes, tournament history, linked from every scoreboard row and
  pick/ban entry. Useful especially once a player changes rosters.
- **Visual bracket view** (Needs new data) — an actual bracket tree for
  playoff stages instead of a flat match list; needs the importer to
  capture bracket position, not just individual matches.

## 4. Around the edges

- **Sitewide search** (Ready now) — one search box across teams,
  players, tournaments, and matches.
- **Light theme** (Ready now) — the brand kit already ships a
  light-surface logo variant (`public/logo/logo-light-bg.png`) that
  isn't used anywhere yet; a theme toggle is most of the way there.
- **Bahasa Indonesia / Filipino localization** (Needs new integration) —
  MPL Indonesia and MPL Philippines are two of the biggest covered
  leagues; a language toggle for their home audiences is a real reach
  expansion, not a nice-to-have.
