-- Factory links: a buyer sends a factory one link per product lot/PO. Factory staff open it
-- on a phone without an account, photograph units, and each unit is checked against the
-- buyer's standard. Only the qc Edge Function (service role) reads links by token.

create table public.factory_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  lot text not null,
  factory_name text,
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  active boolean not null default true,
  max_units int not null default 500,
  expires_at timestamptz not null default (now() + interval '60 days'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index factory_links_ws_idx on public.factory_links (workspace_id, product_id, created_at desc);

alter table public.factory_links enable row level security;
create policy "members read links" on public.factory_links for select using (public.is_member(workspace_id));
create policy "members add links" on public.factory_links for insert with check (public.is_member(workspace_id));
create policy "members edit links" on public.factory_links for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members delete links" on public.factory_links for delete using (public.is_member(workspace_id));

alter table public.inspections
  add column factory_link_id uuid references public.factory_links(id) on delete set null,
  add column submitted_by text;
comment on column public.inspections.factory_link_id is 'Set when factory staff submitted this check through a factory link';
comment on column public.inspections.submitted_by is 'Name the factory worker typed in';

alter publication supabase_realtime add table public.factory_links;
