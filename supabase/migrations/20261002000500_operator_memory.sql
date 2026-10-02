-- Operator's memory, per person and workspace: the conversation, its running notes on what the person is
-- working on, and the prompts it last suggested (so new suggestions don't repeat them).
create table if not exists public.operator_memory (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  messages jsonb not null default '[]'::jsonb,
  notes text not null default '',
  suggestions jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
alter table public.operator_memory enable row level security;
create policy "own operator memory read" on public.operator_memory for select using (user_id = auth.uid() and public.is_member(workspace_id));
create policy "own operator memory add" on public.operator_memory for insert with check (user_id = auth.uid() and public.is_member(workspace_id));
create policy "own operator memory edit" on public.operator_memory for update using (user_id = auth.uid() and public.is_member(workspace_id)) with check (user_id = auth.uid() and public.is_member(workspace_id));
create policy "own operator memory forget" on public.operator_memory for delete using (user_id = auth.uid() and public.is_member(workspace_id));
