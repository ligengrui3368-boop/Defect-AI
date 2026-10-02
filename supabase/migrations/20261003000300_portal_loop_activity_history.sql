-- Step 3: the client portal closes the loop, every request keeps an activity timeline, and factories carry
-- their history across requests.

-- 1. Client answers to the intake questions
alter table public.client_requirements drop constraint if exists client_requirements_kind_check;
alter table public.client_requirements add constraint client_requirements_kind_check check (kind in ('requirement', 'defect_to_watch', 'question', 'approval', 'answer'));

-- 2. Approve or decline a quote from the portal (the request then moves on by itself)
create or replace function public.portal_quote_decision(p_token text, p_quote_id uuid, p_approve boolean, p_reason text default null)
returns text language plpgsql security definer set search_path = public as $$
declare c public.clients; q public.quotes; r public.sourcing_requests;
begin
  select * into c from public.clients where portal_token = p_token and portal_active;
  if c.id is null then raise exception 'invalid portal token'; end if;
  select * into q from public.quotes where id = p_quote_id and released_to_client;
  if q.id is null then raise exception 'quote not found'; end if;
  select * into r from public.sourcing_requests where id = q.request_id and client_id = c.id;
  if r.id is null then raise exception 'quote not found'; end if;
  update public.quotes set status = case when p_approve then 'accepted' else 'rejected' end where id = q.id;
  insert into public.client_requirements(workspace_id, request_id, kind, body, author)
    values (r.workspace_id, r.id, case when p_approve then 'approval' else 'question' end,
            case when p_approve then 'Approved the quote of $' || coalesce(trim(to_char(q.client_unit_price, 'FM999999990.00')), '?') || ' per unit.'
                 else 'Declined the quote' || coalesce(': ' || nullif(left(trim(p_reason), 1000), ''), '.') end, 'client');
  return case when p_approve then 'accepted' else 'rejected' end;
end $$;
revoke all on function public.portal_quote_decision(text, uuid, boolean, text) from public;
grant execute on function public.portal_quote_decision(text, uuid, boolean, text) to anon, authenticated;

-- 3. Activity timeline, written by triggers so every path (app, Operator, portal, background jobs) is recorded the same way
create table if not exists public.activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid references public.sourcing_requests(id) on delete cascade,
  at timestamptz not null default now(),
  actor text,
  kind text not null,
  body text not null
);
create index if not exists activity_req on public.activity(request_id, at desc);
create index if not exists activity_ws on public.activity(workspace_id, at desc);
alter table public.activity enable row level security;
create policy "members see activity" on public.activity for select using (public.is_member(workspace_id));
create policy "members add activity" on public.activity for insert with check (public.is_member(workspace_id));

