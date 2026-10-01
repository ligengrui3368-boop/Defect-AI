-- Sourcing CRM: clients, requests, factories, candidates, negotiations, quotes,
-- cost assumptions and orders. Reuses is_member(workspace_id) for row level security.
-- Client portal access is by token through security-definer functions (no login).

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  company text,
  email text,
  phone text,
  notes text,
  portal_token text unique default encode(gen_random_bytes(18), 'hex'),
  portal_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.sourcing_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  title text not null,
  status text not null default 'intake'
    check (status in ('intake','sourcing','shortlisted','negotiating','quoted','approved','ordered','closed')),
  raw_brief text,
  spec jsonb not null default '{}'::jsonb,
  quantity integer,
  target_unit_price numeric(12,4),
  client_unit_price numeric(12,4),
  currency text not null default 'USD',
  destination text default 'US',
  hts_code text,
  deadline date,
  product_id uuid references public.products(id) on delete set null,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.client_requirements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null references public.sourcing_requests(id) on delete cascade,
  kind text not null default 'requirement' check (kind in ('requirement','defect_to_watch','question','approval')),
  body text not null,
  author text not null default 'client' check (author in ('client','team')),
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.factories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  name_zh text,
  source text not null default 'manual' check (source in ('1688','alibaba','made_in_china','global_sources','customs','registry','trade_fair','map','referral','manual')),
  source_url text,
  city text,
  province text,
  contact_name text,
  wechat text,
  phone text,
  email text,
  is_verified_factory boolean,
  verification jsonb not null default '{}'::jsonb,
  customs_shipments integer,
  platform_years numeric(5,1),
  rating numeric(3,1),
  categories text[],
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.request_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null references public.sourcing_requests(id) on delete cascade,
  factory_id uuid references public.factories(id) on delete set null,
  rank integer,
  match_score numeric(5,2),
  listing_title text,
  listing_url text,
  listing_data jsonb not null default '{}'::jsonb,
  price_cny numeric(12,4),
  moq integer,
  status text not null default 'candidate' check (status in ('candidate','contacted','sampling','rejected','selected')),
  released_to_client boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.negotiations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null references public.sourcing_requests(id) on delete cascade,
  factory_id uuid references public.factories(id) on delete set null,
  candidate_id uuid references public.request_candidates(id) on delete set null,
  status text not null default 'open' check (status in ('open','waiting_factory','waiting_us','sample','agreed','dropped')),
  channel text default 'wechat',
  current_offer_cny numeric(12,4),
  target_cny numeric(12,4),
  agreed_cny numeric(12,4),
  moq integer,
  lead_time_days integer,
  payment_terms text,
  incoterm text default 'FOB',
  terms jsonb not null default '{}'::jsonb,
  log jsonb not null default '[]'::jsonb,
  last_contact_at timestamptz,
  next_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Duty, tariff and fee rates live here, never in code. Dated so every quote records what it used.
create table if not exists public.cost_assumptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  effective_date date not null default current_date,
  is_default boolean not null default false,
  rates jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null references public.sourcing_requests(id) on delete cascade,
  factory_id uuid references public.factories(id) on delete set null,
  negotiation_id uuid references public.negotiations(id) on delete set null,
  assumption_id uuid references public.cost_assumptions(id) on delete set null,
  inputs jsonb not null default '{}'::jsonb,
  breakdown jsonb not null default '{}'::jsonb,
  landed_unit_cost numeric(12,4),
  client_unit_price numeric(12,4),
  margin_pct numeric(7,3),
  status text not null default 'draft' check (status in ('draft','sent','accepted','rejected')),
  released_to_client boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.sourcing_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null references public.sourcing_requests(id) on delete cascade,
  quote_id uuid references public.quotes(id) on delete set null,
  factory_id uuid references public.factories(id) on delete set null,
  client_id uuid references public.clients(id) on delete set null,
  po_id uuid references public.purchase_orders(id) on delete set null,
  status text not null default 'deposit' check (status in ('deposit','production','qc','balance','shipped','arrived','closed')),
  qty integer,
  unit_price_cny numeric(12,4),
  client_unit_price numeric(12,4),
  deposit_paid boolean not null default false,
  balance_paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sourcing_requests_ws on public.sourcing_requests(workspace_id, status);
