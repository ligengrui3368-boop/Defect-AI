// Lathe sourcing agents. One function, several tasks (all with the caller's JWT, so
// row level security applies):
//   intake      – turn a client's brief into a structured spec, Chinese search terms, an HTS
//                 guess and follow-up questions; writes sourcing_requests.spec
//   search_1688 – run a 1688 search through a third-party scraper API (Apify) using the spec's
//                 Chinese search terms, keep only well-rated factories (quality filter: 1688 service
//                 score, product reviews, repeat-buyer rate, years on 1688, factory vs trader), save
//                 suppliers as factories and listings as candidates, then rank them with Claude
//   refresh_search – "show me different factories": runs a new search on search terms not used yet (or
//                 new ones Claude writes from the buyer's feedback), skips every supplier already shown
//                 for this request, and replaces the untouched candidates (contacted/released ones stay;
//                 replaced ones are kept as rejected and can be restored)
//   rank        – re-rank the existing candidates of a request against its spec
//   draft_rfq   – write a Chinese WeChat/email RFQ for a factory (with English translation)
//                 from the spec and the negotiation target
//   verify      – factory verification stub (registry / customs lookups): returns what is and
//                 isn't configured, so the UI can show it honestly
//   translate   – Chinese mode: translates text the dictionary doesn't cover (names, notes, AI-written
//                 specs) and caches it in translation_cache. Open to signed-in users and to clients
//                 with a valid portal link; nothing else.
//   registry_contacts – look factories up in the Chinese company registry (天眼查 Open API, ic/baseinfoV2):
//                 registered phone, email, website and address, plus business scope, registered capital
//                 and insured staff for the factory-vs-trader check. Only fills empty fields; results are
//                 kept on the factory so each company is paid for once (force: true re-checks).
//   operator    – the Home page assistant: reads the workspace's clients and open requests,
//                 answers questions, or returns one action for the page to carry out
//                 (create_request, create_client, open)
// Secrets (Supabase Edge Function Secrets, set by Gary only): ANTHROPIC_API_KEY, APIFY_TOKEN.
// Optional: APIFY_1688_ACTOR (default zen-studio~1688-wholesale-scraper, which returns the ratings the
// quality filter needs; schnellscrapers~1688-supplier-leads still works but cannot be filtered on ratings), SOURCING_MODEL.
// Registry: TIANYANCHA_TOKEN (天眼查 Open API token) enables registry_contacts and the verify lookup.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("SOURCING_MODEL") ?? "claude-sonnet-5-5";
const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") ?? "";
const APIFY_ACTOR = Deno.env.get("APIFY_1688_ACTOR") ?? "zen-studio~1688-wholesale-scraper";
const TYC_TOKEN = Deno.env.get("TIANYANCHA_TOKEN") ?? "";
const MAX_LISTINGS = Number(Deno.env.get("SOURCING_MAX_LISTINGS") ?? "40");
const TRANSLATE_MODEL = Deno.env.get("TRANSLATE_MODEL") ?? "claude-haiku-4-5-20251001";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
class HttpError extends Error { constructor(public status: number, m: string) { super(m); } }
// deno-lint-ignore no-explicit-any
type Any = any;

// ---------- Claude ----------
async function askJson(prompt: string, maxTokens = 3000, model = MODEL): Promise<Any> {
  if (!ANTHROPIC_API_KEY) throw new HttpError(500, "ANTHROPIC_API_KEY is not set in Edge Function Secrets.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt + "\n\nReply with only the JSON value, no other text." }] }),
  });
  if (!res.ok) throw new HttpError(502, `Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((c: Any) => c.type === "text").map((c: Any) => c.text).join("\n").trim();
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(clean); } catch { const m = clean.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]); throw new HttpError(502, "Claude did not return JSON"); }
}

async function askText(prompt: string, maxTokens = 3000, model = MODEL): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new HttpError(500, "ANTHROPIC_API_KEY is not set in Edge Function Secrets.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new HttpError(502, `Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.content ?? []).filter((c: Any) => c.type === "text").map((c: Any) => c.text).join("\n");
}

// ---------- helpers ----------
async function getRequest(sb: SupabaseClient, id: string) {
  const { data, error } = await sb.from("sourcing_requests").select("*, clients(name, company)").eq("id", id).single();
  if (error || !data) throw new HttpError(404, "Request not found (or not in your workspace)");
  return data;
}
const specText = (r: Any) => JSON.stringify({ title: r.title, brief: r.raw_brief, spec: r.spec, quantity: r.quantity, target_unit_price_usd: r.target_unit_price, deadline: r.deadline, destination: r.destination }, null, 1);

