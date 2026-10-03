-- Roles: owner (everything, incl. people and settings), member (works on requests), viewer (can look, can't change).
alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members add constraint workspace_members_role_check check (role in ('owner', 'member', 'viewer', 'inspector'));
alter table public.workspace_invites drop constraint if exists workspace_invites_role_check;
alter table public.workspace_invites add constraint workspace_invites_role_check check (role in ('member', 'owner', 'viewer'));

create or replace function public.can_edit(ws uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role <> 'viewer');
$$;
grant execute on function public.can_edit(uuid) to authenticated;

-- An extra (restrictive) rule on the sourcing tables: on top of the existing rules, writing needs a non-viewer role.
-- The factory inspection tables are left alone: factories work there through their own link.
do $$
declare t text;
begin
  foreach t in array array['sourcing_requests', 'request_candidates', 'negotiations', 'quotes', 'sourcing_orders', 'client_requirements', 'clients', 'factories', 'cost_assumptions', 'message_templates', 'jobs'] loop
    execute format('drop policy if exists "viewers cannot add" on public.%I', t);
    execute format('drop policy if exists "viewers cannot change" on public.%I', t);
    execute format('drop policy if exists "viewers cannot delete" on public.%I', t);
    execute format('create policy "viewers cannot add" on public.%I as restrictive for insert to authenticated with check (public.can_edit(workspace_id))', t);
    execute format('create policy "viewers cannot change" on public.%I as restrictive for update to authenticated using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id))', t);
    execute format('create policy "viewers cannot delete" on public.%I as restrictive for delete to authenticated using (public.can_edit(workspace_id))', t);
  end loop;
end $$;