create index if not exists request_candidates_req on public.request_candidates(request_id);
create index if not exists negotiations_req on public.negotiations(request_id);
create index if not exists quotes_req on public.quotes(request_id);
create index if not exists client_requirements_req on public.client_requirements(request_id);
create index if not exists factories_ws on public.factories(workspace_id);

-- updated_at
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['sourcing_requests','factories','negotiations','sourcing_orders'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s; create trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at();', t);
  end loop; end $$;

-- Row level security: workspace members only
do $$ declare t text; begin
  foreach t in array array['clients','sourcing_requests','client_requirements','factories','request_candidates','negotiations','cost_assumptions','quotes','sourcing_orders'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "members read %1$s" on public.%1$s; create policy "members read %1$s" on public.%1$s for select using (is_member(workspace_id))', t);
    execute format('drop policy if exists "members add %1$s" on public.%1$s; create policy "members add %1$s" on public.%1$s for insert with check (is_member(workspace_id))', t);
    execute format('drop policy if exists "members edit %1$s" on public.%1$s; create policy "members edit %1$s" on public.%1$s for update using (is_member(workspace_id)) with check (is_member(workspace_id))', t);
    execute format('drop policy if exists "members delete %1$s" on public.%1$s; create policy "members delete %1$s" on public.%1$s for delete using (is_member(workspace_id))', t);
  end loop; end $$;

-- ---------- Landed cost ----------
-- inputs: factory_price_cny, qty, domestic_freight_cny (total), intl_freight_usd (total), mode ('ocean'|'air'),
--         client_unit_price (optional), commission_pct (optional override), payment_pct (optional)
-- rates:  fx_cny_per_usd, hts_duty_pct, section_301_pct, other_tariff_pct, mpf_pct, mpf_min_usd, mpf_max_usd,
--         hmf_pct, broker_fee_usd, insurance_pct, payment_fee_pct, vat_rebate_pct, apply_vat_rebate (bool),
--         commission_pct
create or replace function public.calc_landed_cost(inputs jsonb, rates jsonb)
returns jsonb language plpgsql immutable as $$
declare
  qty numeric := greatest(coalesce((inputs->>'qty')::numeric, 1), 1);
  fx numeric := coalesce((rates->>'fx_cny_per_usd')::numeric, 7.2);
  price_cny numeric := coalesce((inputs->>'factory_price_cny')::numeric, 0);
  dom_cny numeric := coalesce((inputs->>'domestic_freight_cny')::numeric, 0);
  intl_usd numeric := coalesce((inputs->>'intl_freight_usd')::numeric, 0);
  mode text := coalesce(inputs->>'mode', 'ocean');
  rebate_pct numeric := case when coalesce((rates->>'apply_vat_rebate')::boolean, false) then coalesce((rates->>'vat_rebate_pct')::numeric, 0) else 0 end;
  goods_usd numeric; dom_usd numeric; rebate_usd numeric; fob_usd numeric;
  duty_pct numeric; duty_usd numeric; mpf numeric; hmf numeric; broker numeric; ins numeric; payfee numeric;
  total numeric; unit numeric; client_price numeric; comm_pct numeric; comm_usd numeric; margin numeric; profit_unit numeric;
begin
  goods_usd := price_cny * qty / fx;
  dom_usd := dom_cny / fx;
  rebate_usd := price_cny * qty * (rebate_pct / 100.0) / 1.13 / fx;  -- rebate on the ex-VAT value
  fob_usd := goods_usd + dom_usd - rebate_usd;
  duty_pct := coalesce((rates->>'hts_duty_pct')::numeric,0) + coalesce((rates->>'section_301_pct')::numeric,0) + coalesce((rates->>'other_tariff_pct')::numeric,0);
  duty_usd := fob_usd * duty_pct / 100.0;
  mpf := least(greatest(fob_usd * coalesce((rates->>'mpf_pct')::numeric,0) / 100.0, coalesce((rates->>'mpf_min_usd')::numeric,0)), coalesce((rates->>'mpf_max_usd')::numeric, 1e9));
  hmf := case when mode = 'ocean' then fob_usd * coalesce((rates->>'hmf_pct')::numeric,0) / 100.0 else 0 end;
  broker := coalesce((rates->>'broker_fee_usd')::numeric, 0);
  ins := (fob_usd + intl_usd) * coalesce((rates->>'insurance_pct')::numeric,0) / 100.0;
  payfee := goods_usd * coalesce((inputs->>'payment_pct')::numeric, (rates->>'payment_fee_pct')::numeric, 0) / 100.0;
  total := fob_usd + intl_usd + duty_usd + mpf + hmf + broker + ins + payfee;
  unit := total / qty;
  client_price := (inputs->>'client_unit_price')::numeric;
  comm_pct := coalesce((inputs->>'commission_pct')::numeric, (rates->>'commission_pct')::numeric, 0);
  comm_usd := case when client_price is not null then client_price * qty * comm_pct / 100.0 else goods_usd * comm_pct / 100.0 end;
  profit_unit := case when client_price is not null then client_price - unit - comm_usd / qty else null end;
  margin := case when client_price is not null and client_price > 0 then profit_unit / client_price * 100.0 else null end;
  return jsonb_build_object(
    'qty', qty, 'fx_cny_per_usd', fx,
    'goods_usd', round(goods_usd,2), 'domestic_freight_usd', round(dom_usd,2), 'vat_rebate_usd', round(rebate_usd,2), 'fob_usd', round(fob_usd,2),
    'intl_freight_usd', round(intl_usd,2), 'duty_pct_total', duty_pct, 'duty_usd', round(duty_usd,2),
    'mpf_usd', round(mpf,2), 'hmf_usd', round(hmf,2), 'broker_fee_usd', round(broker,2), 'insurance_usd', round(ins,2), 'payment_fee_usd', round(payfee,2),
    'landed_total_usd', round(total,2), 'landed_unit_usd', round(unit,4),
    'commission_pct', comm_pct, 'commission_usd', round(comm_usd,2),
    'client_unit_price', client_price, 'profit_unit_usd', round(profit_unit,4), 'margin_pct', round(margin,2)
  );
end $$;

-- ---------- Client portal (token access, no login) ----------
create or replace function public.portal_view(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.clients; out jsonb;
begin
  select * into c from public.clients where portal_token = p_token and portal_active;
  if c.id is null then return null; end if;
  select jsonb_build_object(
    'client', jsonb_build_object('name', c.name, 'company', c.company),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'title', r.title, 'status', r.status, 'spec', r.spec, 'quantity', r.quantity,
        'target_unit_price', r.target_unit_price, 'client_unit_price', r.client_unit_price, 'deadline', r.deadline, 'created_at', r.created_at,
        'requirements', coalesce((select jsonb_agg(jsonb_build_object('id', q.id,'kind', q.kind,'body', q.body,'author', q.author,'resolved', q.resolved,'created_at', q.created_at) order by q.created_at) from public.client_requirements q where q.request_id = r.id), '[]'::jsonb),
        'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', k.id,'name', coalesce(f.name,k.listing_title),'city', f.city,'is_verified_factory', f.is_verified_factory,'status', k.status,'rank', k.rank) order by k.rank nulls last) from public.request_candidates k left join public.factories f on f.id = k.factory_id where k.request_id = r.id and k.released_to_client), '[]'::jsonb),
        'quotes', coalesce((select jsonb_agg(jsonb_build_object('id', qt.id,'landed_unit_cost', qt.landed_unit_cost,'client_unit_price', qt.client_unit_price,'status', qt.status,'breakdown', qt.breakdown,'created_at', qt.created_at) order by qt.created_at desc) from public.quotes qt where qt.request_id = r.id and qt.released_to_client), '[]'::jsonb),
        'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id,'status', o.status,'qty', o.qty,'po_id', o.po_id,'deposit_paid', o.deposit_paid,'balance_paid', o.balance_paid,'updated_at', o.updated_at)) from public.sourcing_orders o where o.request_id = r.id), '[]'::jsonb)
      ) order by r.created_at desc) from public.sourcing_requests r where r.client_id = c.id), '[]'::jsonb)
  ) into out;
  return out;