// ---------- tasks ----------
async function intake(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const extra = String(body.answers ?? "").trim();
  const out = await askJson(`You are the intake agent of a China sourcing service for US importers. Turn this client request into a structured product spec.
Request (JSON): ${specText(r)}
${extra ? `Client's answers to earlier questions: ${extra}` : ""}
Return a JSON object with exactly these keys:
 product_name (string), category (string), summary (1-2 sentences),
 materials (string[]), dimensions (string), weight (string), colors (string[]), features (string[]),
 packaging (string), certifications (string[] – e.g. FDA, UL, CPC, Prop 65; empty if none apply),
 must_haves (string[] – things that fail the order if wrong),
 defects_to_watch (string[] – visual defects a QC photo check should look for, 5-10 items),
 hts_guess (string – 6 to 10 digit US HTS code best guess, or ""), hts_note (string – why, and what to confirm),
 search_terms_zh (string[] – 4-8 Chinese 1688 search phrases a factory would use for this product, most specific first),
 search_terms_en (string[] – 3-5 English terms),
 industrial_clusters (string[] – Chinese cities/regions known for making this product),
 estimated_factory_price_cny (number or null – rough ex-works unit price range midpoint),
 questions (string[] – up to 5 follow-up questions for the client, only where an answer changes the spec or price; empty if the brief is complete),
 confidence ("high"|"medium"|"low").
Keep existing spec values unless the brief contradicts them.`);
  const spec = { ...(r.spec ?? {}), ...out, intake_at: new Date().toISOString() };
  const upd: Any = { spec };
  if (!r.hts_code && out.hts_guess) upd.hts_code = out.hts_guess;
  if (r.status === "intake" && (!out.questions || out.questions.length === 0)) upd.status = "sourcing";
  const { error } = await sb.from("sourcing_requests").update(upd).eq("id", r.id);
  if (error) throw new HttpError(500, error.message);
  return { ok: true, spec, status: upd.status ?? r.status };
}

// Pull a 1688 search from Apify. The default actor (schnellscrapers/1688-supplier-leads) goes through
// residential proxies, because 1688 blocks ordinary cloud traffic, and returns one row per supplier with
// factory signals and a few representative offers. Other actors return one row per product; both shapes
// are turned into the same listing format below, and rows without a product link (error notes) are dropped.
const SUPPLIER_ACTOR = APIFY_ACTOR.includes("supplier-leads");
const RATED_ACTOR = APIFY_ACTOR.includes("1688-wholesale-scraper");
async function apify1688(keyword: string | string[], limit: number, sort = "relevance"): Promise<Any[]> {
  if (!APIFY_TOKEN) throw new HttpError(500, "APIFY_TOKEN is not set in Edge Function Secrets. Add it (from apify.com → Settings → Integrations) to enable 1688 search.");
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&timeout=140&format=json&clean=true`;
  const kws = Array.isArray(keyword) ? keyword : [keyword];
  const input = RATED_ACTOR
    ? { keywords: kws, maxResults: limit, sortBy: sort, merchantType: "any" }
    : SUPPLIER_ACTOR
    ? { keywords: kws, maxSuppliersPerKeyword: limit, maxPagesPerKeyword: 1, maxOffersPerSupplier: 2, sortBy: "relevance", manufacturersOnly: false, proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] } }
    : { keyword: kws[0], searchKeywords: kws, keywords: kws, maxItems: limit, maxResults: limit, limit };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new HttpError(502, `Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const items = await res.json();
  return Array.isArray(items) ? items : (items?.items ?? []);
}
const pick = (o: Any, keys: string[]) => { for (const k of keys) { const v = k.split(".").reduce((a, p) => a?.[p], o); if (v !== undefined && v !== null && v !== "") return v; } return undefined; };
const num = (v: Any) => { if (v === undefined || v === null) return null; const n = parseFloat(String(v).replace(/[^0-9.]/g, "")); return isFinite(n) ? n : null; };
const FACTORY_WORDS = /factory|manufact|生产|工厂|加工/i;
function normalise(it: Any, keyword: string): Any[] {
  if (it && it.offerId && it.supplier && typeof it.supplier === "object" && !it.error) {
    const sp = it.supplier, st = sp.stats ?? {}, sc = sp.scores ?? {}, fl = sp.flags ?? {}, rv = it.reviewSummary ?? {};
    const isFactory = Boolean(fl.isFactory || fl.isSuperFactory || sp.isSuperFactory || sp.isFactoryInspected || /生产|工厂|制造|加工/.test(String(sp.bizType ?? "")) || /工厂/.test(String(st.factoryType ?? "")) || /factory/i.test(String(sp.sellerType ?? "")));
    const years = num(sp.tpYear) ?? (sp.foundedYear ? new Date().getFullYear() - Number(sp.foundedYear) : null);
    const q = {
      service_score: num(sc.composite), service_scores: Object.keys(sc).length ? sc : null,
      product_rating: num(rv.rating), product_reviews: num(rv.reviewCount), product_positive_rate: num(rv.positiveRate ?? rv.positiveReviewRate),
      positive_review_rate: num(st.positiveReviewRate), repeat_rate: num(st.repeatRate ?? it.repurchaseRate), fulfillment_rate: num(st.fulfillmentRate), response_rate: num(st.responseRate),
      years, is_factory: isFactory,
    };
    const signals = { supplier_id: sp.memberId ?? null, seller_type: sp.sellerType ?? null, biz_type: sp.bizType ?? null, factory_inspected: sp.isFactoryInspected ?? null, super_factory: sp.isSuperFactory ?? fl.isSuperFactory ?? null,
      service_scores: q.service_scores, positive_review_rate: q.positive_review_rate, repeat_rate: q.repeat_rate, fulfillment_rate: q.fulfillment_rate, response_rate: q.response_rate,
      employees: num(st.employees), factory_area_m2: num(st.factoryArea), factory_type: st.factoryType ?? null, founded_year: num(sp.foundedYear), im_url: sp.imUrl ?? null, rank: sp.rank?.text ?? null };
    return [{ title: String(it.title ?? "").slice(0, 300), url: String(it.detailUrl ?? `https://detail.1688.com/offer/${it.offerId}.html`), supplier: String(sp.companyName || sp.legalCompanyName || "Unknown supplier").slice(0, 200),
      shopUrl: String(it.winportUrl || sp.shopUrl || ""), city: [it.province, it.city].filter(Boolean).join(", ").slice(0, 100), price: num(it.price?.min ?? it.price), moq: num(it.minOrderQuantity), years,
      isFactory, sales: num(it.saledCount ?? it.orderCount), signals, quality: q, address: sp.address ?? null, keyword: it.sourceKeyword || keyword,
      raw: { offerId: it.offerId, title: it.title, url: it.detailUrl, priceCny: it.price?.min ?? null, minimumOrderQuantity: it.minOrderQuantity, orderCount: it.orderCount ?? null, saledCount: it.saledCount ?? null,
        rating: q.product_rating, reviewCount: q.product_reviews, positiveRate: q.product_positive_rate, serviceScore: q.service_score, repeatRate: q.repeat_rate, supplierPositiveRate: q.positive_review_rate, isFactory, years, supplier: sp.companyName, location: [it.province, it.city].filter(Boolean).join(" ") } }];
  }
  if (it && (it.supplierName || it.supplierId) && Array.isArray(it.representativeOffers)) {
    const claims = Boolean(it.isFactoryInspected || it.isSuperFactory || FACTORY_WORDS.test(String(it.factoryStatus ?? "")) || FACTORY_WORDS.test(String(it.businessRole ?? "")));
    const signals = { business_role: it.businessRole ?? null, factory_status: it.factoryStatus ?? null, factory_inspected: it.isFactoryInspected ?? null, business_inspected: it.isBusinessInspected ?? null, super_factory: it.isSuperFactory ?? null, platform_level: it.platformLevel ?? null, supplier_id: it.supplierId ?? null };
    return it.representativeOffers.map((o: Any) => ({
      title: String(o.title ?? "").slice(0, 300), url: String(o.url ?? ""), supplier: String(it.supplierName ?? "Unknown supplier").slice(0, 200), shopUrl: String(it.supplierUrl ?? ""),
      city: String(it.location ?? "").slice(0, 100), price: num(o.priceCny), moq: num(o.minimumOrderQuantity), years: num(it.yearsOnPlatform), isFactory: claims,
      sales: num(o.transactionCount ?? it.transactionCount), signals, keyword, raw: { ...o, supplier: it.supplierName, location: it.location, factoryStatus: it.factoryStatus, businessRole: it.businessRole },
    }));
  }
  const title = String(pick(it, ["title", "subject", "name", "productTitle", "offerTitle"]) ?? "").slice(0, 300);
  const url = String(pick(it, ["productUrl", "url", "detailUrl", "offerUrl", "link"]) ?? "");
  const supplier = String(pick(it, ["supplierName", "companyName", "company", "shopName", "seller.name", "supplier.name", "storeName"]) ?? "").slice(0, 200);
  const shopUrl = String(pick(it, ["shopUrl", "supplierUrl", "companyUrl", "storeUrl", "seller.url"]) ?? "");
  const city = String(pick(it, ["city", "location", "supplierLocation", "province", "seller.location"]) ?? "").slice(0, 100);
  const price = num(pick(it, ["price", "minPrice", "unitPrice", "priceMin", "wholesalePrice", "priceRange.min", "prices.0.price"]));
  const moq = num(pick(it, ["moq", "minOrderQuantity", "minOrder", "saleInfo.moq", "quantityBegin"]));
  const years = num(pick(it, ["years", "supplierYears", "tenure", "platformTenure", "seller.years"]));
  const isFactory = pick(it, ["isFactory", "factory", "isManufacturer", "manufacturer", "supplierType"]);
  const sales = num(pick(it, ["sales", "soldCount", "transactions", "saleQuantity", "bookedCount"]));
  return [{ title, url, supplier: supplier || (title ? title.slice(0, 60) : "Unknown supplier"), shopUrl, city, price, moq, years, isFactory: typeof isFactory === "boolean" ? isFactory : (typeof isFactory === "string" ? FACTORY_WORDS.test(isFactory) : null), sales, signals: {}, keyword, raw: it }];
}

