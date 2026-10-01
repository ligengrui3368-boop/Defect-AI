-- Purchase orders with many SKUs, container loading checks, dock receiving, and a shared
-- defect vocabulary. A PO is the unit of work for an importer: each line is one product with
-- its own sampled factory inspection (a factory link), the factory gets one hub link for the
-- whole PO, the container is checked while it is loaded, and the warehouse checks counts,
-- seal and damage when it arrives.

-- ---------- defect codes (shared by every workspace) ----------
create table public.defect_codes (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  scope text not null check (scope in ('product', 'label', 'packaging', 'carton', 'container')),
  name_en text not null,
  name_zh text not null,
  default_severity text not null check (default_severity in ('critical', 'major', 'minor')),
  sort int not null default 0
);
insert into public.defect_codes (code, scope, name_en, name_zh, default_severity, sort) values
  ('SCR', 'product', 'Scratch', '划痕', 'minor', 10),
  ('DNT', 'product', 'Dent', '凹痕', 'major', 11),
  ('CRK', 'product', 'Crack or chip', '裂纹或缺口', 'major', 12),
  ('STN', 'product', 'Stain or mark', '污渍或印记', 'minor', 13),
  ('CLR', 'product', 'Color mismatch', '颜色不符', 'major', 14),
  ('MSP', 'product', 'Missing part', '缺件', 'major', 15),
  ('LSE', 'product', 'Loose or bent part', '松动或变形', 'major', 16),
  ('ASM', 'product', 'Assembly fault', '装配不良', 'major', 17),
  ('DIM', 'product', 'Wrong size', '尺寸不符', 'major', 18),
  ('PRT', 'product', 'Print or logo error', '印刷或标志错误', 'major', 19),
  ('BUR', 'product', 'Burr or sharp edge', '毛刺或锋利边缘', 'critical', 20),
  ('RST', 'product', 'Rust or corrosion', '生锈或腐蚀', 'major', 21),
  ('THR', 'product', 'Loose threads', '线头', 'minor', 22),
  ('WRP', 'product', 'Bubbles or warping', '气泡或翘曲', 'minor', 23),
  ('CON', 'product', 'Foreign matter or contamination', '异物或污染', 'critical', 24),
  ('FNC', 'product', 'Visible function fault', '功能不良', 'major', 25),
  ('LBL', 'label', 'Wrong or missing label', '标签错误或缺失', 'major', 30),
  ('BCD', 'label', 'Wrong or unreadable barcode', '条码错误或无法识别', 'major', 31),
  ('TXT', 'label', 'Required text missing or misspelled', '必需文字缺失或拼写错误', 'major', 32),
  ('PKG', 'packaging', 'Retail packaging damaged', '销售包装损坏', 'major', 40),
  ('PKW', 'packaging', 'Wrong packaging', '包装不符', 'major', 41),
  ('CTN', 'carton', 'Crushed or torn carton', '纸箱压坏或破损', 'minor', 50),
  ('WET', 'carton', 'Wet or stained carton', '纸箱受潮或污染', 'major', 51),
  ('PNC', 'carton', 'Puncture', '刺穿', 'major', 52),
  ('BRK', 'carton', 'Breakage', '破碎', 'critical', 53),
  ('LEK', 'carton', 'Leak', '渗漏', 'critical', 54),
  ('MRK', 'carton', 'Wrong carton marks', '箱唛错误', 'major', 55),
  ('QTY', 'carton', 'Wrong quantity in carton', '装箱数量不符', 'major', 56),
  ('CNT', 'container', 'Container damage (holes, dents, broken doors)', '集装箱破损', 'major', 60),
  ('CND', 'container', 'Container not clean or not dry', '集装箱不干净或潮湿', 'major', 61),
  ('SEL', 'container', 'Seal problem', '封条问题', 'critical', 62),
  ('STW', 'container', 'Poor stowage or bracing', '装载或固定不当', 'major', 63),
  ('OTH', 'product', 'Other', '其他', 'major', 99);
alter table public.defect_codes enable row level security;
create policy "everyone reads defect codes" on public.defect_codes for select to anon, authenticated using (true);
revoke insert, update, delete on public.defect_codes from anon, authenticated;

