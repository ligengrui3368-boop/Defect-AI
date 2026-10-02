-- Step 4: the Order step. Milestones (deposit, production, factory inspection, balance, shipping, delivery),
-- the hidden Quality inspection reconnected as part of the order, shipping details, and a timeline entry for each.

alter table public.sourcing_orders
  add column if not exists link_id uuid references public.factory_links(id) on delete set null,
  add column if not exists carrier text,
  add column if not exists tracking text,
  add column if not exists eta date,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz;

-- timeline entries for order milestones; a closed order closes the request
create or replace function public.trg_activity_order_update() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    perform public.log_activity(new.workspace_id, new.request_id, 'order', case new.status
      when 'production' then 'Deposit paid. In production'
      when 'qc' then 'Factory inspection link sent'
      when 'balance' then 'Inspection passed. Balance due'
      when 'shipped' then 'Shipped' || coalesce(' with ' || new.carrier, '') || coalesce(', tracking ' || new.tracking, '')
      when 'arrived' then 'Delivered to the client'
      when 'closed' then 'Order closed'
      else 'Order: ' || new.status end);
    if new.status = 'closed' then update public.sourcing_requests set status = 'closed' where id = new.request_id and status <> 'closed'; end if;
  end if;
  if new.balance_paid and not coalesce(old.balance_paid, false) then perform public.log_activity(new.workspace_id, new.request_id, 'order', 'Balance paid'); end if;
  return null;
end $$;
drop trigger if exists activity_order_update on public.sourcing_orders;
create trigger activity_order_update after update of status, balance_paid on public.sourcing_orders for each row execute function public.trg_activity_order_update();

-- when the factory finishes the sampled inspection, the order moves on by itself
create or replace function public.trg_order_inspection() returns trigger language plpgsql security definer set search_path = public as $$
declare o public.sourcing_orders;
begin
  if new.result is null or new.result is not distinct from old.result then return null; end if;
  for o in select * from public.sourcing_orders where link_id = new.link_id loop
    perform public.log_activity(o.workspace_id, o.request_id, 'inspection', case when new.result = 'PASS' then 'Factory inspection passed'
      when new.result = 'FAIL' then 'Factory inspection failed. Review the photos before paying the balance'
      else 'Factory inspection needs your review before paying the balance' end || coalesce(' (' || new.sample_size || ' units checked)', ''), 'Lathe');
    if new.result = 'PASS' and o.status in ('production', 'qc') then update public.sourcing_orders set status = 'balance' where id = o.id; end if;
  end loop;
  return null;
end $$;
drop trigger if exists order_inspection on public.factory_sessions;
create trigger order_inspection after update of result on public.factory_sessions for each row execute function public.trg_order_inspection();
revoke execute on function public.trg_activity_order_update(), public.trg_order_inspection() from public, anon, authenticated;

-- the shared next step now names the exact order milestone
drop view if exists public.request_flow;
create view public.request_flow with (security_invoker = true) as
with c as (select request_id, count(*) n from public.request_candidates where status <> 'rejected' group by 1),
n as (select request_id, count(*) filter (where status <> 'dropped') n, count(*) filter (where status = 'waiting_us') waiting_us from public.negotiations group by 1),
o as (select distinct on (g.request_id) g.request_id, g.id neg_id, f.name factory, coalesce(g.agreed_cny, g.current_offer_cny) price, g.agreed_cny is not null agreed
      from public.negotiations g left join public.factories f on f.id = g.factory_id
      where g.status <> 'dropped' and coalesce(g.agreed_cny, g.current_offer_cny) is not null
      order by g.request_id, (g.agreed_cny is not null) desc, g.updated_at desc),
q as (select request_id, count(*) filter (where status <> 'rejected') n, count(*) filter (where released_to_client and status <> 'rejected') released, count(*) filter (where status = 'rejected') rejected from public.quotes group by 1),
od as (select distinct on (request_id) request_id, count(*) over (partition by request_id) n, status order_status, link_id from public.sourcing_orders order by request_id, created_at desc),
j as (select distinct on (request_id) request_id, id job_id, kind job_kind, label job_label, created_at job_started
      from public.jobs where status = 'running' and created_at > now() - interval '10 minutes' order by request_id, created_at desc),