// ---------- quality filter ----------
// Defaults keep well-rated factories only. A listing needs a 1688 service score at or above min_service,
// and good reviews: product rating >= min_rating (when it has 3+ reviews) or, for listings without enough
// product reviews, a supplier positive-review rate >= 95%. Missing repeat-rate or years data doesn't fail
// a listing; a missing service score or no reviews at all does (we can't call those "high rated").
const DEFAULT_FILTERS = { factory_only: true, min_service: 4.0, min_rating: 4.5, min_repeat: 0, min_years: 2 };
function qualityCheck(l: Any, f: Any): string | null {
  const q = l.quality;
  if (!q) return null; // scraper without ratings: nothing to filter on
  if (f.factory_only && !q.is_factory) return "trader";
  if (f.min_service > 0 && (q.service_score === null || q.service_score < f.min_service)) return "service";
  if (f.min_rating > 0) {
    const hasProduct = q.product_rating !== null && (q.product_reviews ?? 0) >= 3;
    const ok = hasProduct ? q.product_rating >= f.min_rating : (q.positive_review_rate !== null && q.positive_review_rate >= 0.95);
    if (!ok) return "reviews";
  }
  if (f.min_repeat > 0 && q.repeat_rate !== null && q.repeat_rate < f.min_repeat) return "repeat";
  if (f.min_years > 0 && q.years !== null && q.years < f.min_years) return "years";
  return null;
}
const DROP_LABEL: Record<string, string> = { already_seen: "factories already shown", trader: "traders, not factories", service: "low 1688 service score", reviews: "few or poor reviews", repeat: "low repeat-buyer rate", years: "too new on 1688" };

