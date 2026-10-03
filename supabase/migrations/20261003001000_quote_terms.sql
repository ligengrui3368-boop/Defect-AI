-- Quotes by trade terms: EXW, FOB, CIF, DDP to the US, DDP to Spain/EU. "landed_unit_usd" stays the name of
-- "our cost per unit at these terms" so the quote, margin and the factory comparison keep working.
create or replace function public.calc_landed_cost(inputs jsonb, rates jsonb)
returns jsonb language plpgsql immutable as $$
declare
  terms text := lower(coalesce(nullif(inputs->>'terms', ''), nullif(rates->>'default_terms', ''), 'ddp_us'));
  qty numeric := greatest(coalesce((inputs->>'qty')::numeric, 1), 1);
  fx numeric := coalesce((rates->>'fx_cny_per_usd')::numeric, 7.2);
  price_cny numeric := coalesce((inputs->>'factory_price_cny')::numeric, 0);
  dom_cny numeric := coalesce((inputs->>'domestic_freight_cny')::numeric, 0);
  intl_usd numeric := coalesce((inputs->>'intl_freight_usd')::numeric, 0);
  mode text := coalesce(inputs->>'mode', 'ocean');
  rebate_pct numeric := case when coalesce((rates->>'apply_vat_rebate')::boolean, false) then coalesce((rates->>'vat_rebate_pct')::numeric, 0) else 0 end;
  goods_usd numeric; dom_usd numeric := 0; export_usd numeric := 0; rebate_usd numeric := 0; fob_usd numeric;
  duty_pct numeric := 0; duty_usd numeric := 0; mpf numeric := 0; hmf numeric := 0; broker numeric := 0; ins numeric := 0; payfee numeric;
  cv numeric := 0; vat_pct numeric := 0; vat_usd numeric := 0; vat_recoverable boolean := coalesce((rates->>'eu_vat_recoverable')::boolean, true);
  total numeric; unit numeric; client_price numeric; comm_pct numeric; comm_usd numeric; margin numeric; profit_unit numeric;
