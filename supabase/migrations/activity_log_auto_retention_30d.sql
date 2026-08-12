-- ===========================================================================
-- Automatic activity_log retention (prevents indefinite growth from returning)
-- ===========================================================================
-- With log_activity() no longer recording high-frequency telemetry (see
-- log_activity_skip_high_frequency_telemetry.sql), activity_log now grows
-- slowly. This pg_cron job caps it at 30 days of history as a safety net so it
-- can never balloon again. Runs daily at 03:17 UTC. Idempotent.
-- ===========================================================================
create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('activity_log_retention_30d')
  where exists (select 1 from cron.job where jobname='activity_log_retention_30d');
end $$;

select cron.schedule(
  'activity_log_retention_30d',
  '17 3 * * *',
  $$delete from public.activity_log where changed_at < now() - interval '30 days'$$
);
