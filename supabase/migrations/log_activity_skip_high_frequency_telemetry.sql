-- ===========================================================================
-- activity_log growth fix — stop auditing high-frequency operational telemetry
-- ===========================================================================
-- The log_activity() trigger (attached to 22 tables) was recording EVERY
-- INSERT/UPDATE/DELETE with full old_data + new_data JSONB. The Hot Match
-- capture loop updates games/matches every ~5s tick (timer, kills,
-- current_time, state heartbeat), which produced ~470k rows (~671 MB, ~90% of
-- the table) of pure telemetry churn and pushed the database past the Supabase
-- free-plan 0.5 GB limit.
--
-- This redefinition keeps MEANINGFUL audit (admin/config/security changes,
-- match & game create/delete, and real state transitions) while dropping the
-- high-frequency telemetry:
--   * telemetry tables (their data already lives in their own tables, and for
--     game state in the reconstruction event tables) are not audited at all;
--   * games/matches UPDATEs are audited only when a meaningful column changes
--     (status / state / winner / current game), not on every tick.
-- The triggers themselves stay attached to all 22 tables; only what the
-- function chooses to record changes.
-- ===========================================================================
create or replace function public.log_activity()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  telemetry_tables text[] := array[
    'hero_picks_bans','player_stats','objectives','net_worth_snapshots',
    'key_moments','tournament_results','capture_regions','game_screenshots',
    'vision_detections','item_snapshots'];
begin
  if TG_TABLE_NAME = any(telemetry_tables) then
    return coalesce(new, old);
  end if;

  if TG_OP = 'UPDATE' and TG_TABLE_NAME = 'games' then
    if new.status is not distinct from old.status
       and new.state is not distinct from old.state
       and new.winner_team_id is not distinct from old.winner_team_id then
      return new;
    end if;
  end if;
  if TG_OP = 'UPDATE' and TG_TABLE_NAME = 'matches' then
    if new.status is not distinct from old.status
       and new.state is not distinct from old.state
       and new.current_game_number is not distinct from old.current_game_number then
      return new;
    end if;
  end if;

  insert into public.activity_log (table_name, row_id, operation, actor_id, old_data, new_data)
  values (
    TG_TABLE_NAME,
    coalesce((case when TG_OP = 'DELETE' then old.id else new.id end), null),
    TG_OP,
    auth.uid(),
    case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when TG_OP in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$function$;

-- ---------------------------------------------------------------------------
-- One-time historical cleanup that was applied to the live database (recorded
-- here for provenance; not re-run automatically). Kept: latest activity_log
-- row per (table_name,row_id) for games/matches + full history for the
-- admin/config tables. Deleted: everything else. Implemented via a guarded
-- copy-aside → TRUNCATE → reinsert (fast, reclaims disk immediately, with a
-- safety abort if the keeper count fell outside 8000-12000). Result:
-- activity_log 858 MB / 562,387 rows → 11 MB / 9,050 rows; DB 891 MB → 45 MB.
-- ---------------------------------------------------------------------------
