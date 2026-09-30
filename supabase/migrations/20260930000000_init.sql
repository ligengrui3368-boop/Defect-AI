-- Defect Check: initial schema
-- Workspaces keep each company's products, photos and checks separate.

create extension if not exists pgcrypto;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My workspace',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member', 'inspector')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Membership checks used by every policy. SECURITY DEFINER avoids policy recursion.
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid());
$$;
create or replace function public.is_owner(ws uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.workspace_members m where m.workspace_id = ws and m.user_id = auth.uid() and m.role = 'owner');
$$;

-- Product standards. Queryable fields are columns; the rest of the standard lives in `spec`.
create table public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  sku text,
  source_url text,
  spec jsonb not null default '{}'::jsonb,
  photos jsonb not null default '[]'::jsonb,
  version int not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on column public.products.spec is 'material, colors, finish, dims{l,w,h}, tol, packaging, inBox, officialSpecs, goodLooks, mustHave, allowed, watch[], minDefectMm, views[], listingText';
comment on column public.products.photos is '[{path, view, part, origin: unit|official, kind}]';
create index products_ws_idx on public.products (workspace_id, updated_at desc);

create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null,
  product_version int not null default 1,
  spec_snapshot jsonb,
  lot text,
  unit text,
  photos jsonb not null default '[]'::jsonb,
  careful boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  verdict text check (verdict in ('PASS', 'FAIL', 'REVIEW', 'RETAKE')),
  ai jsonb,
  error text,
  model text,
  decision jsonb,
  final_result text generated always as (coalesce(decision->>'final', verdict)) stored,
  recheck_of uuid references public.inspections(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
comment on column public.inspections.spec_snapshot is 'The standard exactly as it was when this unit was checked';
comment on column public.inspections.ai is '{verdict, summary, photoOk, photoIssues, checks, defects, more}';
comment on column public.inspections.decision is '{final: PASS|FAIL, at, by}';
create index inspections_ws_idx on public.inspections (workspace_id, created_at desc);
create index inspections_product_idx on public.inspections (product_id, created_at desc);

-- Keep updated_at fresh and bump the standard's version on every real edit.
create or replace function public.touch_product()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.spec is distinct from old.spec or new.photos is distinct from old.photos or new.name is distinct from old.name or new.sku is distinct from old.sku then
    new.version := old.version + 1;
  end if;
  return new;
end $$;
create trigger products_touch before update on public.products for each row execute function public.touch_product();

-- Every new user gets a personal workspace.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into public.workspaces (name, created_by) values ('My workspace', new.id) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, new.id, 'owner');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Row level security
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.products enable row level security;
alter table public.inspections enable row level security;

create policy "members read workspace" on public.workspaces for select using (public.is_member(id));
create policy "owners rename workspace" on public.workspaces for update using (public.is_owner(id));

create policy "members see members" on public.workspace_members for select using (public.is_member(workspace_id));
create policy "owners add members" on public.workspace_members for insert with check (public.is_owner(workspace_id));
create policy "owners change members" on public.workspace_members for update using (public.is_owner(workspace_id));
create policy "owners remove members" on public.workspace_members for delete using (public.is_owner(workspace_id));

create policy "members read products" on public.products for select using (public.is_member(workspace_id));
create policy "members add products" on public.products for insert with check (public.is_member(workspace_id));
create policy "members edit products" on public.products for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members delete products" on public.products for delete using (public.is_member(workspace_id));

create policy "members read inspections" on public.inspections for select using (public.is_member(workspace_id));
create policy "members add inspections" on public.inspections for insert with check (public.is_member(workspace_id));
create policy "members update inspections" on public.inspections for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members delete inspections" on public.inspections for delete using (public.is_member(workspace_id));

-- Private photo bucket. Files live under <workspace_id>/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 20971520, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create or replace function public.path_workspace(p text)
returns uuid language plpgsql immutable as $$
begin
  return (split_part(p, '/', 1))::uuid;
exception when others then
  return null;
end $$;

create policy "members read photos" on storage.objects for select
  using (bucket_id = 'photos' and public.is_member(public.path_workspace(name)));
create policy "members upload photos" on storage.objects for insert
  with check (bucket_id = 'photos' and public.is_member(public.path_workspace(name)));
create policy "members delete photos" on storage.objects for delete
  using (bucket_id = 'photos' and public.is_member(public.path_workspace(name)));

-- Live updates for the app
alter publication supabase_realtime add table public.products, public.inspections;
