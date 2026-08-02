-- Keeps a stream's status in sync with the matches linked to it via
-- matches.stream_id, automatically, regardless of which path changed the
-- match (admin UI, the always-on Liquipedia worker, or the live console).
-- live if any linked match is live; ended once every linked match is
-- finished; otherwise left alone (covers "scheduled" and manual overrides).
--
-- Applied directly to the live project via the Supabase MCP connector;
-- mirrored here so schema.sql/migrations stay the source of truth for a
-- fresh setup.
create or replace function public.recompute_stream_status(target_stream_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_stream_id is null then
    return;
  end if;
  if exists (select 1 from matches where stream_id = target_stream_id and status = 'live') then
    update streams set status = 'live' where id = target_stream_id and status <> 'live';
  elsif exists (select 1 from matches where stream_id = target_stream_id)
    and not exists (select 1 from matches where stream_id = target_stream_id and status <> 'finished') then
    update streams set status = 'ended' where id = target_stream_id and status <> 'ended';
  end if;
end;
$$;

create or replace function public.sync_stream_status_from_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.recompute_stream_status(new.stream_id);
  if tg_op = 'UPDATE' and old.stream_id is distinct from new.stream_id then
    perform public.recompute_stream_status(old.stream_id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_stream_status on matches;
create trigger trg_sync_stream_status
after insert or update of status, stream_id on matches
for each row
execute function public.sync_stream_status_from_match();