-- ---------- purchase orders ----------
create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  po_number text not null check (char_length(po_number) between 1 and 60),
  supplier_name text check (char_length(supplier_name) <= 160),
  supplier_city text check (char_length(supplier_city) <= 80),
  ship_by date,
  eta date,
  notes text check (char_length(notes) <= 2000),
  closed boolean not null default false,
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  token_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, po_number)
);
comment on column public.purchase_orders.token is 'Factory hub link: one link for the whole PO (all lines and the loading check)';
create index purchase_orders_ws_idx on public.purchase_orders (workspace_id, created_at desc);

create table public.po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  seq int not null default 1,
  product_id uuid not null references public.products(id) on delete restrict,
  qty int not null check (qty between 1 and 500000),
  cartons int not null check (cartons between 1 and 100000),
  units_per_carton int not null check (units_per_carton between 1 and 100000),
  link_id uuid references public.factory_links(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (po_id, product_id)
);
create index po_lines_po_idx on public.po_lines (po_id, seq);

create or replace function public.touch_po()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
create trigger purchase_orders_touch before update on public.purchase_orders for each row execute function public.touch_po();

-- ---------- container loading checks (factory side, through the PO hub link) ----------
create table public.loading_checks (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'checking', 'done', 'error', 'cancelled')),
  container_no text,           -- typed by the factory
  seal_no text,                -- typed by the factory
  container_no_read text,      -- read from the photos by the AI
  seal_no_read text,
  container_no_valid boolean,  -- ISO 6346 check digit
  photos jsonb not null default '[]'::jsonb,   -- [{path, step}]
  counts jsonb not null default '{}'::jsonb,   -- {po_line_id: cartons loaded}
  result text check (result in ('PASS', 'REVIEW', 'FAIL')),
  ai jsonb,
  error text,
  submitted_by text,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  checked_at timestamptz
);
comment on column public.loading_checks.ai is '{summary, zh, checks[{item,result,note}], defects[{code,type,where,photo,box,severity,conf}], container{ok,issues}, issues[]}';
create index loading_checks_po_idx on public.loading_checks (po_id, started_at desc);

-- ---------- dock receiving (buyer or warehouse side) ----------
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'checking', 'done', 'error')),
  container_no text,
  seal_no text,                -- typed at the dock
  seal_no_read text,           -- read from the seal photo
  seal_intact boolean,
  seal_match boolean,          -- matches the seal recorded at loading
  photos jsonb not null default '[]'::jsonb,   -- [{path, step: seal|doors|overview}]
  counts jsonb not null default '{}'::jsonb,   -- {po_line_id: {received, damaged}}
  damage jsonb not null default '[]'::jsonb,   -- [{id, line_id, carton, note, photos:[{path}], ai}]
  result text check (result in ('PASS', 'REVIEW', 'FAIL')),
  ai jsonb,                    -- {summary, issues[], lines[{line_id, expected, loaded, received, short, over, damaged, origin, why}]}
  error text,
  received_by text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index receipts_po_idx on public.receipts (po_id, created_at desc);

-- ---------- row level security ----------
alter table public.purchase_orders enable row level security;
alter table public.po_lines enable row level security;
alter table public.loading_checks enable row level security;
alter table public.receipts enable row level security;

create policy "members read pos" on public.purchase_orders for select using (public.is_member(workspace_id));
create policy "members add pos" on public.purchase_orders for insert with check (public.is_member(workspace_id));
create policy "members edit pos" on public.purchase_orders for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members delete pos" on public.purchase_orders for delete using (public.is_member(workspace_id));

create policy "members read po lines" on public.po_lines for select using (public.is_member(workspace_id));
create policy "members add po lines" on public.po_lines for insert with check (public.is_member(workspace_id));
create policy "members edit po lines" on public.po_lines for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members delete po lines" on public.po_lines for delete using (public.is_member(workspace_id));

-- Loading checks are written only by the qc Edge Function; buyers read them and may cancel one.
create policy "members read loading" on public.loading_checks for select using (public.is_member(workspace_id));
create policy "members cancel loading" on public.loading_checks for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));

create policy "members read receipts" on public.receipts for select using (public.is_member(workspace_id));
create policy "members add receipts" on public.receipts for insert with check (public.is_member(workspace_id));
create policy "members edit receipts" on public.receipts for update using (public.is_member(workspace_id)) with check (public.is_member(workspace_id));
create policy "members delete receipts" on public.receipts for delete using (public.is_member(workspace_id));