async function search1688(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const terms: string[] = (body.terms?.length ? body.terms : (r.spec?.search_terms_zh ?? [])).slice(0, 3);
  if (!terms.length) throw new HttpError(400, "No Chinese search terms yet. Run intake first or type a search term.");
  const filters = { ...DEFAULT_FILTERS, ...(body.filters ?? {}) };
  for (const k of ["min_service", "min_rating", "min_repeat", "min_years"]) filters[k] = Number(filters[k]) || 0;
  filters.factory_only = filters.factory_only !== false;
  const scanned: Any[] = [];
  const errors: string[] = [];
  if (RATED_ACTOR) {
    // one run for all terms; ask for more than we keep because the quality filter drops many
    const perTerm = Math.max(20, Math.floor(Number(Deno.env.get("SOURCING_SCAN_PER_TERM") ?? "40")));
    try { (await apify1688(terms, perTerm, body.sort === "bestSelling" ? "bestSelling" : "relevance")).forEach((it: Any) => normalise(it, terms[0]).forEach((l: Any) => { if (l.url && l.title) scanned.push(l); })); }
    catch (e) { errors.push((e as Error).message); }
  } else {
    const perTerm = Math.max(5, Math.floor((SUPPLIER_ACTOR ? 24 : MAX_LISTINGS) / terms.length));
    await Promise.all(terms.map(async (t) => {
      try { (await apify1688(t, perTerm)).forEach((it: Any) => normalise(it, t).forEach((l: Any) => { if (l.url && l.title) scanned.push(l); })); }
      catch (e) { errors.push(`${t}: ${(e as Error).message}`); }
    }));
  }
  if (!scanned.length) throw new HttpError(502, errors.join(" | ") || "1688 returned no products for these terms. The scraper may have been blocked; try again in a minute or use a shorter Chinese term.");
  const dropped: Record<string, number> = {};
  const listings = scanned.filter((l) => { const why = qualityCheck(l, filters); if (why) dropped[why] = (dropped[why] ?? 0) + 1; return !why; });
  // never bring back suppliers the buyer rejected for this request; on refresh, skip every supplier already shown
  const { data: prior } = await sb.from("request_candidates").select("status, factories(name, source_url)").eq("request_id", r.id);
  const seen = new Set<string>();
  for (const c of prior ?? []) if (c.factories && (body.exclude_existing || c.status === "rejected")) { if (c.factories.source_url) seen.add(String(c.factories.source_url).toLowerCase()); seen.add(String(c.factories.name).toLowerCase()); }
  const passed = listings.length;
  if (seen.size) for (let i = listings.length - 1; i >= 0; i--) { const l = listings[i]; if (seen.has((l.shopUrl || "").toLowerCase()) || seen.has(l.supplier.toLowerCase())) { listings.splice(i, 1); dropped.already_seen = (dropped.already_seen ?? 0) + 1; } }
  const filterSummary = { scanned: scanned.length, kept: listings.length, dropped, filters, rated: scanned.some((l) => l.quality) };
  if (!listings.length && passed) throw new HttpError(422, `Found ${passed} well-rated listings, but all are from factories already shown for this request. Try other feedback or a different search term.`);
  if (!listings.length) {
    const why = Object.entries(dropped).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${DROP_LABEL[k] ?? k}`).join(", ");
    throw new HttpError(422, `Scanned ${scanned.length} listings but none passed the quality filter (${why}). Loosen the filter or try another search term.`);
  }
  // one factory row per supplier (by shop url, else by name)
  const bySupplier = new Map<string, Any>();
  for (const l of listings) { const key = (l.shopUrl || l.supplier).toLowerCase(); if (!bySupplier.has(key)) bySupplier.set(key, l); }
  const { data: existing } = await sb.from("factories").select("id, name, source_url").eq("workspace_id", r.workspace_id);
  const factoryId = new Map<string, string>();
  (existing ?? []).forEach((f: Any) => { if (f.source_url) factoryId.set(f.source_url.toLowerCase(), f.id); factoryId.set(f.name.toLowerCase(), f.id); });
  const newFactories = [...bySupplier.values()].filter((l) => !factoryId.has((l.shopUrl || "").toLowerCase()) && !factoryId.has(l.supplier.toLowerCase())).map((l) => ({
    workspace_id: r.workspace_id, name: l.supplier, source: "1688", source_url: l.shopUrl || null, city: l.city || null, platform_years: l.years, address: l.address ?? null,
    is_verified_factory: null, verification: { listing_claims_factory: l.isFactory, sales: l.sales, ...l.signals }, categories: [r.spec?.category ?? r.title].filter(Boolean),
  }));
  // suppliers already saved: refresh their 1688 rating signals (keep everything else)
  if (RATED_ACTOR) for (const l of bySupplier.values()) {
    const fid = factoryId.get((l.shopUrl || "").toLowerCase()) ?? factoryId.get(l.supplier.toLowerCase());
    if (!fid) continue;
    const { data: cur } = await sb.from("factories").select("verification, address, platform_years").eq("id", fid).single();
    if (!cur) continue;
    await sb.from("factories").update({ verification: { ...(cur.verification ?? {}), listing_claims_factory: l.isFactory, sales: l.sales, ...l.signals }, address: cur.address ?? l.address ?? null, platform_years: l.years ?? cur.platform_years }).eq("id", fid);
  }
  if (newFactories.length) {
    const { data: ins, error } = await sb.from("factories").insert(newFactories).select("id, name, source_url");
    if (error) throw new HttpError(500, error.message);
    (ins ?? []).forEach((f: Any) => { if (f.source_url) factoryId.set(f.source_url.toLowerCase(), f.id); factoryId.set(f.name.toLowerCase(), f.id); });
  }
  // candidates (skip listing urls already saved for this request)
  const { data: have } = await sb.from("request_candidates").select("listing_url").eq("request_id", r.id);
  const haveUrl = new Set((have ?? []).map((c: Any) => c.listing_url));
  const rows = listings.filter((l) => l.url && !haveUrl.has(l.url)).map((l) => ({
    workspace_id: r.workspace_id, request_id: r.id, factory_id: factoryId.get((l.shopUrl || "").toLowerCase()) ?? factoryId.get(l.supplier.toLowerCase()) ?? null,
    listing_title: l.title, listing_url: l.url, listing_data: { ...l.raw, _keyword: l.keyword, _supplier: l.supplier, _city: l.city }, price_cny: l.price, moq: l.moq ? Math.round(l.moq) : null,
  }));
  if (rows.length) { const { error } = await sb.from("request_candidates").insert(rows); if (error) throw new HttpError(500, error.message); }
  if (r.status === "intake" || r.status === "sourcing") await sb.from("sourcing_requests").update({ status: "sourcing" }).eq("id", r.id);
  const used = [...new Set([...(r.spec?.used_terms ?? []), ...terms])].slice(-40);
  await sb.from("sourcing_requests").update({ spec: { ...(r.spec ?? {}), used_terms: used } }).eq("id", r.id);
  const ranked = body.skip_rank ? { ranked: 0 } : await rank(sb, { request_id: r.id });
  return { ok: true, searched: terms, listings: listings.length, new_candidates: rows.length, new_factories: newFactories.length, errors, filter: filterSummary, ...ranked };
}

async function refreshSearch(sb: SupabaseClient, body: Any) {
  let r = await getRequest(sb, body.request_id);
  const feedback = String(body.feedback ?? "").trim().slice(0, 1000);
  if (feedback) {
    const spec = { ...(r.spec ?? {}), feedback: [...(r.spec?.feedback ?? []), { at: new Date().toISOString(), text: feedback }].slice(-10) };
    await sb.from("sourcing_requests").update({ spec }).eq("id", r.id);
    r = { ...r, spec };
  }
  const used = new Set<string>(r.spec?.used_terms ?? []);
  const unused = (r.spec?.search_terms_zh ?? []).filter((t: string) => !used.has(t));
  let terms: string[] = [];
  let source = "next";
  if (feedback || unused.length === 0) {
    const out = await askJson(`You write 1688.com search phrases for a sourcing request. The buyer wants different factories than the ones already found.
Spec: ${specText(r)}
Search phrases already used: ${JSON.stringify([...used])}
${feedback ? `The buyer's feedback on the factories found so far: ${feedback}` : ""}
Return a JSON array of 2 new Simplified Chinese 1688 search phrases (2-6 words each) a factory would use for this product. They must differ from the used phrases${feedback ? " and steer toward what the buyer wants" : ", e.g. a different material, style, synonym or the factory term 厂家/工厂"}.`, 400);
    terms = (Array.isArray(out) ? out : []).map((t: Any) => String(t).trim()).filter((t: string) => t && !used.has(t)).slice(0, 2);
    source = "ai";
  }
  if (!terms.length) terms = unused.slice(0, 2);
  if (!terms.length) { terms = (r.spec?.search_terms_zh ?? []).slice(0, 2); source = "resort"; }
  if (!terms.length) throw new HttpError(400, "No search terms yet. Run intake first.");
  // untouched candidates get replaced; contacted, released or negotiating ones stay
  const { data: old } = await sb.from("request_candidates").select("id").eq("request_id", r.id).eq("status", "candidate").eq("released_to_client", false);
  const out = await search1688(sb, { request_id: r.id, terms, filters: body.filters, exclude_existing: true, sort: source === "resort" ? "bestSelling" : "relevance", skip_rank: true });
  const ids = (old ?? []).map((x: Any) => x.id);
  if (ids.length) await sb.from("request_candidates").update({ status: "rejected", rank: null, notes: "Replaced by refresh" }).in("id", ids);
  const ranked = await rank(sb, { request_id: r.id });
  return { ...out, ...ranked, terms, term_source: source, replaced: ids.length };
}

async function rank(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const { data: cands } = await sb.from("request_candidates").select("id, listing_title, listing_url, price_cny, moq, listing_data, factories(name, city, platform_years, verification, is_verified_factory)").eq("request_id", r.id).neq("status", "rejected").limit(80);
  if (!cands?.length) return { ranked: 0 };
  const compact = cands.map((c: Any, i: number) => ({ i, title: c.listing_title, price_cny: c.price_cny, moq: c.moq, supplier: c.factories?.name, city: c.factories?.city, years: c.factories?.platform_years, claims_factory: c.factories?.verification?.listing_claims_factory, sales: c.factories?.verification?.sales, service_score: c.listing_data?.serviceScore ?? c.factories?.verification?.service_scores?.composite ?? null, product_rating: c.listing_data?.rating ?? null, reviews: c.listing_data?.reviewCount ?? null, supplier_positive_rate: c.listing_data?.supplierPositiveRate ?? c.factories?.verification?.positive_review_rate ?? null, repeat_rate: c.listing_data?.repeatRate ?? c.factories?.verification?.repeat_rate ?? null }));
  const out = await askJson(`You rank 1688 listings for a sourcing request. Score each listing 0-100 on how well it fits the spec (product match, materials/features, MOQ vs quantity, price vs target, supplier looks like a real factory in a relevant industrial cluster, tenure, sales, and supplier quality: 1688 service score out of 5, product rating and review count, positive-review and repeat-buyer rates; prefer well-rated factories). If the spec has buyer feedback (spec.feedback), score down listings that match what the buyer disliked.
Spec: ${specText(r)}
Listings (JSON): ${JSON.stringify(compact)}
Return a JSON array of {i, score, reason} with a one-sentence reason each (English). Include every i.`);
  const scores = new Map<number, Any>((Array.isArray(out) ? out : []).map((o: Any) => [Number(o.i), o]));
  const order = cands.map((c: Any, i: number) => ({ c, s: scores.get(i)?.score ?? 0, why: scores.get(i)?.reason ?? "" })).sort((a, b) => b.s - a.s);
  for (let k = 0; k < order.length; k++) {
    await sb.from("request_candidates").update({ rank: k + 1, match_score: order[k].s, notes: order[k].why }).eq("id", order[k].c.id);
  }
  if (r.status === "sourcing" && order.length) await sb.from("sourcing_requests").update({ status: "shortlisted" }).eq("id", r.id);
  return { ranked: order.length, top: order.slice(0, 5).map((o) => ({ id: o.c.id, title: o.c.listing_title, score: o.s, why: o.why })) };
}

async function draftRfq(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  let factory: Any = null;
  if (body.factory_id) { const { data } = await sb.from("factories").select("*").eq("id", body.factory_id).single(); factory = data; }
  const target = body.target_cny ?? r.spec?.estimated_factory_price_cny ?? null;
  const out = await askJson(`Write a first-contact RFQ message to a Chinese factory on 1688 / WeChat, from a buyer's sourcing agent (the agent is Chinese-speaking; the end client is a US brand, don't name the client).
Spec: ${specText(r)}
Factory: ${factory ? JSON.stringify({ name: factory.name, city: factory.city }) : "unknown"}
${target ? `Our target ex-works unit price: about ${target} CNY (do not state it; ask for their best tiered price instead).` : ""}
Rules: natural professional Simplified Chinese as a real 采购 would write; ask for 阶梯报价 (quantity tiers), MOQ, 交期, 打样费用与周期, 是否源头工厂 (ask directly), 材质/认证 confirmation, 包装 options, 付款方式 (propose 30% deposit, 70% after passing our pre-shipment photo inspection). Mention we inspect randomly sampled units by photo before the balance payment. Keep it under 220 Chinese characters plus a short spec list.
Return JSON: { subject_zh, message_zh, spec_list_zh (string, bullet lines), message_en (faithful English translation), negotiation_tips (string[] – 3 to 5 tips for the negotiator for this product/factory type) }.`);
  return { ok: true, ...out };
}

async function verify(sb: SupabaseClient, body: Any) {
  const { data: f } = await sb.from("factories").select("*").eq("id", body.factory_id).single();
  if (!f) throw new HttpError(404, "Factory not found");
  const configured = { registry_api: Boolean(TYC_TOKEN), customs_api: Boolean(Deno.env.get("IMPORT_DATA_KEY")) };
  let reg: Any = f.verification?.registry ?? null;
  if (configured.registry_api && (!reg?.checked_at || body.force)) { await registryContacts(sb, { factory_ids: [f.id], force: true }); reg = (await sb.from("factories").select("verification").eq("id", f.id).single()).data?.verification?.registry ?? null; }
  const regDone = Boolean(reg?.checked_at);
  const checks = [
    regDone ? { name: "Business registry (天眼查)", status: "done", result: reg?.matched ? { name: reg.name, status: reg.status, established: reg.established, legal_person: reg.legal_person, scope_mentions_manufacturing: reg.scope_mentions_manufacturing, staff_range: reg.staff_range } : { matched: false, keyword: reg?.keyword } }
    : { name: "Business registry (企查查/天眼查)", status: configured.registry_api ? "failed" : "manual", how: `Search "${f.name_zh || f.name}" on qcc.com or tianyancha.com: confirm 经营范围 includes manufacturing (生产/制造), note 注册资本 and 参保人数 (under ~10 insured staff usually means a trader).` },
    { name: "US customs shipments", status: configured.customs_api ? "pending" : "manual", how: `Search the company name on importyeti.com to see if it already ships this product type to US buyers.` },
    { name: "1688 listing signals", status: "done", result: { claims_factory: f.verification?.listing_claims_factory ?? null, platform_years: f.platform_years, sales: f.verification?.sales ?? null, city: f.city } },
  ];
  return { ok: true, configured, checks, note: configured.registry_api || configured.customs_api ? (regDone ? "Registry details saved on this factory: business scope, registered capital and insured staff are filled in below." : "Registry lookup didn't complete; try again.") : "Automatic registry and customs lookups are not configured yet; the steps above are manual for now. Record the result on the factory with the 'Verified factory' switch." };
}

// ---------- company registry (天眼查 Open API) ----------
// One call per company (ic/baseinfoV2: base info with contact details). The 1688 supplier name is normally
// the company's registered name, so it is the search keyword unless a Chinese name has been set.
const MOBILE = /^(?:\+?86)?1[3-9]\d{9}$/;
const listOf = (v: Any) => String(v ?? "").split(/[;；,，、\/\n]+/).map((x) => x.trim()).filter((x) => x && !/^(-|暂无|无)$/.test(x));
async function tycLookup(keyword: string): Promise<Any> {
  const res = await fetch(`https://open.api.tianyancha.com/services/open/ic/baseinfoV2/2.0?keyword=${encodeURIComponent(keyword)}`, { headers: { Authorization: TYC_TOKEN } });
  if (!res.ok) throw new Error(`天眼查 HTTP ${res.status}`);
  const j = await res.json();
  if (j.error_code === 300000) return null; // no matching company
  if (j.error_code !== 0) throw new Error(`天眼查 ${j.error_code}: ${j.reason ?? "error"}`);
  return j.result ?? null;
}
async function registryContacts(sb: SupabaseClient, body: Any) {
  if (!TYC_TOKEN) throw new HttpError(500, "Registry lookups aren't set up yet: add TIANYANCHA_TOKEN (from open.tianyancha.com) in Supabase Edge Function Secrets.");
  let q = sb.from("factories").select("*");
  if (Array.isArray(body.factory_ids) && body.factory_ids.length) q = q.in("id", body.factory_ids.slice(0, 40));
  else if (body.request_id) {
    const { data: c } = await sb.from("request_candidates").select("factory_id").eq("request_id", body.request_id).neq("status", "rejected").not("factory_id", "is", null);
    const ids = [...new Set((c ?? []).map((x: Any) => x.factory_id))];
    if (!ids.length) return { ok: true, checked: 0, skipped: 0, found: 0, not_found: 0, failed: 0 };
    q = q.in("id", ids.slice(0, 40));
  } else throw new HttpError(400, "Pass factory_ids or request_id");
  const { data: facs, error } = await q;
  if (error) throw new HttpError(500, error.message);
  const todo = (facs ?? []).filter((f: Any) => body.force || !f.verification?.registry?.checked_at);
  let found = 0, notFound = 0, failed = 0;
  const now = new Date().toISOString();
  const one = async (f: Any) => {
    const keyword = String(f.name_zh || f.name || "").trim();
    const v = { ...(f.verification ?? {}) };
    let r: Any = null;
    try { r = await tycLookup(keyword); } catch (e) {
      failed++;
      v.registry = { source: "tianyancha", error: (e as Error).message, tried_at: now };
      await sb.from("factories").update({ contact_status: f.mobile || f.phone || f.email ? f.contact_status : "error", verification: v }).eq("id", f.id);
      return;
    }
    if (!r) {
      notFound++;
      v.registry = { source: "tianyancha", checked_at: now, matched: false, keyword };
      await sb.from("factories").update({ contact_status: f.mobile || f.phone || f.email ? f.contact_status : "none", contact_fetched_at: now, verification: v }).eq("id", f.id);
      return;
    }
    const phones = listOf(r.phoneNumber);
    const norm = (p: string) => p.replace(/[\s-]/g, "");
    const mobile = phones.map(norm).find((p) => MOBILE.test(p))?.replace(/^\+?86/, "") ?? null;
    const phone = phones.find((p) => !MOBILE.test(norm(p)) && p.replace(/\D/g, "").length >= 7) ?? null;
    const email = listOf(r.email).find((e) => /@/.test(e)) ?? null;
    const website = listOf(r.websiteList)[0] ?? null;
    const got: Any = { mobile, phone, email, website, address: r.regLocation || null };
    const patch: Any = { contact_fetched_at: now };
    for (const k of Object.keys(got)) if (got[k] && !f[k]) patch[k] = got[k];
    if (!f.name_zh && r.name) patch.name_zh = r.name;
    if (!f.province && r.base) patch.province = r.base;
    v.registry = { source: "tianyancha", checked_at: now, matched: true, keyword, name: r.name ?? null, credit_code: r.creditCode ?? null, status: r.regStatus ?? null,
      established: r.estiblishTime ? new Date(Number(r.estiblishTime)).toISOString().slice(0, 10) : null, legal_person: r.legalPersonName ?? null, org_type: r.companyOrgType ?? null,
      industry: r.industry ?? null, staff_range: r.staffNumRange ?? null, phones, emails: listOf(r.email), websites: listOf(r.websiteList),
      scope_mentions_manufacturing: /生产|制造|加工/.test(String(r.businessScope ?? "")) };
    if (!v.business_scope && r.businessScope) v.business_scope = String(r.businessScope).slice(0, 2000);
    if (!v.registered_capital && r.regCapital) v.registered_capital = r.regCapital;
    if ((v.insured_staff === undefined || v.insured_staff === null) && r.socialStaffNum !== undefined && r.socialStaffNum !== null && r.socialStaffNum !== "" && !isNaN(Number(r.socialStaffNum))) v.insured_staff = Number(r.socialStaffNum);
    patch.verification = v;
    const has = Boolean(f.mobile || f.phone || f.email || mobile || phone || email);
    patch.contact_status = has ? "ok" : "none";
    await sb.from("factories").update(patch).eq("id", f.id);
    if (has) found++; else notFound++;
  };
  for (let i = 0; i < todo.length; i += 5) await Promise.all(todo.slice(i, i + 5).map(one));
  return { ok: true, checked: todo.length, skipped: (facs ?? []).length - todo.length, found, not_found: notFound, failed };
}

