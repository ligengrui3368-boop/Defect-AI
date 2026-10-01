-- Continuous capture: a submitted pick goes to 'checking' while the AI runs in the
-- background, so the factory can move straight on to the next unit.
alter table public.factory_picks drop constraint if exists factory_picks_status_check;
alter table public.factory_picks add constraint factory_picks_status_check
  check (status in ('pending', 'issued', 'checking', 'done', 'missed'));

-- The buyer's decision for a sampled lot: release or hold the factory's payment.
alter table public.factory_sessions
  add column buyer_decision text check (buyer_decision in ('release', 'hold')),
  add column decided_at timestamptz,
  add column decided_by text;