-- ---------- every finding as one row, for defect analytics ----------
-- Older checks have no code: map their free-text type to the closest code.
create or replace function public.defect_code_for(code text, type text)
returns text language sql immutable set search_path = public as $$
  select case
    when code ~ '^[A-Z]{3}$' then code
    when type ilike '%barcode%' then 'BCD'
    when type ilike '%seal%' then 'SEL'
    when type ilike '%label%' then 'LBL'
    when type ilike '%misspell%' or type ilike '%text%' then 'TXT'
    when type ilike '%scratch%' or type ilike '%scuff%' then 'SCR'
    when type ilike '%dent%' then 'DNT'
    when type ilike '%crack%' or type ilike '%chip%' then 'CRK'
    when type ilike '%ink%' or type ilike '%stain%' or type ilike '%mark%' or type ilike '%smudge%' then 'STN'
    when type ilike '%colo%' then 'CLR'
    when type ilike '%missing%' then 'MSP'
    when type ilike '%loose%' or type ilike '%bent%' then 'LSE'
    when type ilike '%print%' or type ilike '%logo%' then 'PRT'
    when type ilike '%burr%' or type ilike '%sharp%' then 'BUR'
    when type ilike '%rust%' or type ilike '%corros%' then 'RST'
    when type ilike '%thread%' then 'THR'
    when type ilike '%bubble%' or type ilike '%warp%' then 'WRP'
    when type ilike '%size%' or type ilike '%dimension%' then 'DIM'
    when type ilike '%leak%' then 'LEK'
    when type ilike '%broken%' or type ilike '%break%' then 'BRK'
    when type ilike '%punct%' then 'PNC'
    when type ilike '%wet%' or type ilike '%water%' then 'WET'
    when type ilike '%carton%' or type ilike '%crush%' or type ilike '%torn%' then 'CTN'
    when type ilike '%packag%' or type ilike '%box%' then 'PKG'
    else 'OTH' end
$$;

create or replace view public.defect_findings with (security_invoker = true) as
  select i.workspace_id, 'unit'::text as source, i.id as source_id, i.product_id, i.product_name, i.lot,
         coalesce(fl.factory_name, po.supplier_name) as supplier, po.id as po_id, i.stage,
         public.defect_code_for(d->>'code', d->>'type') as code, d->>'type' as type, d->>'where' as location,
         coalesce(d->>'severity', 'major') as severity, coalesce((d->>'inSpec')::boolean, false) as in_spec,
         d->>'origin' as origin, i.created_at
  from public.inspections i
  cross join lateral jsonb_array_elements(case when jsonb_typeof(i.ai->'defects') = 'array' then i.ai->'defects' else '[]'::jsonb end) d
  left join public.factory_links fl on fl.id = i.factory_link_id
  left join public.po_lines pl on pl.link_id = i.factory_link_id
  left join public.purchase_orders po on po.id = pl.po_id
  where i.status = 'done'
union all
  select lc.workspace_id, 'loading', lc.id, null, null, po.po_number, po.supplier_name, po.id, 'loading',
         public.defect_code_for(d->>'code', d->>'type'), d->>'type', d->>'where', coalesce(d->>'severity', 'major'), false, 'factory', lc.submitted_at
  from public.loading_checks lc
  join public.purchase_orders po on po.id = lc.po_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(lc.ai->'defects') = 'array' then lc.ai->'defects' else '[]'::jsonb end) d
  where lc.status = 'done'
union all
  select r.workspace_id, 'receiving', r.id, pl.product_id, pr.name, po.po_number, po.supplier_name, po.id, 'receiving',
         public.defect_code_for(d->>'code', d->>'type'), d->>'type', d->>'where', coalesce(d->>'severity', 'major'), false,
         coalesce(dm->'ai'->>'origin', 'unclear'), r.checked_at
  from public.receipts r
  join public.purchase_orders po on po.id = r.po_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(r.damage) = 'array' then r.damage else '[]'::jsonb end) dm
  cross join lateral jsonb_array_elements(case when jsonb_typeof(dm->'ai'->'defects') = 'array' then dm->'ai'->'defects' else '[]'::jsonb end) d
  left join public.po_lines pl on pl.id::text = dm->>'line_id'
  left join public.products pr on pr.id = pl.product_id
  where r.status = 'done';
grant select on public.defect_findings to authenticated;
revoke select on public.defect_findings from anon;

alter publication supabase_realtime add table public.purchase_orders, public.po_lines, public.loading_checks, public.receipts;