async function operator(sb: SupabaseClient, body: Any) {
  const message = String(body.message ?? "").trim().slice(0, 4000);
  if (!message) throw new HttpError(400, "Empty message");
  const history = (Array.isArray(body.history) ? body.history : []).slice(-8).map((h: Any) => `${h.role === "operator" ? "Operator" : "User"}: ${String(h.text ?? "").slice(0, 800)}`).join("\n");
  const { data: clients } = await sb.from("clients").select("id, name, company").limit(100);
  const { data: reqs } = await sb.from("sourcing_requests").select("id, title, status, quantity, target_unit_price, deadline, client_id, spec").neq("status", "closed").order("updated_at", { ascending: false }).limit(30);
  const { data: negs } = await sb.from("negotiations").select("request_id, status, current_offer_cny, agreed_cny").limit(200);
  const today = new Date().toISOString().slice(0, 10);
  const open = (reqs ?? []).map((r: Any) => ({ id: r.id, title: r.title, status: r.status, quantity: r.quantity, target_usd: r.target_unit_price, deadline: r.deadline, client: (clients ?? []).find((c: Any) => c.id === r.client_id)?.company ?? null, open_questions: r.spec?.questions?.length ?? 0, negotiations: (negs ?? []).filter((n: Any) => n.request_id === r.id).map((n: Any) => n.status) }));
  const out = await askJson(`You are Operator, the assistant inside Lathe. Gary runs it: US brands tell him what they want made, he sources it from Chinese factories (1688), negotiates himself, quotes the full landed cost, and checks quality before the balance is paid.
Today is ${today}.
Clients: ${JSON.stringify((clients ?? []).map((c: Any) => ({ name: c.name, company: c.company })))}
Open requests: ${JSON.stringify(open)}
Conversation so far:
${history || "(none)"}
User: ${message}

Decide what to do and return a JSON object:
{ "reply": string, "action": null | {...} }
Possible actions:
- { "type": "create_request", "title": short product name with key spec (under 70 chars), "brief": everything the user said about the product (specs, materials, packaging, branding, price, timing), "quantity": number|null, "target_unit_price": number|null (USD per unit), "deadline": "YYYY-MM-DD"|null (resolve relative dates from today), "client_name": existing client name or company if one was named or clearly implied, else the new name the user gave, else null }
- { "type": "create_client", "name": string, "company": string|null, "email": string|null }
- { "type": "open", "href": one of "sourcing.html#/requests", "sourcing.html#/request/<id>", "sourcing.html#/clients", "sourcing.html#/factories", "sourcing.html#/rates", "ops.html#/orders", "app.html" }
Rules: only create a request when the user asks to source, make, buy or quote a physical product. When you create one, the reply is one short sentence saying you're creating it and running intake. Answer status questions from the open requests list only, briefly and specifically (name the requests and what each needs next). Never invent prices, factories or facts that are not in the data. Plain sentences, no markdown except links written as [title](sourcing.html#/request/<id>).${body.lang === "zh" ? " Write the reply in Simplified Chinese (keep product names, numbers and links as they are)." : ""}`, 1500);
  const a = out?.action && typeof out.action === "object" ? out.action : null;
  const allowed = ["create_request", "create_client", "open"];
  return { ok: true, reply: String(out?.reply ?? "").slice(0, 3000), action: a && allowed.includes(a.type) ? a : null };
}

