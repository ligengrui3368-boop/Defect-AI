-- Pilot requests from the marketing site. Anyone can submit; nobody can read them
-- through the public API (view them in the Supabase dashboard, Table Editor > leads).
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  email text not null check (char_length(email) between 5 and 200 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name text check (char_length(name) <= 120),
  company text check (char_length(company) <= 160),
  orders_per_month text check (char_length(orders_per_month) <= 40),
  message text check (char_length(message) <= 2000),
  source text check (char_length(source) <= 80),
  created_at timestamptz not null default now()
);
alter table public.leads enable row level security;
create policy "anyone can submit a lead" on public.leads for insert to anon, authenticated with check (true);
revoke select, update, delete on public.leads from anon, authenticated;
grant insert on public.leads to anon, authenticated;
