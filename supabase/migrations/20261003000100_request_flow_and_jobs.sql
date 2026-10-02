-- One engine for "what's next" on every request, read by Home, the requests list, the request page and Operator.
-- Requests move forward through their stages on their own, and long 1688 searches run as background jobs.

-- 1. Background jobs (1688 searches) with live progress
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid references public.sourcing_requests(id) on delete cascade,
  kind text not null check (kind in ('search_1688', 'search_photo', 'refresh_search')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  label text,
  result jsonb,
  error text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists jobs_ws_created on public.jobs(workspace_id, created_at desc);
create index if not exists jobs_request on public.jobs(request_id);
alter table public.jobs enable row level security;
create policy "members see jobs" on public.jobs for select using (public.is_member(workspace_id));
create policy "members start jobs" on public.jobs for insert with check (public.is_member(workspace_id));
create policy "members update jobs" on public.jobs for update using (public.is_member(workspace_id));
create policy "members delete jobs" on public.jobs for delete using (public.is_member(workspace_id));

-- 2. Stages move forward by themselves (never backward), from what exists on the request
create or replace function public.advance_request(p_request uuid) returns void
language plpgsql set search_path = public as $$
declare cur text; target text;
  stages text[] := array['intake','sourcing','shortlisted','negotiating','quoted','approved','ordered','closed'];
begin
  select status into cur from public.sourcing_requests where id = p_request;
  if cur is null or cur = 'closed' then return; end if;
  target := case
    when exists (select 1 from public.sourcing_orders where request_id = p_request) then 'ordered'
    when exists (select 1 from public.quotes where request_id = p_request and status = 'accepted') then 'approved'
    when exists (select 1 from public.quotes where request_id = p_request) then 'quoted'
    when exists (select 1 from public.negotiations where request_id = p_request and status <> 'dropped') then 'negotiating'
    when exists (select 1 from public.request_candidates where request_id = p_request and status <> 'rejected') then 'sourcing'
    else null end;
  if target is not null and array_position(stages, target) > array_position(stages, cur) then
    update public.sourcing_requests set status = target where id = p_request;
  end if;
end $$;
create or replace function public.trg_advance_request() returns trigger
language plpgsql set search_path = public as $$
begin perform public.advance_request(coalesce(new.request_id, old.request_id)); return null; end $$;
drop trigger if exists advance_on_candidate on public.request_candidates;
create trigger advance_on_candidate after insert or update of status on public.request_candidates for each row execute function public.trg_advance_request();
drop trigger if exists advance_on_negotiation on public.negotiations;
create trigger advance_on_negotiation after insert or update of status on public.negotiations for each row execute function public.trg_advance_request();
drop trigger if exists advance_on_quote on public.quotes;
create trigger advance_on_quote after insert or update of status on public.quotes for each row execute function public.trg_advance_request();
drop trigger if exists advance_on_order on public.sourcing_orders;
create trigger advance_on_order after insert on public.sourcing_orders for each row execute function public.trg_advance_request();
revoke execute on function public.advance_request(uuid) from public, anon;
grant execute on function public.advance_request(uuid) to authenticated;

-- 3. The shared "next step" for every request (row level security of the caller applies)
create or replace view public.request_flow with (security_invoker = true) as
with c as (select request_id, count(*) n from public.request_candidates where status <> 'rejected' group by 1),
n as (select request_id, count(*) filter (where status <> 'dropped') n, count(*) filter (where status = 'waiting_us') waiting_us from public.negotiations group by 1),
o as (select distinct on (g.request_id) g.request_id, g.id neg_id, f.name factory, coalesce(g.agreed_cny, g.current_offer_cny) price, g.agreed_cny is not null agreed
      from public.negotiations g left join public.factories f on f.id = g.factory_id
      where g.status <> 'dropped' and coalesce(g.agreed_cny, g.current_offer_cny) is not null
      order by g.request_id, (g.agreed_cny is not null) desc, g.updated_at desc),
q as (select request_id, count(*) n, count(*) filter (where released_to_client) released from public.quotes group by 1),
od as (select request_id, count(*) n from public.sourcing_orders group by 1),
j as (select distinct on (request_id) request_id, id job_id, kind job_kind, label job_label, created_at job_started
      from public.jobs where status = 'running' and created_at > now() - interval '10 minutes' order by request_id, created_at desc),
b as (
  select r.id, r.workspace_id, r.status,
    coalesce(c.n, 0)::int candidates, coalesce(n.n, 0)::int negotiations, coalesce(n.waiting_us, 0)::int waiting_us,
    o.neg_id offer_neg_id, o.factory offer_factory, o.price offer_cny, coalesce(o.agreed, false) offer_agreed,
    coalesce(q.n, 0)::int quotes, coalesce(q.released, 0)::int quotes_released, coalesce(od.n, 0)::int orders,
    (r.spec ? 'intake_at') intake_done,
    coalesce(case when jsonb_typeof(r.spec->'questions') = 'array' then jsonb_array_length(r.spec->'questions') end, 0) open_questions,
    coalesce(case when jsonb_typeof(r.spec->'photos') = 'array' then jsonb_array_length(r.spec->'photos') end, 0) photos,
    coalesce(r.raw_brief, '') <> '' has_brief,
    j.job_id, j.job_kind, j.job_label, j.job_started
  from public.sourcing_requests r
  left join c on c.request_id = r.id left join n on n.request_id = r.id left join o on o.request_id = r.id
  left join q on q.request_id = r.id left join od on od.request_id = r.id left join j on j.request_id = r.id),
k as (
  select b.*, case
    when b.status = 'closed' then 'done'
    when b.job_id is not null then 'working'
    when b.orders > 0 then 'track_order'
    when b.status = 'approved' and b.quotes > 0 then 'place_order'
    when b.quotes > 0 and b.quotes_released = 0 then 'release_quote'
    when b.quotes > 0 then 'await_client'
    when b.offer_cny is not null then 'build_quote'
    when b.waiting_us > 0 then 'reply_factory'
    when b.negotiations > 0 then 'get_offers'
    when b.candidates > 0 then 'pick_factories'
    when not b.intake_done and not b.has_brief and b.photos = 0 then 'add_spec'
    when not b.intake_done then 'run_intake'
    when b.photos > 0 then 'search_photo'
    else 'search' end next_key
  from b)
select k.*,
  case when next_key in ('add_spec', 'run_intake') then 'intake'
       when next_key in ('search', 'search_photo', 'pick_factories', 'working') then 'sourcing'
       when next_key in ('get_offers', 'reply_factory', 'build_quote') then 'negotiating'
       when next_key in ('release_quote', 'await_client') then 'quote'
       else 'order' end phase,
  next_key in ('add_spec', 'run_intake', 'search', 'search_photo', 'pick_factories', 'reply_factory', 'build_quote', 'release_quote', 'place_order') needs_you,
  case next_key
    when 'done' then 'This request is closed'
    when 'working' then coalesce(job_label, 'Searching 1688') || '…'
    when 'track_order' then 'Track the order'
    when 'place_order' then 'The client approved. Place the order'
    when 'release_quote' then 'Send the quote to the client'
    when 'await_client' then 'Waiting on the client'
    when 'build_quote' then 'Build the client quote'
    when 'reply_factory' then waiting_us || case when waiting_us = 1 then ' factory is' else ' factories are' end || ' waiting on your reply'
    when 'get_offers' then 'Get prices from the factories'
    when 'pick_factories' then 'Pick 2–3 factories to negotiate with'
    when 'add_spec' then 'Add the spec'
    when 'run_intake' then 'Let the AI read the spec'
    else 'Find factories on 1688' end next_title,
  case next_key
    when 'done' then 'Reopen it from the stage menu if anything changes.'
    when 'working' then 'Running in the background. Keep working; the results appear here when they are ready.'
    when 'track_order' then 'Tick off the deposit, production and balance as they happen.'
    when 'place_order' then 'Create the order from the approved quote.'
    when 'release_quote' then 'Releasing it puts it in the client''s portal, where they can approve it.'
    when 'await_client' then 'Mark it approved when they say yes.'
    when 'build_quote' then coalesce(offer_factory, 'Factory') || ' at ¥' || trim(to_char(offer_cny, 'FM999999990.00')) || case when offer_agreed then ' (agreed)' else ' (latest offer)' end || '. Lathe adds freight, duty and your margin.'
    when 'reply_factory' then 'Log what they sent and answer them on 1688 or WeChat.'
    when 'get_offers' then 'Draft the Chinese RFQ, send it on 1688 or WeChat, then log each offer here.'
    when 'pick_factories' then candidates || ' candidate' || case when candidates = 1 then '' else 's' end || ', best match first. Press Negotiate on the ones you like, or Refresh results for different factories.'
    when 'add_spec' then 'Write what the client wants, or drop in product photos.'
    when 'run_intake' then 'It structures the spec' || case when photos > 0 then ', reads the photos' else '' end || ' and writes the Chinese 1688 search terms.'
    else case when open_questions > 0 then open_questions || ' open question' || case when open_questions = 1 then '' else 's' end || ' for the client on the Spec step; you can search meanwhile.'
              when next_key = 'search_photo' then 'Search with your product photos, or with the Chinese search terms.'
              else 'Search 1688 with the Chinese search terms from the spec.' end end next_hint
from k;
grant select on public.request_flow to authenticated;

-- 4. Live updates for the sourcing screens (these tables were never in the realtime publication)
do $$ declare t text; begin
  foreach t in array array['sourcing_requests','request_candidates','negotiations','quotes','client_requirements','sourcing_orders','factories','clients','jobs'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 5. Bring existing requests up to date
select public.advance_request(id) from public.sourcing_requests;
