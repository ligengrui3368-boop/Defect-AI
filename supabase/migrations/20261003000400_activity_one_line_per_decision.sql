-- Timeline: one line per client decision, and a decline carries the client's reason.
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
  -- the note first, so the timeline line for the quote can include the client's reason
  insert into public.client_requirements(workspace_id, request_id, kind, body, author)
    values (r.workspace_id, r.id, case when p_approve then 'approval' else 'question' end,
            case when p_approve then 'Approved the quote of $' || coalesce(trim(to_char(q.client_unit_price, 'FM999999990.00')), '?') || ' per unit.'
                 else 'Declined the quote' || coalesce(': ' || nullif(left(trim(p_reason), 1000), ''), '.') end, 'client');
  update public.quotes set status = case when p_approve then 'accepted' else 'rejected' end where id = q.id;
  return case when p_approve then 'accepted' else 'rejected' end;
end $$;

create or replace function public.trg_activity_quote() returns trigger language plpgsql security definer set search_path = public as $$
declare why text;
begin
  if tg_op = 'INSERT' then perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Quote saved: $' || coalesce(trim(to_char(new.client_unit_price, 'FM999999990.00')), '?') || ' per unit');
  else
    if new.released_to_client and not coalesce(old.released_to_client, false) then perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Quote sent to the client portal'); end if;
    if new.status = 'accepted' and old.status is distinct from 'accepted' then
      perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Client approved the quote of $' || coalesce(trim(to_char(new.client_unit_price, 'FM999999990.00')), '?') || ' per unit', 'Client'); end if;
    if new.status = 'rejected' and old.status is distinct from 'rejected' then
      select substring(body from '^Declined the quote: (.*)$') into why from public.client_requirements
        where request_id = new.request_id and author = 'client' and body like 'Declined the quote%' and created_at > now() - interval '1 minute' order by created_at desc limit 1;
      perform public.log_activity(new.workspace_id, new.request_id, 'quote', 'Client declined the quote of $' || coalesce(trim(to_char(new.client_unit_price, 'FM999999990.00')), '?') || coalesce(': ' || why, ''), 'Client'); end if;
  end if;
  return null;
end $$;

create or replace function public.trg_activity_note() returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- approvals and declines are logged once, by the quote itself
  if new.author = 'client' and (new.kind = 'approval' or new.body like 'Declined the quote%') then return null; end if;
  perform public.log_activity(new.workspace_id, new.request_id, 'note',
    case when new.author = 'client' then 'Client ' || case new.kind when 'answer' then 'answered: ' when 'question' then 'wrote: ' else 'added a ' || replace(new.kind, '_', ' ') || ': ' end
      else 'Note: ' end || left(new.body, 300), case when new.author = 'client' then 'Client' else null end);
  return null;
end $$;
revoke execute on function public.trg_activity_quote(), public.trg_activity_note() from public, anon, authenticated;
