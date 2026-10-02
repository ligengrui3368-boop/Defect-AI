-- Factory contact details fetched from each 1688 shop's public contact page (联系方式).
alter table public.factories
  add column if not exists mobile text,
  add column if not exists fax text,
  add column if not exists address text,
  add column if not exists website text,
  add column if not exists shop_url text,
  add column if not exists contact_status text check (contact_status in ('ok','none','error')),
  add column if not exists contact_fetched_at timestamptz;
comment on column public.factories.contact_status is 'Result of the last automatic contact fetch from the 1688 shop contact page: ok (found), none (page had no contacts), error (page could not be loaded).';
