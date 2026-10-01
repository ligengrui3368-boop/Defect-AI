-- Arrival checks: the receiving warehouse photographs units when a shipment lands,
-- and each finding is traced back to the factory check of the same lot.

alter table public.inspections
  add column stage text not null default 'factory' check (stage in ('factory', 'arrival')),
  add column origin_id uuid references public.inspections(id) on delete set null,
  add column damage_origin text check (damage_origin in ('none', 'factory', 'transit', 'both', 'unclear'));

comment on column public.inspections.stage is 'factory = checked before shipping; arrival = checked when the shipment was received';
comment on column public.inspections.origin_id is 'For arrival checks: the factory check of the same unit, when one was matched';
comment on column public.inspections.damage_origin is 'For arrival checks: where the problems found on arrival most likely happened';

-- Lot lookups: all checks of one product lot, factory and arrival side by side.
create index inspections_lot_idx on public.inspections (workspace_id, product_id, lot, stage);
