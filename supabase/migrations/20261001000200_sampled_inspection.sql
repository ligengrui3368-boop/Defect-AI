-- Sampled factory inspection (anti-cheat).
-- The factory declares and locks the lot size; the server draws a random AQL sample of
-- carton/unit positions, reveals them one at a time with a short capture window, and only
-- accepts live-camera photos uploaded inside that window. Factories never read these
-- tables directly: only the qc Edge Function (service role) does, via the link token.

create table public.factory_sessions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.factory_links(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  lot text not null,
  total_units int not null check (total_units between 1 and 500000),
  cartons int not null check (cartons between 1 and 100000),
  units_per_carton int not null check (units_per_carton between 1 and 100000),
  sample_size int not null,
  accept_major int not null,          -- lot passes with at most this many failed units
  window_seconds int not null default 480,
  status text not null default 'sampling' check (status in ('sampling', 'done', 'cancelled')),
  result text check (result in ('PASS', 'FAIL', 'REVIEW')),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index factory_sessions_link_idx on public.factory_sessions (link_id, created_at desc);

create table public.factory_picks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.factory_sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  seq int not null,
  carton int not null,
  unit_pos int not null,
  status text not null default 'pending' check (status in ('pending', 'issued', 'done', 'missed')),
  token text,
  issued_at timestamptz,
  expires_at timestamptz,
  submitted_at timestamptz,
  attempts int not null default 0,
  inspection_id uuid references public.inspections(id) on delete set null,
  verdict text,
  unique (session_id, seq)
);
create index factory_picks_session_idx on public.factory_picks (session_id, seq);

alter table public.inspections
  add column session_id uuid references public.factory_sessions(id) on delete set null,
  add column pick_id uuid references public.factory_picks(id) on delete set null;

alter table public.factory_sessions enable row level security;
alter table public.factory_picks enable row level security;
-- Buyers can read the full audit trail of their own workspace; nobody writes except the Edge Function.
create policy "members read sessions" on public.factory_sessions for select using (public.is_member(workspace_id));
create policy "members cancel sessions" on public.factory_sessions for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members read picks" on public.factory_picks for select using (public.is_member(workspace_id));

alter publication supabase_realtime add table public.factory_sessions, public.factory_picks;
