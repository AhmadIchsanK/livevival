-- Notification tier: a new axis, independent of matches.update_source
-- ('local_ocr' vs 'liquipedia', which governs where a match's LIVE DATA
-- comes from — OCR capture vs Liquipedia polling — and must stay
-- untouched, it's load-bearing for a lot of other code). This column
-- governs whether/how much automatic Telegram/Slack traffic a match
-- generates:
--   normal   (default) - no automatic notifications at all.
--   priority           - exactly two: match-started, match-finished.
--   hot                - the same two, plus every existing Hot-match
--                         automatic trigger (game-result, draft-complete,
--                         etc. — see app/admin/matches/[id]/live/page.tsx).
alter table matches
  add column if not exists notification_tier text not null default 'normal'
  check (notification_tier in ('normal', 'hot', 'priority'));

-- Per-tournament default, applied to new matches and cascadable to
-- existing ones from /admin/tournaments (future/in-progress matches only —
-- see the cascade update in that page, which never touches status='finished').
alter table tournaments
  add column if not exists default_notification_tier text not null default 'normal'
  check (default_notification_tier in ('normal', 'hot', 'priority'));

-- One-time backfill: every currently-Hot (local_ocr) match keeps getting
-- Hot-tier notifications after this ships — no regression for existing
-- Hot matches, which relied on update_source alone until now.
update matches set notification_tier = 'hot' where update_source = 'local_ocr';
