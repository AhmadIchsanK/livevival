-- Revoking or promoting a contributor now deletes their `contributors` row
-- outright (see app/api/admin/revoke-contributor and promote-contributor).
-- Without cascade, that delete fails whenever the contributor has any
-- edit_requests rows (NO ACTION was the default). Full history survives
-- regardless via the log_activity trigger already attached to both tables.
alter table public.edit_requests
  drop constraint edit_requests_contributor_id_fkey;

alter table public.edit_requests
  add constraint edit_requests_contributor_id_fkey
  foreign key (contributor_id) references public.contributors(id) on delete cascade;