create or replace function public.log_activity(p_ws uuid, p_req uuid, p_kind text, p_body text, p_actor text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity(workspace_id, request_id, kind, body, actor)
  values (p_ws, p_req, p_kind, left(p_body, 600), coalesce(p_actor, (select email from auth.users where id = auth.uid()), 'Lathe'));
end $$;
revoke all on function public.log_activity(uuid, uuid, text, text, text) from public, anon, authenticated;

create or replace function public.phase_label(s text) returns text language sql immutable as $$
  select case s when 'intake' then 'Spec' when 'sourcing' then 'Find factories' when 'shortlisted' then 'Find factories'
    when 'negotiating' then 'Negotiate' when 'quoted' then 'Quote' when 'approved' then 'Quote (approved)'
    when 'ordered' then 'Order' when 'closed' then 'Closed' else s end $$;
create or replace function public.money_cny(n numeric) returns text language sql immutable as $$ select '¥' || trim(to_char(n, 'FM999999990.00')) $$;

create or replace function public.trg_activity_request() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform public.log_activity(new.workspace_id, new.id, 'created', 'Request created: ' || new.title);
  else
    if public.phase_label(old.status) is distinct from public.phase_label(new.status) then
      perform public.log_activity(new.workspace_id, new.id, 'stage', 'Moved to ' || public.phase_label(new.status)); end if;
    if (old.spec->>'intake_at') is distinct from (new.spec->>'intake_at') and new.spec ? 'intake_at' then
      perform public.log_activity(new.workspace_id, new.id, 'intake', 'AI read the spec' || case when jsonb_typeof(new.spec->'questions') = 'array' and jsonb_array_length(new.spec->'questions') > 0
        then ' (' || jsonb_array_length(new.spec->'questions') || ' questions for the client)' else '' end); end if;
  end if;
  return null;
end $$;
drop trigger if exists activity_request on public.sourcing_requests;
create trigger activity_request after insert or update of status, spec on public.sourcing_requests for each row execute function public.trg_activity_request();

create or replace function public.trg_activity_job() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'running' and new.status = 'done' then
    perform public.log_activity(new.workspace_id, new.request_id, 'search', case when new.kind = 'refresh_search'
      then 'Found ' || coalesce(new.result->>'new_candidates', '0') || ' listings from different factories'
      else coalesce(new.label, '1688 search') || ': kept ' || coalesce(new.result->>'kept', new.result->>'listings', '0') || ' of ' || coalesce(new.result->>'scanned', new.result->>'listings', '0') || ' listings' end, 'Lathe');
  elsif old.status = 'running' and new.status = 'failed' then
    perform public.log_activity(new.workspace_id, new.request_id, 'search', coalesce(new.label, 'Search') || ' failed: ' || coalesce(new.error, ''), 'Lathe');
  end if;
  return null;
end $$;
drop trigger if exists activity_job on public.jobs;
create trigger activity_job after update of status on public.jobs for each row execute function public.trg_activity_job();

create or replace function public.trg_activity_negotiation() returns trigger language plpgsql security definer set search_path = public as $$
declare f text := coalesce((select name from public.factories where id = new.factory_id), 'a factory');
begin
  if tg_op = 'INSERT' then perform public.log_activity(new.workspace_id, new.request_id, 'negotiation', 'Started talks with ' || f);
  else
    if new.agreed_cny is not null and new.agreed_cny is distinct from old.agreed_cny then
      perform public.log_activity(new.workspace_id, new.request_id, 'negotiation', 'Agreed ' || public.money_cny(new.agreed_cny) || ' with ' || f);
    elsif new.current_offer_cny is not null and new.current_offer_cny is distinct from old.current_offer_cny then
      perform public.log_activity(new.workspace_id, new.request_id, 'negotiation', f || ' offered ' || public.money_cny(new.current_offer_cny)); end if;
    if new.status = 'waiting_factory' and old.status is distinct from 'waiting_factory' then
      perform public.log_activity(new.workspace_id, new.request_id, 'negotiation', 'Replied to ' || f); end if;
    if new.status = 'dropped' and old.status is distinct from 'dropped' then
      perform public.log_activity(new.workspace_id, new.request_id, 'negotiation', 'Dropped ' || f); end if;
  end if;
  return null;
end $$;
drop trigger if exists activity_negotiation on public.negotiations;
create trigger activity_negotiation after insert or update of status, current_offer_cny, agreed_cny on public.negotiations for each row execute function public.trg_activity_negotiation();

create or replace function public.trg_activity_quote() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Quote saved: $' || coalesce(trim(to_char(new.client_unit_price, 'FM999999990.00')), '?') || ' per unit');
  else
    if new.released_to_client and not coalesce(old.released_to_client, false) then perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Quote sent to the client portal'); end if;
    if new.status = 'accepted' and old.status is distinct from 'accepted' then perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Client approved the quote', 'Client'); end if;
    if new.status = 'rejected' and old.status is distinct from 'rejected' then perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Client declined the quote', 'Client'); end if;
  end if;
  return null;
end $$;
drop trigger if exists activity_quote on public.quotes;
create trigger activity_quote after insert or update of status, released_to_client on public.quotes for each row execute function public.trg_activity_quote();

create or replace function public.trg_activity_note() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_activity(new.workspace_id, new.request_id, 'note',
    case when new.author = 'client' then 'Client ' || case new.kind when 'answer' then 'answered: ' when 'approval' then '' when 'question' then 'wrote: ' else 'added a ' || replace(new.kind, '_', ' ') || ': ' end
      else 'Note: ' end || left(new.body, 300), case when new.author = 'client' then 'Client' else null end);
  return null;
end $$;
drop trigger if exists activity_note on public.client_requirements;
create trigger activity_note after insert on public.client_requirements for each row execute function public.trg_activity_note();

create or replace function public.trg_activity_order() returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.log_activity(new.workspace_id, new.request_id, 'order', 'Order placed'); return null; end $$;
drop trigger if exists activity_order on public.sourcing_orders;
create trigger activity_order after insert on public.sourcing_orders for each row execute function public.trg_activity_order();
revoke execute on function public.trg_activity_request(), public.trg_activity_job(), public.trg_activity_negotiation(), public.trg_activity_quote(), public.trg_activity_note(), public.trg_activity_order() from public, anon, authenticated;

-- 4. Factory history across requests
create or replace view public.factory_history with (security_invoker = true) as
select f.id factory_id, f.workspace_id,
  (select count(distinct g.request_id) from public.negotiations g where g.factory_id = f.id)::int negotiated,
  (select count(*) from public.negotiations g where g.factory_id = f.id and g.agreed_cny is not null)::int agreed_count,
  (select jsonb_build_object('price_cny', g.agreed_cny, 'request_id', g.request_id, 'title', r.title, 'at', g.updated_at)
     from public.negotiations g join public.sourcing_requests r on r.id = g.request_id
     where g.factory_id = f.id and g.agreed_cny is not null order by g.updated_at desc limit 1) last_agreed,
  (select count(*) from public.quotes q join public.sourcing_orders o on o.quote_id = q.id where q.factory_id = f.id)::int orders
from public.factories f;
grant select on public.factory_history to authenticated;

-- 5. The shared next step: a declined quote now reads "The client declined the quote"
drop view if exists public.request_flow;
create view public.request_flow with (security_invoker = true) as
with c as (select request_id, count(*) n from public.request_candidates where status <> 'rejected' group by 1),
n as (select request_id, count(*) filter (where status <> 'dropped') n, count(*) filter (where status = 'waiting_us') waiting_us from public.negotiations group by 1),
o as (select distinct on (g.request_id) g.request_id, g.id neg_id, f.name factory, coalesce(g.agreed_cny, g.current_offer_cny) price, g.agreed_cny is not null agreed
      from public.negotiations g left join public.factories f on f.id = g.factory_id
      where g.status <> 'dropped' and coalesce(g.agreed_cny, g.current_offer_cny) is not null
      order by g.request_id, (g.agreed_cny is not null) desc, g.updated_at desc),
q as (select request_id, count(*) filter (where status <> 'rejected') n, count(*) filter (where released_to_client and status <> 'rejected') released, count(*) filter (where status = 'rejected') rejected from public.quotes group by 1),
od as (select request_id, count(*) n from public.sourcing_orders group by 1),
j as (select distinct on (request_id) request_id, id job_id, kind job_kind, label job_label, created_at job_started
      from public.jobs where status = 'running' and created_at > now() - interval '10 minutes' order by request_id, created_at desc),
b as (
  select r.id, r.workspace_id, r.status,
    coalesce(c.n, 0)::int candidates, coalesce(n.n, 0)::int negotiations, coalesce(n.waiting_us, 0)::int waiting_us,
    o.neg_id offer_neg_id, o.factory offer_factory, o.price offer_cny, coalesce(o.agreed, false) offer_agreed,
    coalesce(q.n, 0)::int quotes, coalesce(q.released, 0)::int quotes_released, coalesce(q.rejected, 0)::int quotes_rejected, coalesce(od.n, 0)::int orders,
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
  next_key in ('add_spec', 'run_intake', 'search', 'search_photo', 'pick_factories', 'reply_factory', 'build_quote', 'release_quote', 'revise_quote', 'place_order') needs_you,
  case next_key
    when 'done' then 'This request is closed'
    when 'working' then coalesce(job_label, 'Searching 1688') || '…'
    when 'track_order' then 'Track the order'
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
    when 'track_order' then 'Tick off the deposit, production and balance as they happen.'
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

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity') then
    alter publication supabase_realtime add table public.activity;
  end if;
end $$;