end $$;

create or replace function public.portal_add_requirement(p_token text, p_request_id uuid, p_kind text, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare c public.clients; r public.sourcing_requests; nid uuid;
begin
  select * into c from public.clients where portal_token = p_token and portal_active;
  if c.id is null then raise exception 'invalid portal token'; end if;
  select * into r from public.sourcing_requests where id = p_request_id and client_id = c.id;
  if r.id is null then raise exception 'request not found'; end if;
  if p_kind not in ('requirement','defect_to_watch','question','approval') then p_kind := 'requirement'; end if;
  if length(trim(p_body)) = 0 or length(p_body) > 4000 then raise exception 'empty or too long'; end if;
  insert into public.client_requirements(workspace_id, request_id, kind, body, author) values (r.workspace_id, r.id, p_kind, p_body, 'client') returning id into nid;
  return nid;
end $$;

create or replace function public.portal_new_request(p_token text, p_title text, p_brief text, p_quantity integer, p_target_price numeric, p_deadline date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c public.clients; nid uuid;
begin
  select * into c from public.clients where portal_token = p_token and portal_active;
  if c.id is null then raise exception 'invalid portal token'; end if;
  if length(trim(coalesce(p_title,''))) = 0 then raise exception 'title required'; end if;
  insert into public.sourcing_requests(workspace_id, client_id, title, raw_brief, quantity, target_unit_price, deadline, status)
    values (c.workspace_id, c.id, left(p_title, 200), left(p_brief, 8000), p_quantity, p_target_price, p_deadline, 'intake') returning id into nid;
  return nid;
end $$;

revoke all on function public.portal_view(text) from public;
revoke all on function public.portal_add_requirement(text, uuid, text, text) from public;
revoke all on function public.portal_new_request(text, text, text, integer, numeric, date) from public;
grant execute on function public.portal_view(text) to anon, authenticated;
grant execute on function public.portal_add_requirement(text, uuid, text, text) to anon, authenticated;
grant execute on function public.portal_new_request(text, text, text, integer, numeric, date) to anon, authenticated;
grant execute on function public.calc_landed_cost(jsonb, jsonb) to anon, authenticated;

-- Default rate card for every existing workspace. Values are placeholders for Gary to confirm and date.
insert into public.cost_assumptions (workspace_id, name, effective_date, is_default, rates, notes)
select w.id, 'Default US import (confirm rates)', current_date, true,
  jsonb_build_object('fx_cny_per_usd', 7.20, 'hts_duty_pct', 0, 'section_301_pct', 25, 'other_tariff_pct', 0,
    'mpf_pct', 0.3464, 'mpf_min_usd', 32.71, 'mpf_max_usd', 634.62, 'hmf_pct', 0.125, 'broker_fee_usd', 150,
    'insurance_pct', 0.3, 'payment_fee_pct', 1.0, 'vat_rebate_pct', 13, 'apply_vat_rebate', false, 'commission_pct', 6),
  'Placeholder rates. Check the HTS duty for each product, the current Section 301 and other China tariff rates, and the MPF min/max for this fiscal year before quoting.'
from public.workspaces w
where not exists (select 1 from public.cost_assumptions a where a.workspace_id = w.id);