begin
  if terms not in ('exw', 'fob', 'cif', 'ddp_us', 'ddp_eu') then terms := 'ddp_us'; end if;
  goods_usd := price_cny * qty / fx;
  payfee := goods_usd * coalesce((inputs->>'payment_pct')::numeric, (rates->>'payment_fee_pct')::numeric, 0) / 100.0;
  if terms <> 'exw' then
    dom_usd := dom_cny / fx;
    export_usd := coalesce((rates->>'export_fees_cny')::numeric, 0) / fx;            -- customs declaration, port and document fees per shipment
    rebate_usd := price_cny * qty * (rebate_pct / 100.0) / 1.13 / fx;                 -- export VAT rebate on the ex-VAT value
  end if;
  fob_usd := goods_usd + dom_usd + export_usd - rebate_usd;
  if terms in ('cif', 'ddp_us', 'ddp_eu') then ins := (fob_usd + intl_usd) * coalesce((rates->>'insurance_pct')::numeric, 0) / 100.0; end if;

  if terms = 'ddp_us' then
    duty_pct := coalesce((rates->>'hts_duty_pct')::numeric,0) + coalesce((rates->>'section_301_pct')::numeric,0) + coalesce((rates->>'other_tariff_pct')::numeric,0);
    duty_usd := fob_usd * duty_pct / 100.0;
    mpf := least(greatest(fob_usd * coalesce((rates->>'mpf_pct')::numeric,0) / 100.0, coalesce((rates->>'mpf_min_usd')::numeric,0)), coalesce((rates->>'mpf_max_usd')::numeric, 1e9));
    hmf := case when mode = 'ocean' then fob_usd * coalesce((rates->>'hmf_pct')::numeric,0) / 100.0 else 0 end;
    broker := coalesce((rates->>'broker_fee_usd')::numeric, 0);
  elsif terms = 'ddp_eu' then
    cv := fob_usd + intl_usd + ins;                                                   -- EU customs value is CIF
    duty_pct := coalesce((rates->>'eu_duty_pct')::numeric,0) + coalesce((rates->>'eu_antidumping_pct')::numeric,0);
    duty_usd := cv * duty_pct / 100.0;
    vat_pct := coalesce((rates->>'eu_vat_pct')::numeric, 21);
    vat_usd := (cv + duty_usd) * vat_pct / 100.0;
    broker := coalesce((rates->>'eu_broker_fee_usd')::numeric, (rates->>'broker_fee_usd')::numeric, 0);
  end if;

  total := case terms
    when 'exw' then goods_usd + payfee
    when 'fob' then fob_usd + payfee
    when 'cif' then fob_usd + intl_usd + ins + payfee
    when 'ddp_us' then fob_usd + intl_usd + duty_usd + mpf + hmf + broker + ins + payfee
    else fob_usd + intl_usd + ins + duty_usd + broker + payfee + case when vat_recoverable then 0 else vat_usd end end;
  unit := total / qty;
  client_price := (inputs->>'client_unit_price')::numeric;
  comm_pct := coalesce((inputs->>'commission_pct')::numeric, (rates->>'commission_pct')::numeric, 0);
  comm_usd := case when client_price is not null then client_price * qty * comm_pct / 100.0 else goods_usd * comm_pct / 100.0 end;
  profit_unit := case when client_price is not null then client_price - unit - comm_usd / qty else null end;
  margin := case when client_price is not null and client_price > 0 then profit_unit / client_price * 100.0 else null end;
  return jsonb_build_object(
    'terms', terms, 'qty', qty, 'fx_cny_per_usd', fx,
    'goods_usd', round(goods_usd,2), 'domestic_freight_usd', round(dom_usd,2), 'export_fees_usd', round(export_usd,2), 'vat_rebate_usd', round(rebate_usd,2), 'fob_usd', round(fob_usd,2),
    'intl_freight_usd', round(case when terms in ('exw', 'fob') then 0 else intl_usd end,2), 'duty_pct_total', duty_pct, 'duty_usd', round(duty_usd,2),
    'mpf_usd', round(mpf,2), 'hmf_usd', round(hmf,2), 'broker_fee_usd', round(broker,2), 'insurance_usd', round(ins,2), 'payment_fee_usd', round(payfee,2),
    'customs_value_usd', round(cv,2), 'import_vat_pct', vat_pct, 'import_vat_usd', round(vat_usd,2), 'vat_recoverable', vat_recoverable,
    'landed_total_usd', round(total,2), 'landed_unit_usd', round(unit,4),
    'commission_pct', comm_pct, 'commission_usd', round(comm_usd,2),
    'client_unit_price', client_price, 'profit_unit_usd', round(profit_unit,4), 'margin_pct', round(margin,2)
  );
end $$;

-- rate cards: the US card keeps working as before; add a card for exporting from China and selling into Spain/EU
update public.cost_assumptions set rates = rates || '{"default_terms": "ddp_us"}'::jsonb where not (rates ? 'default_terms');
insert into public.cost_assumptions (workspace_id, name, effective_date, is_default, rates, notes)
select w.id, 'China export · Spain/EU (confirm rates)', current_date, false,
  '{"default_terms": "fob", "fx_cny_per_usd": 7.2, "apply_vat_rebate": true, "vat_rebate_pct": 13, "export_fees_cny": 600, "payment_fee_pct": 1, "insurance_pct": 0.3,
    "eu_duty_pct": 2.7, "eu_antidumping_pct": 0, "eu_vat_pct": 21, "eu_vat_recoverable": true, "eu_broker_fee_usd": 120, "commission_pct": 0,
    "hts_duty_pct": 0, "section_301_pct": 25, "other_tariff_pct": 0, "mpf_pct": 0.3464, "mpf_min_usd": 32.71, "mpf_max_usd": 634.62, "hmf_pct": 0.125, "broker_fee_usd": 150}'::jsonb,
  'Export rebate and EU duty depend on the HS code; check each product. Spain VAT 21% is recoverable for VAT-registered importers.'
from public.workspaces w
where not exists (select 1 from public.cost_assumptions c where c.workspace_id = w.id and c.name like 'China export%');
