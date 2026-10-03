-- Message templates per workspace (first use: the RFQ to factories). When a template exists, drafts follow it.
create table if not exists public.message_templates (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null check (kind in ('rfq', 'counter')),
  body text not null check (length(body) between 1 and 6000),
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, kind)
);
alter table public.message_templates enable row level security;
create policy "members read templates" on public.message_templates for select using (public.is_member(workspace_id));
create policy "members write templates" on public.message_templates for insert with check (public.is_member(workspace_id));
create policy "members update templates" on public.message_templates for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members delete templates" on public.message_templates for delete using (public.is_member(workspace_id));