async function translate(body: Any, auth: string) {
  const texts = [...new Set((Array.isArray(body.texts) ? body.texts : []).map((t: Any) => String(t ?? "").trim()).filter((t: string) => t && t.length <= 600))].slice(0, 60) as string[];
  if (!texts.length) return { ok: true, zh: {} };
  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, SERVICE_KEY, { auth: { persistSession: false } });
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  let allowed = false;
  try { const { data } = await asUser.auth.getUser(); allowed = !!data?.user; } catch { allowed = false; }
  if (!allowed && body.portal_token) {
    const { data } = await admin.from("clients").select("id").eq("portal_token", String(body.portal_token)).eq("portal_active", true).maybeSingle();
    allowed = !!data;
  }
  if (!allowed) throw new HttpError(401, "Sign in first");
  const hash = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const keys = await Promise.all(texts.map(hash));
  const { data: hits } = await admin.from("translation_cache").select("src_hash, zh").in("src_hash", keys);
  const known = new Map((hits ?? []).map((r: Any) => [r.src_hash, r.zh]));
  const zh: Record<string, string> = {};
  const miss: number[] = [];
  texts.forEach((t, i) => { const z = known.get(keys[i]); if (z) zh[t] = z as string; else miss.push(i); });
  if (miss.length) {
    const src = miss.map((i) => texts[i]);
    // Numbered lines rather than JSON: quotation marks inside a translation can't break the format.
    const numbered = src.map((t, k) => `${k + 1}| ${t.replace(/\s+/g, " ")}`).join("\n");
    const raw = await askText(`Translate each numbered item below into natural Simplified Chinese for a sourcing and quality-control app used by Chinese and American business people. Items are interface text, names, notes, product specs and short explanations. Keep brand and company names (Lathe, SUNNYPRO, Amazon, Apify, 1688), model numbers and codes (HTS, MOQ, FOB, MPF, HMF, QC, AQL, VAT, 600D), numbers, currency amounts, units and URLs exactly as written. Translate everything else. Be concise; no notes or explanations.
Reply with exactly ${src.length} lines and nothing else. Each line is the item number, a vertical bar, a space, then the translation on one line, for example "3| 翻译".

${numbered}`, 8000, TRANSLATE_MODEL);
    const byNum = new Map<number, string>();
    for (const line of raw.split("\n")) { const m = line.match(/^\s*(\d+)\s*\|\s?(.*)$/); if (m && m[2].trim()) byNum.set(Number(m[1]), m[2].trim()); }
    const rows: Any[] = [];
    miss.forEach((i, k) => { const z = byNum.get(k + 1) ?? ""; if (z) { zh[texts[i]] = z; rows.push({ src_hash: keys[i], src: texts[i], zh: z }); } });
    if (rows.length) await admin.from("translation_cache").upsert(rows);
  }
  return { ok: true, zh };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Any; try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const auth = req.headers.get("Authorization") ?? "";
  if (String(body.task ?? "") === "translate") {
    try { return json(await translate(body, auth)); } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500); }
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: "Sign in first" }, 401);
  try {
    switch (String(body.task ?? "")) {
      case "intake": return json(await intake(sb, body));
      case "search_1688": return json(await search1688(sb, body));
      case "rank": return json(await rank(sb, body));
      case "refresh_search": return json(await refreshSearch(sb, body));
      case "draft_rfq": return json(await draftRfq(sb, body));
      case "verify": return json(await verify(sb, body));
      case "operator": return json(await operator(sb, body));
      case "registry_contacts": return json(await registryContacts(sb, body));
      case "status": return json({ ok: true, anthropic: Boolean(ANTHROPIC_API_KEY), apify: Boolean(APIFY_TOKEN), registry: Boolean(TYC_TOKEN), actor: APIFY_ACTOR, model: MODEL });
      default: return json({ error: "Unknown task" }, 400);
    }
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500); }
});
