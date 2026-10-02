-- Invite people into a workspace by email. The owner shares the join link; the invitee signs in with that email and accepts.
create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (position('@' in email) > 1),
  role text not null default 'member' check (role in ('member', 'owner')),
  token text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  invited_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid
);
create index if not exists workspace_invites_ws on public.workspace_invites(workspace_id);
alter table public.workspace_invites enable row level security;
create policy "members see invites" on public.workspace_invites for select using (public.is_member(workspace_id));
create policy "owners create invites" on public.workspace_invites for insert with check (public.is_owner(workspace_id));
create policy "owners cancel invites" on public.workspace_invites for delete using (public.is_owner(workspace_id));

-- What a join link is for, readable before accepting (only with the secret token).
create or replace function public.invite_preview(p_token text)
returns table (workspace_name text, email text, accepted boolean, inviter_email text)
language sql stable security definer set search_path = public as $$
  select w.name, i.email, i.accepted_at is not null, (select u.email from auth.users u where u.id = i.invited_by)
  from public.workspace_invites i join public.workspaces w on w.id = i.workspace_id
  where i.token = p_token;
$$;

-- Accept: the signed-in user's email must match the invite.
create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare inv public.workspace_invites; me text;
begin
  select * into inv from public.workspace_invites where token = p_token;
  if inv.id is null then raise exception 'This invite link is not valid.'; end if;
  select email into me from auth.users where id = auth.uid();
  if me is null then raise exception 'Sign in with your email first.'; end if;
  if lower(me) <> lower(inv.email) then raise exception 'This invite is for %. You are signed in as %.', inv.email, me; end if;
  insert into public.workspace_members (workspace_id, user_id, role) values (inv.workspace_id, auth.uid(), inv.role)
    on conflict do nothing;
  update public.workspace_invites set accepted_at = coalesce(accepted_at, now()), accepted_by = coalesce(accepted_by, auth.uid()) where id = inv.id;
  return inv.workspace_id;
end $$;

-- People in a workspace with their emails (members only).
create or replace function public.workspace_people(p_ws uuid)
returns table (user_id uuid, email text, role text, joined_at timestamptz, is_you boolean)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email, m.role, m.created_at, m.user_id = auth.uid()
  from public.workspace_members m join auth.users u on u.id = m.user_id
  where m.workspace_id = p_ws and public.is_member(p_ws)
  order by m.created_at;
$$;

revoke execute on function public.invite_preview(text), public.accept_invite(text), public.workspace_people(uuid) from public, anon;
grant execute on function public.invite_preview(text), public.accept_invite(text), public.workspace_people(uuid) to authenticated;
