-- Client portal: show order milestones, the factory inspection result and shipping/tracking.
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
        'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id,'status', o.status,'qty', o.qty,'deposit_paid', o.deposit_paid,'balance_paid', o.balance_paid,'updated_at', o.updated_at,
          'carrier', o.carrier, 'tracking', o.tracking, 'eta', o.eta, 'shipped_at', o.shipped_at, 'delivered_at', o.delivered_at,
          'inspection', (select jsonb_build_object('result', s.result, 'sample_size', s.sample_size, 'finished_at', s.finished_at) from public.factory_sessions s where s.link_id = o.link_id and s.result is not null order by s.created_at desc limit 1))) from public.sourcing_orders o where o.request_id = r.id), '[]'::jsonb)
      ) order by r.created_at desc) from public.sourcing_requests r where r.client_id = c.id), '[]'::jsonb)
  ) into out;
  return out;
end $$;
