// Lathe sourcing agents. One function, several tasks (all with the caller's JWT, so
// row level security applies):
//   intake      – turn a client's brief into a structured spec, Chinese search terms, an HTS
//                 guess and follow-up questions; writes sourcing_requests.spec
//   search_1688 – run a 1688 search through a third-party scraper API (Apify) using the spec's
//                 Chinese search terms, keep only well-rated factories (quality filter: 1688 service
//                 score, product reviews, repeat-buyer rate, years on 1688, factory vs trader), save
//                 suppliers as factories and listings as candidates, then rank them with Claude
//   search_photo – 以图搜图: search 1688 with the buyer's product photos (uploaded to the photos bucket),
//                 then the same quality filter, de-duplication and ranking as search_1688
//   refresh_search – "show me different factories": runs a new search on search terms not used yet (or
//                 new ones Claude writes from the buyer's feedback), skips every supplier already shown
//                 for this request, and replaces the untouched candidates (contacted/released ones stay;
//                 replaced ones are kept as rejected and can be restored)
//   spec_glance – write the short "at a glance" facts (5-6 label/value pairs) for a spec that has none
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
//   portal_answers – (client portal, no sign-in; checked against the portal link's token) save the client's
//                 answers to the intake questions and re-run intake on that request
//   parse_reply – read a factory's reply (pasted text or a screenshot): price, MOQ, lead time, terms; update the
//                 negotiation and draft the counter-offer in Chinese
//   start_job   – run search_1688 / search_photo / refresh_search in the background (jobs table, live updates)
//   operator_suggest – fresh suggested prompts for the Operator panel, from current work and memory
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
// Every AI step goes through here. Replies that are cut off are retried with more room, and replies that aren't
// valid JSON (a stray quote or comma) get one repair pass, so a single bad reply doesn't fail the whole step.
async function callClaude(content: Any[], maxTokens: number, model: string): Promise<{ text: string; stop: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new HttpError(502, `Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return { text: (data.content ?? []).filter((c: Any) => c.type === "text").map((c: Any) => c.text).join("\n").trim(), stop: String(data.stop_reason ?? "") };
}
function tryJson(text: string): Any {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(clean); } catch { /* try the outermost JSON block */ }
  const m = clean.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return undefined;
}
async function askJson(prompt: string, maxTokens = 3000, model = MODEL, images: string[] = []): Promise<Any> {
  if (!ANTHROPIC_API_KEY) throw new HttpError(500, "ANTHROPIC_API_KEY is not set in Edge Function Secrets.");
  const content = [...images.map((url) => ({ type: "image", source: { type: "url", url } })), { type: "text", text: prompt + "\n\nReply with only the JSON value, no other text." }];
  let { text, stop } = await callClaude(content, maxTokens, model);
  if (stop === "max_tokens") ({ text } = await callClaude(content, Math.min(maxTokens * 2, 8000), model));
  const first = tryJson(text);
  if (first !== undefined) return first;
  const fix = await callClaude([{ type: "text", text: "The text below was meant to be a single valid JSON value but has a syntax error (for example an unescaped quote or a missing comma). Return exactly the same content as valid JSON. Output only the JSON.\n\n" + text }], Math.min(maxTokens * 2, 8000), MODEL);
  const second = tryJson(fix.text);
  if (second !== undefined) return second;
  throw new HttpError(502, "Claude did not return valid JSON");
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
const specText = (r: Any) => JSON.stringify({ title: r.title, brief: r.raw_brief, spec: r.spec ? (({ photos: _p, ...rest }: Any) => rest)(r.spec) : null, quantity: r.quantity, target_unit_price_usd: r.target_unit_price, deadline: r.deadline, destination: r.destination }, null, 1);

// ---------- tasks ----------
async function intake(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const extra = String(body.answers ?? "").trim();
  // product photos on the request are shown to Claude too (signed links, row level security applies)
  let images: string[] = [];
  const photos: string[] = (r.spec?.photos ?? []).slice(-4);
  if (photos.length) { const { data } = await sb.storage.from("photos").createSignedUrls(photos, 600); images = (data ?? []).map((x: Any) => x.signedUrl).filter(Boolean); }
  const out = await askJson(`You are the intake agent of a China sourcing service for US importers. Turn this client request into a structured product spec.
Request (JSON): ${specText(r)}
${images.length ? `${images.length} product photo(s) are attached. Read the product type, construction, materials, colors, features and any visible text or logos from them. Where the written spec and the photos disagree, the written spec wins; mention the conflict in questions.` : ""}
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
 at_a_glance ({label, value}[] – the 5-6 facts a buyer checks first, e.g. frame, fabric, size, weight, load rating, colors; label 1-2 words, value at most 4 words with units, no parentheses, no "to be confirmed"),
 request_title (string – short title for this request, e.g. "Foldable camping chairs, 1,000 pcs"),
 confidence ("high"|"medium"|"low").
Keep existing spec values unless the brief contradicts them.`, 3000, MODEL, images);
  const spec = { ...(r.spec ?? {}), ...out, intake_at: new Date().toISOString() };
  const upd: Any = { spec };
  if (!r.hts_code && out.hts_guess) upd.hts_code = out.hts_guess;
  if ((body.set_title || !r.title || r.title === "Untitled request") && out.request_title) upd.title = String(out.request_title).slice(0, 120);
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
const IMAGE_ACTOR = Deno.env.get("APIFY_IMAGE_ACTOR") ?? "devcake~scraper-by-image";
async function apifyImage(imageUrls: string[], perImage: number): Promise<Any[]> {
  if (!APIFY_TOKEN) throw new HttpError(500, "APIFY_TOKEN is not set in Edge Function Secrets.");
  const url = `https://api.apify.com/v2/acts/${IMAGE_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&timeout=140&format=json&clean=true`;
  const input = { provider: "1688", imageUrls, maxProducts: perImage, maxConcurrency: 2, maxRetries: 2 };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new HttpError(502, `Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
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
  if (it && it.provider === "1688" && it.product_id && !it.error) {
    const tags: string[] = Array.isArray(it.tags) ? it.tags.map(String) : [];
    const isFactory = Boolean(it.factory_inspected || tags.some((t) => /源头工厂|超级工厂|生产加工|实力工厂|工厂/.test(t)));
    const svc = num(it.service_score ?? it.rating);
    const reviews = num(it.review_count);
    const q = { service_score: svc, service_scores: svc !== null ? { composite: svc, consultation: num(it.consultation_score), logistics: num(it.logistics_score), return: num(it.return_score) } : null,
      product_rating: null, product_reviews: reviews, product_positive_rate: null, positive_review_rate: null, repeat_rate: null, fulfillment_rate: null, response_rate: null,
      years: num(it.years_as_member), is_factory: isFactory, reviews_unavailable: true, high_repurchase: tags.includes("高回购率") };
    const shop = String(it.shop_url || "").split("?")[0].replace(/\/+$/, "");
    const url = `https://detail.1688.com/offer/${it.product_id}.html`;
    return [{ title: String(it.title ?? "").slice(0, 300), url, supplier: String(it.shop_name || "Unknown supplier").slice(0, 200), shopUrl: shop, city: tags.slice(0, 2).filter((t) => /省|市|区|县|^[\u4e00-\u9fa5]{2,3}$/.test(t) && !/工厂|加工|验厂|发货|回购/.test(t)).join(", "),
      price: num(it.price_min), moq: num(it.moq), years: q.years, isFactory, sales: num(it.sold_90d ?? it.sold_count), quality: q, address: null, keyword,
      signals: { factory_inspected: it.factory_inspected ?? null, service_scores: q.service_scores, high_repurchase: q.high_repurchase, tags: tags.slice(0, 12), credit_url: it.member_credit_url ?? null },
      raw: { offerId: it.product_id, title: it.title, url, priceCny: num(it.price_min), minimumOrderQuantity: num(it.moq), saledCount: num(it.sold_count), sold90d: num(it.sold_90d), serviceScore: svc, reviewCount: reviews,
        isFactory, years: q.years, highRepurchase: q.high_repurchase, imageRank: num(it.image_rank), imageUrl: it.image_url ?? null, supplier: it.shop_name, fromPhoto: true } }];
  }
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
      raw: { offerId: it.offerId, title: it.title, url: it.detailUrl, imageUrl: pick(it, ["imageUrl", "image", "mainImage", "mainImageUrl", "imgUrl", "picUrl", "images.0", "imageUrls.0"]) ?? null, priceCny: it.price?.min ?? null, minimumOrderQuantity: it.minOrderQuantity, orderCount: it.orderCount ?? null, saledCount: it.saledCount ?? null,
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
  if (f.min_rating > 0 && !q.reviews_unavailable) {
    const hasProduct = q.product_rating !== null && (q.product_reviews ?? 0) >= 3;
    const ok = hasProduct ? q.product_rating >= f.min_rating : (q.positive_review_rate !== null && q.positive_review_rate >= 0.95);
    if (!ok) return "reviews";
  }
  if (f.min_repeat > 0 && q.repeat_rate !== null && q.repeat_rate < f.min_repeat) return "repeat";
  if (f.min_years > 0 && q.years !== null && q.years < f.min_years) return "years";
  return null;
}
const DROP_LABEL: Record<string, string> = { already_seen: "factories already shown", trader: "traders, not factories", service: "low 1688 service score", reviews: "few or poor reviews", repeat: "low repeat-buyer rate", years: "too new on 1688", design: "a different design from your photos", no_photo: "no product photo to compare" };

// ---------- design check: compare each listing's photo with the buyer's reference photos ----------
// 1688 (text or image search) returns "similar" products; this keeps only the ones whose design actually
// matches what the buyer wants, scored by Claude looking at both pictures.
const b64 = (buf: ArrayBuffer) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
async function imageBlock(url: string): Promise<Any | null> {
  let u = String(url || ""); if (!u) return null; if (u.startsWith("//")) u = "https:" + u;
  const tries = /alicdn\.com/.test(u) && /\.(jpe?g|png|webp)$/i.test(u) ? [u + "_400x400.jpg", u] : [u];
  for (const t of tries) {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12000);
      const res = await fetch(t, { signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0" } }); clearTimeout(timer);
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) continue;
      const buf = await res.arrayBuffer(); if (buf.byteLength < 500 || buf.byteLength > 4_500_000) continue;
      return { type: "image", source: { type: "base64", media_type: type, data: b64(buf) } };
    } catch { /* try the next form of the url */ }
  }
  return null;
}
async function designCheck(sb: SupabaseClient, r: Any, listings: Any[]): Promise<{ checked: boolean; refs: number }> {
  const paths: string[] = (r.spec?.photos ?? []).slice(-2);
  if (!paths.length || !listings.length) return { checked: false, refs: 0 };
  const { data: signed } = await sb.storage.from("photos").createSignedUrls(paths, 600);
  const refs = (await Promise.all((signed ?? []).map((x: Any) => x.signedUrl ? imageBlock(x.signedUrl) : null))).filter(Boolean);
  if (!refs.length) return { checked: false, refs: 0 };
  const imgs = await Promise.all(listings.map((l) => l.raw?.imageUrl ? imageBlock(l.raw.imageUrl) : Promise.resolve(null)));
  const idx = listings.map((_, i) => i).filter((i) => imgs[i]);
  const product = r.spec?.product_name || r.title;
  const batches: number[][] = []; for (let i = 0; i < idx.length; i += 8) batches.push(idx.slice(i, i + 8));
  const run = async (batch: number[]) => {
    const content: Any[] = [{ type: "text", text: `REFERENCE: the exact design the buyer wants (${product}).` }, ...refs];
    batch.forEach((i, n) => { content.push({ type: "text", text: `Candidate ${n + 1}` }); content.push(imgs[i]); });
    content.push({ type: "text", text: `For each candidate, score 0-100 how closely its PRODUCT DESIGN matches the REFERENCE: same kind of product, same overall shape and structure, same mechanism and construction (how it holds or works, folding style, number of arms, hooks or slots, base type), same key features. Ignore colour, background, watermarks, text overlays, camera angle and lighting. 90-100 same design (colour may differ); 70-89 very similar, small differences; 40-69 same kind of product but a different design; under 40 a different product. Return only a JSON array: [{"n": number, "score": number, "note": "max 12 words: the key difference, or 'same design'"}].` });
    try {
      let { text } = await callClaude(content, 1200, MODEL);
      let arr = tryJson(text);
      if (!Array.isArray(arr)) { const fix = await callClaude([{ type: "text", text: "Return exactly the same content as a valid JSON array, nothing else:\n\n" + text }], 1500, MODEL); arr = tryJson(fix.text); }
      (Array.isArray(arr) ? arr : []).forEach((o: Any) => { const i = batch[Number(o?.n) - 1]; if (i === undefined) return; listings[i].raw = { ...(listings[i].raw ?? {}), designMatch: Math.max(0, Math.min(100, Math.round(Number(o.score) || 0))), designNote: String(o.note ?? "").slice(0, 120) }; });
    } catch { /* a failed batch leaves those listings unscored */ }
  };
  for (let i = 0; i < batches.length; i += 3) await Promise.all(batches.slice(i, i + 3).map(run));
  return { checked: true, refs: refs.length };
}

async function search1688(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const photoMode = Array.isArray(body.photo_urls) && body.photo_urls.length > 0;
  const terms: string[] = photoMode ? [] : (body.terms?.length ? body.terms : (r.spec?.search_terms_zh ?? [])).slice(0, 3);
  if (!photoMode && !terms.length) throw new HttpError(400, "No Chinese search terms yet. Run intake first or type a search term.");
  const filters = { ...DEFAULT_FILTERS, ...(body.filters ?? {}) };
  for (const k of ["min_service", "min_rating", "min_repeat", "min_years"]) filters[k] = Number(filters[k]) || 0;
  filters.factory_only = filters.factory_only !== false;
  const scanned: Any[] = [];
  const errors: string[] = [];
  if (photoMode) {
    try { (await apifyImage(body.photo_urls, 40)).forEach((it: Any) => normalise(it, "photo").forEach((l: Any) => { if (l.url && l.title) scanned.push(l); })); }
    catch (e) { errors.push((e as Error).message); }
  } else if (RATED_ACTOR) {
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
  if (!scanned.length) throw new HttpError(502, errors.join(" | ") || (photoMode ? "1688 found no products matching these photos. Try a clearer photo of the product alone on a plain background." : "1688 returned no products for these terms. The scraper may have been blocked; try again in a minute or use a shorter Chinese term."));
  const dropped: Record<string, number> = {};
  const listings = scanned.filter((l) => { const why = qualityCheck(l, filters); if (why) dropped[why] = (dropped[why] ?? 0) + 1; return !why; });
  // never bring back suppliers the buyer rejected for this request; on refresh, skip every supplier already shown
  const { data: prior } = await sb.from("request_candidates").select("status, factories(name, source_url)").eq("request_id", r.id);
  const seen = new Set<string>();
  for (const c of prior ?? []) if (c.factories && (body.exclude_existing || c.status === "rejected")) { if (c.factories.source_url) seen.add(String(c.factories.source_url).toLowerCase()); seen.add(String(c.factories.name).toLowerCase()); }
  const passed = listings.length;
  if (seen.size) for (let i = listings.length - 1; i >= 0; i--) { const l = listings[i]; if (seen.has((l.shopUrl || "").toLowerCase()) || seen.has(l.supplier.toLowerCase())) { listings.splice(i, 1); dropped.already_seen = (dropped.already_seen ?? 0) + 1; } }
  // design check against the buyer's photos (when the request has any): keep only listings that look like the wanted design
  const minDesign = Number(body.filters?.min_design ?? 60);
  let design: Any = { checked: false };
  if (listings.length && body.design_check !== false && minDesign > 0) {
    design = await designCheck(sb, r, listings);
    if (design.checked) for (let i = listings.length - 1; i >= 0; i--) {
      const m = listings[i].raw?.designMatch;
      if (m === undefined) { listings.splice(i, 1); dropped.no_photo = (dropped.no_photo ?? 0) + 1; }
      else if (m < minDesign) { listings.splice(i, 1); dropped.design = (dropped.design ?? 0) + 1; }
    }
  }
  const filterSummary = { scanned: scanned.length, kept: listings.length, dropped, filters, rated: scanned.some((l) => l.quality), design_checked: !!design.checked };
  if (!listings.length && design.checked && (dropped.design || dropped.no_photo)) throw new HttpError(422, `Checked ${scanned.length} listings against your photos: none matched the design closely enough (${dropped.design ?? 0} were a different design). Try Search by photo, a clearer photo of the product alone, or a more specific Chinese search term.`);
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
  if (RATED_ACTOR || photoMode) for (const l of bySupplier.values()) {
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
  if (!photoMode) {
    const used = [...new Set([...(r.spec?.used_terms ?? []), ...terms])].slice(-40);
    await sb.from("sourcing_requests").update({ spec: { ...(r.spec ?? {}), used_terms: used } }).eq("id", r.id);
  }
  const ranked = body.skip_rank ? { ranked: 0 } : await rank(sb, { request_id: r.id });
  return { ok: true, searched: photoMode ? ["photo"] : terms, photo: photoMode, listings: listings.length, new_candidates: rows.length, new_factories: newFactories.length, errors, filter: filterSummary, ...ranked };
}

async function searchPhoto(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const paths: string[] = (Array.isArray(body.paths) ? body.paths : []).map(String).filter((p: string) => p.startsWith(`${r.workspace_id}/`)).slice(0, 3);
  if (!paths.length) throw new HttpError(400, "Upload 1 to 3 product photos first.");
  // short-lived links the scraper can download (row level security on storage still applies)
  const { data: signed, error } = await sb.storage.from("photos").createSignedUrls(paths, 60 * 30);
  if (error) throw new HttpError(403, error.message);
  const urls = (signed ?? []).map((x: Any) => x.signedUrl).filter(Boolean);
  if (!urls.length) throw new HttpError(403, "Couldn't read those photos.");
  const photos = [...new Set([...(r.spec?.photos ?? []), ...paths])].slice(-6);
  await sb.from("sourcing_requests").update({ spec: { ...(r.spec ?? {}), photos } }).eq("id", r.id);
  return await search1688(sb, { request_id: r.id, photo_urls: urls, filters: body.filters, exclude_existing: body.exclude_existing });
}

const GLANCE_PROMPT = `From this product spec, pick the 5-6 facts a buyer checks first (for example frame, fabric, size, weight, load rating, colors). Return a JSON array of {label, value}: label 1-2 words, value at most 4 words with units (e.g. "50×50×80 cm", "100–120 kg", "4 options"), no parentheses, no "to be confirmed".`;
async function specGlance(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  if (!r.spec?.intake_at) return { ok: true, at_a_glance: [] };
  if (r.spec.at_a_glance?.length && !body.force) return { ok: true, at_a_glance: r.spec.at_a_glance };
  const { at_a_glance: _old, used_terms: _u, feedback: _f, search_terms_zh: _z, search_terms_en: _e, questions: _q, ...core } = r.spec;
  const out = await askJson(`${GLANCE_PROMPT}\nSpec: ${JSON.stringify(core)}`, 600, TRANSLATE_MODEL);
  const glance = (Array.isArray(out) ? out : []).filter((x: Any) => x && x.label && x.value).slice(0, 6).map((x: Any) => ({ label: String(x.label).slice(0, 24), value: String(x.value).slice(0, 40) }));
  await sb.from("sourcing_requests").update({ spec: { ...r.spec, at_a_glance: glance } }).eq("id", r.id);
  return { ok: true, at_a_glance: glance };
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
  const compact = cands.map((c: Any, i: number) => ({ i, title: c.listing_title, price_cny: c.price_cny, moq: c.moq, supplier: c.factories?.name, city: c.factories?.city, years: c.factories?.platform_years, claims_factory: c.factories?.verification?.listing_claims_factory, sales: c.factories?.verification?.sales, service_score: c.listing_data?.serviceScore ?? c.factories?.verification?.service_scores?.composite ?? null, product_rating: c.listing_data?.rating ?? null, reviews: c.listing_data?.reviewCount ?? null, supplier_positive_rate: c.listing_data?.supplierPositiveRate ?? c.factories?.verification?.positive_review_rate ?? null, repeat_rate: c.listing_data?.repeatRate ?? c.factories?.verification?.repeat_rate ?? null, photo_match_rank: c.listing_data?.fromPhoto ? c.listing_data?.imageRank ?? null : null, design_match: c.listing_data?.designMatch ?? null }));
  const out = await askJson(`You rank 1688 listings for a sourcing request. design_match (0-100, when present) is how closely the listing's photo matches the buyer's reference design; it matters most: a listing under 75 must score below any listing at 85 or more. Score each listing 0-100 on how well it fits the spec (product match, materials/features, MOQ vs quantity, price vs target, supplier looks like a real factory in a relevant industrial cluster, tenure, sales, and supplier quality: 1688 service score out of 5, product rating and review count, positive-review and repeat-buyer rates; prefer well-rated factories). If the spec has buyer feedback (spec.feedback), score down listings that match what the buyer disliked. photo_match_rank comes from 1688's search by the buyer's photo (1 = closest look-alike).
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

// ---------- client portal: answers to the intake questions ----------
// Called from the client's portal with their private link token (no Lathe sign-in). The token is checked
// with the service key, and only that client's own request can be touched.
async function portalAnswers(body: Any) {
  if (!SERVICE_KEY) throw new HttpError(500, "Service key missing");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false } });
  const token = String(body.token ?? "");
  if (token.length < 16) throw new HttpError(403, "Invalid portal link");
  const { data: c } = await admin.from("clients").select("id, workspace_id").eq("portal_token", token).eq("portal_active", true).maybeSingle();
  if (!c) throw new HttpError(403, "Invalid portal link");
  const { data: r } = await admin.from("sourcing_requests").select("*").eq("id", body.request_id).eq("client_id", c.id).maybeSingle();
  if (!r) throw new HttpError(404, "Request not found");
  const qs: string[] = Array.isArray(r.spec?.questions) ? r.spec.questions.map(String) : [];
  const answers = (Array.isArray(body.answers) ? body.answers : []).map((a: Any) => ({ q: String(a?.q ?? "").slice(0, 500), a: String(a?.a ?? "").trim().slice(0, 2000) }))
    .filter((a: Any) => a.a && qs.includes(a.q)).slice(0, 12);
  if (!answers.length) throw new HttpError(400, "Write at least one answer.");
  await admin.from("client_requirements").insert(answers.map((a: Any) => ({ workspace_id: r.workspace_id, request_id: r.id, kind: "answer", body: `${a.q}\n→ ${a.a}`, author: "client" })));
  const now = new Date().toISOString();
  const spec = { ...(r.spec ?? {}), client_answers: [...(r.spec?.client_answers ?? []), ...answers.map((a: Any) => ({ ...a, at: now }))].slice(-40) };
  await admin.from("sourcing_requests").update({ spec }).eq("id", r.id);
  // re-read the spec with the answers; new questions (if any) go back to the portal
  // the answers are already saved; if the spec update fails, the client still gets a thank-you and the request shows "run intake"
  try {
    const out: Any = await intake(admin, { request_id: r.id, answers: answers.map((a: Any) => `Q: ${a.q}\nA: ${a.a}`).join("\n\n") });
    return { ok: true, questions: out?.spec?.questions ?? [] };
  } catch (e) {
    await admin.from("activity").insert({ workspace_id: r.workspace_id, request_id: r.id, kind: "intake", actor: "Lathe", body: "Couldn't update the spec from the client's answers automatically. Run intake on the Spec step." });
    return { ok: true, questions: [], pending: true };
  }
}

// ---------- factory replies ----------
// Paste what the factory sent (or a screenshot of the WeChat / 1688 chat). Claude reads the numbers and terms,
// the negotiation is updated, and a counter-offer is drafted in Chinese for the user to send.
async function parseReply(sb: SupabaseClient, body: Any) {
  const text = String(body.text ?? "").trim().slice(0, 6000);
  const path = typeof body.photo_path === "string" ? body.photo_path : "";
  if (!text && !path) throw new HttpError(400, "Paste the factory's message or add a screenshot.");
  const { data: g, error } = await sb.from("negotiations").select("*, factories(name, city)").eq("id", body.negotiation_id).single();
  if (error || !g) throw new HttpError(404, "Negotiation not found");
  const r = await getRequest(sb, g.request_id);
  let images: string[] = [];
  if (path) { const { data } = await sb.storage.from("photos").createSignedUrl(path, 600); if (data?.signedUrl) images = [data.signedUrl]; }
  const recent = (g.log ?? []).slice(-6).map((l: Any) => `${String(l.at).slice(0, 10)}: ${l.note}${l.offer_cny ? ` (¥${l.offer_cny})` : ""}`).join("\n");
  const out = await askJson(`You help a China sourcing agent negotiate with a factory on 1688 / WeChat.
Request: ${specText(r)}
Factory: ${g.factories?.name ?? "unknown"} ${g.factories?.city ?? ""}
Where the negotiation stands: offer ${g.current_offer_cny ?? "none yet"} CNY, our target ${g.target_cny ?? r.spec?.estimated_factory_price_cny ?? "unknown"} CNY, MOQ ${g.moq ?? "?"}, lead time ${g.lead_time_days ?? "?"} days, payment ${g.payment_terms ?? "?"}.
Recent log:
${recent || "(nothing yet)"}
${text ? `The factory's latest message:\n"""${text}"""` : ""}${images.length ? "\nA screenshot of the chat is attached; read the factory's latest messages from it." : ""}

Return JSON:
{ "offer_cny": number|null (their unit price for the requested quantity; if tiered, the price for our quantity),
  "tiers": [{ "qty": number, "price_cny": number }] (any quantity tiers they gave, else []),
  "moq": number|null, "lead_time_days": number|null, "sample_cost_cny": number|null, "sample_days": number|null,
  "payment_terms": string|null (only as they stated it), "incoterm": string|null (only if they named one such as EXW, FOB or DDP; "含税不含运" is not an incoterm),
  "accepted_our_price": boolean (true only if they clearly agreed to a price we proposed),
  "summary_en": string (1-2 sentences: what they said), 
  "counter_cny": number|null (the unit price we should push for next, realistic for this product and their offer),
  "counter_zh": string (our reply in natural Simplified Chinese, WeChat style, polite and concise: thank them, push toward counter_cny with a reason such as quantity, repeat orders or competing quotes, ask for anything missing such as tiers, MOQ, lead time, sample cost, or confirm agreement if they accepted),
  "counter_en": string (faithful English translation of counter_zh) }
Only use numbers and terms that appear in the message or screenshot for the factory's side; leave anything they didn't state as null. Never invent their prices or terms.`, 2000, MODEL, images);
  const num = (x: Any) => (x === null || x === undefined || x === "" || isNaN(Number(x)) ? null : Number(x));
  const offer = num(out?.offer_cny), agreed = Boolean(out?.accepted_our_price) && offer !== null;
  const now = new Date().toISOString();
  const last_reply = { at: now, summary: String(out?.summary_en ?? "").slice(0, 600), counter_zh: String(out?.counter_zh ?? "").slice(0, 2000), counter_en: String(out?.counter_en ?? "").slice(0, 2000), counter_cny: num(out?.counter_cny), tiers: Array.isArray(out?.tiers) ? out.tiers.slice(0, 8) : [] };
  const patch: Any = {
    status: agreed ? "agreed" : "waiting_us", last_contact_at: now, next_action: agreed ? "Build the client quote" : "Send the counter-offer",
    terms: { ...(g.terms ?? {}), last_reply, ...(num(out?.sample_cost_cny) !== null ? { sample_cost_cny: num(out?.sample_cost_cny) } : {}), ...(num(out?.sample_days) !== null ? { sample_days: num(out?.sample_days) } : {}), ...(last_reply.tiers.length ? { tiers: last_reply.tiers } : {}) },
    log: [...(g.log ?? []), { at: now, note: `Factory: ${last_reply.summary}`, offer_cny: offer, raw: text.slice(0, 1500) || "(screenshot)" }].slice(-60),
  };
  if (offer !== null) patch.current_offer_cny = offer;
  if (agreed) patch.agreed_cny = offer;
  for (const k of ["moq", "lead_time_days"]) if (num(out?.[k]) !== null) patch[k] = Math.round(num(out?.[k])!);
  if (out?.payment_terms) patch.payment_terms = String(out.payment_terms).slice(0, 200);
  // an incoterm is only recorded if the factory actually wrote one (models like to assume FOB)
  const inc = String(out?.incoterm ?? "").toUpperCase().match(/\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/)?.[1];
  if (inc && (!text || new RegExp(`\\b${inc}\\b`, "i").test(text))) patch.incoterm = inc;
  const { error: e2 } = await sb.from("negotiations").update(patch).eq("id", g.id);
  if (e2) throw new HttpError(500, e2.message);
  return { ok: true, offer_cny: offer, agreed, moq: patch.moq ?? null, lead_time_days: patch.lead_time_days ?? null, ...last_reply };
}

// ---------- Operator actions (run on the server, same work as the buttons) ----------
async function operatorAction(sb: SupabaseClient, a: Any): Promise<string> {
  const r = await getRequest(sb, a.request_id);
  const t = r.title;
  switch (a.type) {
    case "run_intake": { await intake(sb, { request_id: r.id }); return `Read the spec for ${t}`; }
    case "search": {
      const photos = (r.spec?.photos ?? []).slice(-3);
      const photo = a.mode === "photo" && photos.length;
      await startJob(sb, { request_id: r.id, kind: photo ? "search_photo" : "search_1688", args: photo ? { paths: photos } : { terms: a.term ? [String(a.term)] : undefined } });
      return `Started ${photo ? "a photo search" : "a 1688 search"} for ${t} (runs in the background)`;
    }
    case "refresh": { await startJob(sb, { request_id: r.id, kind: "refresh_search", args: { feedback: a.feedback ? String(a.feedback) : "" } }); return `Looking for different factories for ${t}`; }
    case "negotiate": {
      const n = Math.max(1, Math.min(5, Number(a.count) || 2));
      const { data: have } = await sb.from("negotiations").select("factory_id").eq("request_id", r.id);
      const skip = new Set((have ?? []).map((x: Any) => x.factory_id));
      const { data: cands } = await sb.from("request_candidates").select("id, factory_id, factories(name)").eq("request_id", r.id).eq("status", "candidate").not("factory_id", "is", null).order("rank", { ascending: true, nullsFirst: false }).limit(20);
      const pick = (cands ?? []).filter((c: Any) => !skip.has(c.factory_id)).slice(0, n);
      if (!pick.length) throw new Error(`No new factories to start talks with on ${t}`);
      const { error } = await sb.from("negotiations").insert(pick.map((c: Any) => ({ workspace_id: r.workspace_id, request_id: r.id, factory_id: c.factory_id, candidate_id: c.id, target_cny: r.spec?.estimated_factory_price_cny ?? null })));
      if (error) throw new Error(error.message);
      await sb.from("request_candidates").update({ status: "contacted" }).in("id", pick.map((c: Any) => c.id));
      return `Started negotiations with ${pick.map((c: Any) => c.factories?.name ?? "a factory").join(", ")}`;
    }
    case "log_offer": {
      const price = Number(a.price_cny); if (!(price > 0)) throw new Error("No price given");
      const { data: negs } = await sb.from("negotiations").select("id, log, factories(name)").eq("request_id", r.id);
      const name = String(a.factory ?? "").toLowerCase();
      const g = (negs ?? []).find((x: Any) => name && (x.factories?.name ?? "").toLowerCase().includes(name)) ?? ((negs ?? []).length === 1 ? negs![0] : null);
      if (!g) throw new Error(`Couldn't tell which factory on ${t} that offer is from`);
      const now = new Date().toISOString();
      const patch: Any = { current_offer_cny: price, last_contact_at: now, status: a.agreed ? "agreed" : "waiting_us", log: [...(g.log ?? []), { at: now, note: a.note ? String(a.note) : "Offer logged by Operator", offer_cny: price }] };
      if (a.agreed) patch.agreed_cny = price;
      const { error } = await sb.from("negotiations").update(patch).eq("id", g.id);
      if (error) throw new Error(error.message);
      return `${a.agreed ? "Agreed" : "Logged"} ¥${price} with ${g.factories?.name ?? "the factory"}`;
    }
    case "release_quote": {
      const { data: q } = await sb.from("quotes").select("id").eq("request_id", r.id).order("created_at", { ascending: false }).limit(1);
      if (!q?.length) throw new Error(`No saved quote on ${t} yet`);
      await sb.from("quotes").update({ released_to_client: true, status: "sent" }).eq("id", q[0].id);
      return `Released the quote for ${t} to the client portal`;
    }
    case "mark_approved": {
      const { data: q } = await sb.from("quotes").select("id").eq("request_id", r.id).order("created_at", { ascending: false }).limit(1);
      if (!q?.length) throw new Error(`No quote on ${t} to approve`);
      await sb.from("quotes").update({ status: "accepted" }).eq("id", q[0].id);
      return `Marked the quote for ${t} as approved`;
    }
  }
  throw new Error("Unknown action");
}
const SERVER_ACTIONS = ["run_intake", "search", "refresh", "negotiate", "log_offer", "release_quote", "mark_approved"];

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

// ---------- Operator (Home page assistant) ----------
// Context it sees: the workspace's clients and open requests with their stage, best factories, offers and
// quotes; plus its own memory (per person + workspace): the conversation and running notes on what the
// person is working on. Every reply also returns fresh suggested prompts and updated notes.
async function operatorContext(sb: SupabaseClient, ws: string | null) {
  const scope = (q: Any) => (ws ? q.eq("workspace_id", ws) : q);
  const [{ data: clients }, { data: reqs }] = await Promise.all([
    scope(sb.from("clients").select("id, name, company")).limit(100),
    scope(sb.from("sourcing_requests").select("id, title, status, quantity, target_unit_price, deadline, client_id, spec, updated_at")).neq("status", "closed").order("updated_at", { ascending: false }).limit(15),
  ]);
  const ids = (reqs ?? []).map((r: Any) => r.id);
  const [{ data: cands }, { data: negs }, { data: quotes }, { data: flow }] = ids.length ? await Promise.all([
    sb.from("request_candidates").select("request_id, rank, price_cny, moq, listing_title, status, factories(name)").in("request_id", ids).neq("status", "rejected").order("rank", { ascending: true, nullsFirst: false }).limit(300),
    sb.from("negotiations").select("request_id, status, current_offer_cny, agreed_cny, target_cny, updated_at, factories(name)").in("request_id", ids).limit(200),
    sb.from("quotes").select("request_id, released_to_client, status, client_unit_price, created_at").in("request_id", ids).limit(100),
    sb.from("request_flow").select("id, next_title, next_hint, needs_you, phase").in("id", ids),
  ]) : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }] as Any[];
  const open = (reqs ?? []).map((r: Any) => {
    const cs = (cands ?? []).filter((c: Any) => c.request_id === r.id);
    return {
      id: r.id, title: r.title, status: r.status, ...(() => { const f = (flow ?? []).find((x: Any) => x.id === r.id); return { next_step: f ? `${f.next_title}. ${f.next_hint}` : "", needs_user: f?.needs_you ?? null }; })(), quantity: r.quantity, target_usd: r.target_unit_price, deadline: r.deadline,
      client: (clients ?? []).find((c: Any) => c.id === r.client_id)?.company ?? (clients ?? []).find((c: Any) => c.id === r.client_id)?.name ?? null,
      product: r.spec?.product_name ?? null, open_questions: (r.spec?.questions ?? []).slice(0, 5), est_factory_cny: r.spec?.estimated_factory_price_cny ?? null,
      candidates: cs.length, top_factories: cs.slice(0, 3).map((c: Any) => ({ factory: c.factories?.name, price_cny: c.price_cny, moq: c.moq })),
      negotiations: (negs ?? []).filter((n: Any) => n.request_id === r.id).map((n: Any) => ({ factory: n.factories?.name, status: n.status, offer_cny: n.current_offer_cny, agreed_cny: n.agreed_cny, target_cny: n.target_cny })),
      quotes: (quotes ?? []).filter((q: Any) => q.request_id === r.id).map((q: Any) => ({ usd_per_unit: q.client_unit_price, sent_to_client: q.released_to_client })),
      last_activity: String(r.updated_at ?? "").slice(0, 10),
    };
  });
  const { data: acts } = await scope(sb.from("activity").select("at, actor, body, request_id")).order("at", { ascending: false }).limit(15);
  const recent_activity = (acts ?? []).map((a: Any) => ({ at: String(a.at).slice(0, 16).replace("T", " "), who: a.actor, what: a.body, request: (reqs ?? []).find((r: Any) => r.id === a.request_id)?.title ?? null }));
  return { clients: (clients ?? []).map((c: Any) => ({ name: c.name, company: c.company })), open, recent_activity };
}
async function loadMemory(sb: SupabaseClient, ws: string | null) {
  if (!ws) return null;
  const { data } = await sb.from("operator_memory").select("messages, notes, suggestions").eq("workspace_id", ws).maybeSingle();
  return data ?? { messages: [], notes: "", suggestions: [] };
}
const cleanSugs = (a: Any, avoid: string[] = []) => (Array.isArray(a) ? a : []).map((x: Any) => String(x ?? "").trim().replace(/^["'“]|["'”]$/g, "")).filter((x: string) => x && x.length <= 110 && !avoid.includes(x)).slice(0, 4);
const SUG_RULES = `Suggestions: 4 short things the user could ask Operator next (each under 75 characters, written as the user would type them, in the user's language). Make them specific to the current work: name the actual products, factories, clients and numbers. Cover different kinds: a status check, the next action on the most pressing request, drafting a message (a counter-offer or follow-up to a factory in Chinese, or an update to a client), and an analysis or advice question. Prefer requests that are stuck or have a next step, and threads from the memory and recent conversation. Operator can answer questions, give advice, draft messages, create requests and clients, and open pages; it can also run intake, search 1688, refresh results, start negotiations, log offers, release quotes and mark them approved; it cannot contact factories or place orders itself. Each suggestion under 75 characters.`;

// ---------- background jobs ----------
// Long 1688 searches run after the response is sent, so the screen never freezes; progress and results
// are written to the jobs table, which the app watches live.
const JOB_LABEL: Record<string, string> = { search_1688: "Searching 1688", search_photo: "Searching 1688 by photo", refresh_search: "Finding different factories" };
async function startJob(sb: SupabaseClient, body: Any) {
  const kind = String(body.kind ?? "");
  if (!JOB_LABEL[kind]) throw new HttpError(400, "Unknown job");
  const r = await getRequest(sb, body.request_id);
  const { data: running } = await sb.from("jobs").select("id").eq("request_id", r.id).eq("status", "running").gt("created_at", new Date(Date.now() - 10 * 60000).toISOString()).limit(1);
  if (running?.length) throw new HttpError(409, "A search is already running for this request.");
  const { data: job, error } = await sb.from("jobs").insert({ workspace_id: r.workspace_id, request_id: r.id, kind, label: JOB_LABEL[kind] }).select("id").single();
  if (error) throw new HttpError(500, error.message);
  const args = { ...(body.args ?? {}), request_id: r.id };
  const work = (async () => {
    try {
      const out: Any = kind === "search_1688" ? await search1688(sb, args) : kind === "search_photo" ? await searchPhoto(sb, args) : await refreshSearch(sb, args);
      const result = { listings: out.listings, new_candidates: out.new_candidates, new_factories: out.new_factories, ranked: out.ranked, replaced: out.replaced ?? null, terms: out.terms ?? out.searched ?? null,
        scanned: out.filter?.scanned ?? null, kept: out.filter?.kept ?? null, dropped: out.filter?.dropped ?? null, design_checked: out.filter?.design_checked ?? false };
      await sb.from("jobs").update({ status: "done", result, finished_at: new Date().toISOString() }).eq("id", job.id);
    } catch (e) {
      await sb.from("jobs").update({ status: "failed", error: String((e as Error).message ?? e).slice(0, 500), finished_at: new Date().toISOString() }).eq("id", job.id);
    }
  })();
  const rt = (globalThis as Any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(work); else await work;
  return { ok: true, job_id: job.id, label: JOB_LABEL[kind] };
}

async function operator(sb: SupabaseClient, body: Any) {
  const message = String(body.message ?? "").trim().slice(0, 4000);
  if (!message) throw new HttpError(400, "Empty message");
  const ws = typeof body.workspace_id === "string" ? body.workspace_id : null;
  const mem = await loadMemory(sb, ws);
  const past = (mem?.messages ?? []) as Any[];
  const histSrc = past.length ? past.map((m: Any) => ({ role: m.role === "op" ? "operator" : "user", text: m.text })) : (Array.isArray(body.history) ? body.history : []);
  const history = histSrc.slice(-10).map((h: Any) => `${h.role === "operator" ? "Operator" : "User"}: ${String(h.text ?? "").slice(0, 800)}`).join("\n");
  const { clients, open, recent_activity } = await operatorContext(sb, ws);
  const today = new Date().toISOString().slice(0, 10);
  const lang = body.lang === "zh" ? "Simplified Chinese" : "English";
  const out = await askJson(`You are Operator, the assistant inside Lathe. Gary runs it: US brands tell him what they want made, he sources it from Chinese factories (1688), negotiates himself, quotes the full landed cost, and places the order.
Today is ${today}. Reply in ${lang}.
Your memory of what this person is working on (your own notes from earlier conversations):
${mem?.notes?.trim() || "(nothing yet)"}
Clients: ${JSON.stringify(clients)}
Open requests (newest activity first) with their stage, best factories, offers and quotes: ${JSON.stringify(open)}
Recent activity across the workspace (newest first; who did what): ${JSON.stringify(recent_activity)}
Conversation so far:
${history || "(none)"}
User: ${message}

Decide what to do and return a JSON object:
{ "reply": string, "actions": [ {...} ] (0 to 3 actions, in order), "memory": string, "suggestions": string[] }
Possible actions:
- { "type": "create_request", "title": short product name with key spec (under 70 chars), "brief": everything the user said about the product (specs, materials, packaging, branding, price, timing), "quantity": number|null, "target_unit_price": number|null (USD per unit), "deadline": "YYYY-MM-DD"|null (resolve relative dates from today), "client_name": existing client name or company if one was named, else null }
- { "type": "create_client", "name": string, "company": string|null, "email": string|null }
- { "type": "run_intake", "request_id": id }  (read or re-read the spec)
- { "type": "search", "request_id": id, "mode": "text"|"photo", "term": Chinese search phrase|null }  (search 1688; runs in the background)
- { "type": "refresh", "request_id": id, "feedback": what the user disliked|null }  (replace the current factories with different ones)
- { "type": "negotiate", "request_id": id, "count": 1-5 }  (start negotiations with the best-ranked factories)
- { "type": "log_offer", "request_id": id, "factory": factory name as in the data, "price_cny": number, "agreed": boolean, "note": string|null }
- { "type": "release_quote", "request_id": id }  (put the latest saved quote in the client's portal)
- { "type": "mark_approved", "request_id": id }  (the client said yes to the latest quote)
- { "type": "open", "href": one of "sourcing.html#/requests", "sourcing.html#/request/<id>", "sourcing.html#/clients", "sourcing.html#/factories", "sourcing.html#/rates", "sourcing.html#/new", "sourcing.html#/account" }
Rules: take an action only when the user clearly asks for it (or confirms one you proposed); never take one on your own initiative, and use only request ids from the data. When you take actions, the reply says in one short sentence what you're doing; the app adds what happened. Only create a request when the user asks to source, make, buy or quote a physical product; then the reply is one short sentence saying you're creating it and running intake. Answer status questions from the open requests only, briefly and specifically (name the requests and what each needs next). When asked to draft a message, write it in full: factory messages in Chinese (polite, concise, WeChat/1688 style), client messages in English. When useful, link a request as [its title](sourcing.html#/request/<id>). Never invent prices, factories or facts that are not in the data. Plain sentences, no markdown headings.
memory: rewrite your notes for next time (max 700 characters, short lines): what the person is focused on now, decisions made, preferences and how they like to work, and open threads to follow up. Keep what still matters from the old notes, drop what is finished or stale, add what this exchange taught you. Facts only; no guesses.
${SUG_RULES} Don't repeat these recent suggestions: ${JSON.stringify(mem?.suggestions ?? [])}.`);
  const list: Any[] = (Array.isArray(out?.actions) ? out.actions : out?.action ? [out.action] : []).filter((x: Any) => x && typeof x === "object").slice(0, 3);
  const allowed = ["create_request", "create_client", "open"];
  const a = list.find((x: Any) => allowed.includes(x.type)) ?? null;
  // server actions run here, with the same functions as the buttons
  const done: string[] = [], failed: string[] = [];
  for (const x of list.filter((x: Any) => SERVER_ACTIONS.includes(x.type))) {
    try { done.push(await operatorAction(sb, x)); } catch (e) { failed.push(String((e as Error).message ?? e)); }
  }
  let reply = String(out?.reply ?? "").slice(0, 3000);
  if (done.length) reply += `\n\n${done.map((d) => "✓ " + d).join("\n")}`;
  if (failed.length) reply += `\n\n${failed.map((d) => "✗ " + d).join("\n")}`;
  const suggestions = cleanSugs(out?.suggestions, body.message ? [message] : []);
  if (ws && mem) {
    const now = new Date().toISOString();
    const msgs = [...past, { role: "me", text: message, at: now }, { role: "op", text: reply, at: now }].slice(-40);
    const notes = typeof out?.memory === "string" && out.memory.trim() ? out.memory.trim().slice(0, 900) : mem.notes;
    await sb.from("operator_memory").upsert({ workspace_id: ws, messages: msgs, notes, suggestions: suggestions.length ? suggestions : mem.suggestions, updated_at: now }, { onConflict: "workspace_id,user_id" });
  }
  return { ok: true, reply, action: a, done, suggestions };
}

// Fresh suggested prompts for the Operator panel, from the current work and memory (fast model).
async function operatorSuggest(sb: SupabaseClient, body: Any) {
  const ws = typeof body.workspace_id === "string" ? body.workspace_id : null;
  const mem = await loadMemory(sb, ws);
  const { clients, open } = await operatorContext(sb, ws);
  const recent = ((mem?.messages ?? []) as Any[]).slice(-6).map((m: Any) => `${m.role === "op" ? "Operator" : "User"}: ${String(m.text ?? "").slice(0, 300)}`).join("\n");
  const avoid = [...((mem?.suggestions ?? []) as string[]), ...((Array.isArray(body.avoid) ? body.avoid : []) as string[])].slice(-16);
  const lang = body.lang === "zh" ? "Simplified Chinese" : "English";
  const out = await askJson(`You suggest prompts for Operator, the assistant in Lathe (a tool for sourcing products from Chinese factories for US clients). Today is ${new Date().toISOString().slice(0, 10)}. Write in ${lang}.
Memory notes about what the user is working on: ${mem?.notes?.trim() || "(none yet)"}
Recent conversation:
${recent || "(none)"}
Clients: ${JSON.stringify(clients)}
Open requests: ${JSON.stringify(open)}
${SUG_RULES} If there are no open requests, suggest starting one (a concrete example product) or adding a client.
Don't repeat or closely reword any of these: ${JSON.stringify(avoid)}.
Return a JSON array of 4 strings.`, 600, TRANSLATE_MODEL);
  const suggestions = cleanSugs(out, avoid);
  if (ws && mem && suggestions.length) await sb.from("operator_memory").upsert({ workspace_id: ws, messages: mem.messages ?? [], notes: mem.notes ?? "", suggestions: [...((mem.suggestions ?? []) as string[]), ...suggestions].slice(-12), updated_at: new Date().toISOString() }, { onConflict: "workspace_id,user_id" });
  return { ok: true, suggestions };
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
  if (String(body.task ?? "") === "portal_answers") {
    try { return json(await portalAnswers(body)); } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500); }
  }
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
      case "spec_glance": return json(await specGlance(sb, body));
      case "search_photo": return json(await searchPhoto(sb, body));
      case "draft_rfq": return json(await draftRfq(sb, body));
      case "verify": return json(await verify(sb, body));
      case "operator": return json(await operator(sb, body));
      case "operator_suggest": return json(await operatorSuggest(sb, body));
      case "start_job": return json(await startJob(sb, body));
      case "parse_reply": return json(await parseReply(sb, body));
      case "registry_contacts": return json(await registryContacts(sb, body));
      case "status": return json({ ok: true, anthropic: Boolean(ANTHROPIC_API_KEY), apify: Boolean(APIFY_TOKEN), registry: Boolean(TYC_TOKEN), actor: APIFY_ACTOR, model: MODEL });
      default: return json({ error: "Unknown task" }, 400);
    }
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500); }
});