b as (
  select r.id, r.workspace_id, r.status,
    coalesce(c.n, 0)::int candidates, coalesce(n.n, 0)::int negotiations, coalesce(n.waiting_us, 0)::int waiting_us,
    o.neg_id offer_neg_id, o.factory offer_factory, o.price offer_cny, coalesce(o.agreed, false) offer_agreed,
    coalesce(q.n, 0)::int quotes, coalesce(q.released, 0)::int quotes_released, coalesce(q.rejected, 0)::int quotes_rejected, coalesce(od.n, 0)::int orders, od.order_status, od.link_id order_link_id,
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
    when b.quotes_rejected > 0 then 'revise_quote'
    when b.offer_agreed then 'build_quote'
    when b.waiting_us > 0 then 'reply_factory'
    when b.offer_cny is not null then 'build_quote'
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
       when next_key in ('release_quote', 'await_client', 'revise_quote') then 'quote'
       else 'order' end phase,
  (next_key in ('add_spec', 'run_intake', 'search', 'search_photo', 'pick_factories', 'reply_factory', 'build_quote', 'release_quote', 'revise_quote', 'place_order')
    or (next_key = 'track_order' and coalesce(order_status, 'deposit') in ('deposit', 'production', 'balance', 'arrived'))) needs_you,
  case next_key
    when 'done' then 'This request is closed'
    when 'working' then coalesce(job_label, 'Searching 1688') || '…'
    when 'track_order' then case coalesce(order_status, 'deposit') when 'deposit' then 'Confirm the deposit is paid' when 'production' then 'In production: set up the factory inspection'
      when 'qc' then 'Waiting on the factory inspection' when 'balance' then 'Inspection passed: pay the balance' when 'shipped' then 'On its way to the client'
      when 'arrived' then 'Delivered: close the request' else 'Track the order' end
    when 'place_order' then 'The client approved. Place the order'
    when 'release_quote' then 'Send the quote to the client'
    when 'await_client' then 'Waiting on the client'
    when 'revise_quote' then 'The client declined the quote'
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
    when 'track_order' then case coalesce(order_status, 'deposit') when 'deposit' then 'Once the factory confirms the deposit, mark it paid and production starts.'
      when 'production' then 'Lathe sends the factory a link; they photograph randomly picked units and the AI checks them against the spec.'
      when 'qc' then 'The factory is photographing the sampled units. The result appears here by itself.'
      when 'balance' then 'The goods passed. Pay the balance, then add the shipping details.'
      when 'shipped' then 'Mark it delivered when the client receives it.'
      when 'arrived' then 'Everything is done. Close it to finish the request.' else 'Tick off each milestone as it happens.' end
    when 'place_order' then 'Create the order from the approved quote.'
    when 'release_quote' then 'Releasing it puts it in the client''s portal, where they can approve it.'
    when 'await_client' then 'They can approve or decline it in their portal; it moves on by itself.'
    when 'revise_quote' then 'Their reason is in the activity and notes. Renegotiate or adjust your margin, then save a new quote.'
    when 'build_quote' then coalesce(offer_factory, 'Factory') || ' at ¥' || trim(to_char(offer_cny, 'FM999999990.00')) || case when offer_agreed then ' (agreed)' else ' (latest offer)' end || '. Lathe adds freight, duty and your margin.'
    when 'reply_factory' then 'Their reply is in. Send the counter-offer Lathe drafted, or paste their newest message.'
    when 'get_offers' then 'Draft the Chinese RFQ, send it on 1688 or WeChat, then log each offer here.'
    when 'pick_factories' then candidates || ' candidate' || case when candidates = 1 then '' else 's' end || ', best match first. Press Negotiate on the ones you like, or Refresh results for different factories.'
    when 'add_spec' then 'Write what the client wants, or drop in product photos.'
    when 'run_intake' then 'It structures the spec' || case when photos > 0 then ', reads the photos' else '' end || ' and writes the Chinese 1688 search terms.'
    else case when open_questions > 0 then open_questions || ' open question' || case when open_questions = 1 then '' else 's' end || ' for the client on the Spec step; you can search meanwhile.'
              when next_key = 'search_photo' then 'Search with your product photos, or with the Chinese search terms.'
              else 'Search 1688 with the Chinese search terms from the spec.' end end next_hint
from k;
grant select on public.request_flow to authenticated;
