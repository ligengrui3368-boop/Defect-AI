-- Teams: invited people join the inviting workspace at sign-up (no stray personal workspace), and every request
-- has an owner so each person sees their own work first.

-- 1. New users: if someone invited this email, join that workspace; otherwise create a personal one.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare ws uuid; inv public.workspace_invites;
begin
  for inv in select * from public.workspace_invites where lower(email) = lower(new.email) and accepted_at is null order by created_at loop
    insert into public.workspace_members (workspace_id, user_id, role) values (inv.workspace_id, new.id, coalesce(inv.role, 'member')) on conflict do nothing;
    update public.workspace_invites set accepted_at = now(), accepted_by = new.id where id = inv.id;
    ws := inv.workspace_id;
  end loop;
  if ws is null then
    insert into public.workspaces (name, created_by) values ('My workspace', new.id) returning id into ws;
    insert into public.workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  end if;
  return new;
end $$;

-- 2. Request owners (who is working on it); defaults to whoever created it
alter table public.sourcing_requests add column if not exists owner_id uuid references auth.users(id) on delete set null default auth.uid();
update public.sourcing_requests r set owner_id = coalesce(r.created_by, (select w.created_by from public.workspaces w where w.id = r.workspace_id)) where owner_id is null;
create index if not exists sourcing_requests_owner on public.sourcing_requests(owner_id);

-- timeline entry when a request changes hands
create or replace function public.trg_activity_owner() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is distinct from old.owner_id then
    perform public.log_activity(new.workspace_id, new.id, 'owner', 'Assigned to ' || coalesce((select email from auth.users where id = new.owner_id), 'nobody'));
  end if;
  return null;
end $$;
drop trigger if exists activity_owner on public.sourcing_requests;
create trigger activity_owner after update of owner_id on public.sourcing_requests for each row execute function public.trg_activity_owner();
revoke execute on function public.trg_activity_owner() from public, anon, authenticated;
