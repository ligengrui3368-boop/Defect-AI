// Lathe sourcing agents. One function, several tasks (all with the caller's JWT, so
// row level security applies):
//   intake      – turn a client's brief into a structured spec, Chinese search terms, an HTS
//                 guess and follow-up questions; writes sourcing_requests.spec
//   search_1688 – run a 1688 search through a third-party scraper API (Apify) using the spec's
//                 Chinese search terms, save suppliers as factories and listings as candidates,
//                 then rank them against the spec with Claude
//   rank        – re-rank the existing candidates of a request against its spec
//   draft_rfq   – write a Chinese WeChat/email RFQ for a factory (with English translation)
//                 from the spec and the negotiation target
//   verify      – factory verification stub (registry / customs lookups): returns what is and
//                 isn't configured, so the UI can show it honestly
//   operator    – the Home page assistant: reads the workspace's clients and open requests,
//                 answers questions, or returns one action for the page to carry out
//                 (create_request, create_client, open)
// Secrets (Supabase Edge Function Secrets, set by Gary only): ANTHROPIC_API_KEY, APIFY_TOKEN.
// Optional: APIFY_1688_ACTOR (default schnellscrapers~1688-supplier-leads), SOURCING_MODEL.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("SOURCING_MODEL") ?? "claude-sonnet-5-5";
const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN") ?? "";
const APIFY_ACTOR = Deno.env.get("APIFY_1688_ACTOR") ?? "schnellscrapers~1688-supplier-leads";
const MAX_LISTINGS = Number(Deno.env.get("SOURCING_MAX_LISTINGS") ?? "40");

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
async function askJson(prompt: string, maxTokens = 3000): Promise<Any> {
  if (!ANTHROPIC_API_KEY) throw new HttpError(500, "ANTHROPIC_API_KEY is not set in Edge Function Secrets.");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt + "\n\nReply with only the JSON value, no other text." }] }),
  });
  if (!res.ok) throw new HttpError(502, `Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((c: Any) => c.type === "text").map((c: Any) => c.text).join("\n").trim();
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(clean); } catch { const m = clean.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]); throw new HttpError(502, "Claude did not return JSON"); }
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
async function apify1688(keyword: string, limit: number): Promise<Any[]> {
  if (!APIFY_TOKEN) throw new HttpError(500, "APIFY_TOKEN is not set in Edge Function Secrets. Add it (from apify.com → Settings → Integrations) to enable 1688 search.");
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}&timeout=140&format=json&clean=true`;
  const input = SUPPLIER_ACTOR
    ? { keywords: [keyword], maxSuppliersPerKeyword: limit, maxPagesPerKeyword: 1, maxOffersPerSupplier: 2, sortBy: "relevance", manufacturersOnly: false, proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] } }
    : { keyword, searchKeywords: [keyword], keywords: [keyword], maxItems: limit, maxResults: limit, limit };
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  if (!res.ok) throw new HttpError(502, `Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const items = await res.json();
  return Array.isArray(items) ? items : (items?.items ?? []);
}
const pick = (o: Any, keys: string[]) => { for (const k of keys) { const v = k.split(".").reduce((a, p) => a?.[p], o); if (v !== undefined && v !== null && v !== "") return v; } return undefined; };
const num = (v: Any) => { if (v === undefined || v === null) return null; const n = parseFloat(String(v).replace(/[^0-9.]/g, "")); return isFinite(n) ? n : null; };
const FACTORY_WORDS = /factory|manufact|生产|工厂|加工/i;
function normalise(it: Any, keyword: string): Any[] {
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

async function search1688(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const terms: string[] = (body.terms?.length ? body.terms : (r.spec?.search_terms_zh ?? [])).slice(0, 3);
  if (!terms.length) throw new HttpError(400, "No Chinese search terms yet. Run intake first or type a search term.");
  const perTerm = Math.max(5, Math.floor((SUPPLIER_ACTOR ? 24 : MAX_LISTINGS) / terms.length));
  const listings: Any[] = [];
  const errors: string[] = [];
  await Promise.all(terms.map(async (t) => {
    try { (await apify1688(t, perTerm)).forEach((it: Any) => normalise(it, t).forEach((l: Any) => { if (l.url && l.title) listings.push(l); })); }
    catch (e) { errors.push(`${t}: ${(e as Error).message}`); }
  }));
  if (!listings.length) throw new HttpError(502, errors.join(" | ") || "1688 returned no products for these terms. The scraper may have been blocked; try again in a minute or use a shorter Chinese term.");
  // one factory row per supplier (by shop url, else by name)
  const bySupplier = new Map<string, Any>();
  for (const l of listings) { const key = (l.shopUrl || l.supplier).toLowerCase(); if (!bySupplier.has(key)) bySupplier.set(key, l); }
  const { data: existing } = await sb.from("factories").select("id, name, source_url").eq("workspace_id", r.workspace_id);
  const factoryId = new Map<string, string>();
  (existing ?? []).forEach((f: Any) => { if (f.source_url) factoryId.set(f.source_url.toLowerCase(), f.id); factoryId.set(f.name.toLowerCase(), f.id); });
  const newFactories = [...bySupplier.values()].filter((l) => !factoryId.has((l.shopUrl || "").toLowerCase()) && !factoryId.has(l.supplier.toLowerCase())).map((l) => ({
    workspace_id: r.workspace_id, name: l.supplier, source: "1688", source_url: l.shopUrl || null, city: l.city || null, platform_years: l.years,
    is_verified_factory: null, verification: { listing_claims_factory: l.isFactory, sales: l.sales, ...l.signals }, categories: [r.spec?.category ?? r.title].filter(Boolean),
  }));
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
  const ranked = await rank(sb, { request_id: r.id });
  return { ok: true, searched: terms, listings: listings.length, new_candidates: rows.length, new_factories: newFactories.length, errors, ...ranked };
}

async function rank(sb: SupabaseClient, body: Any) {
  const r = await getRequest(sb, body.request_id);
  const { data: cands } = await sb.from("request_candidates").select("id, listing_title, listing_url, price_cny, moq, listing_data, factories(name, city, platform_years, verification, is_verified_factory)").eq("request_id", r.id).neq("status", "rejected").limit(80);
  if (!cands?.length) return { ranked: 0 };
  const compact = cands.map((c: Any, i: number) => ({ i, title: c.listing_title, price_cny: c.price_cny, moq: c.moq, supplier: c.factories?.name, city: c.factories?.city, years: c.factories?.platform_years, claims_factory: c.factories?.verification?.listing_claims_factory, sales: c.factories?.verification?.sales }));
  const out = await askJson(`You rank 1688 listings for a sourcing request. Score each listing 0-100 on how well it fits the spec (product match, materials/features, MOQ vs quantity, price vs target, supplier looks like a real factory in a relevant industrial cluster, tenure, sales).
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
  const configured = { registry_api: Boolean(Deno.env.get("QICHACHA_KEY") || Deno.env.get("TIANYANCHA_TOKEN")), customs_api: Boolean(Deno.env.get("IMPORT_DATA_KEY")) };
  const checks = [
    { name: "Business registry (企查查/天眼查)", status: configured.registry_api ? "pending" : "manual", how: `Search "${f.name_zh || f.name}" on qcc.com or tianyancha.com: confirm 经营范围 includes manufacturing (生产/制造), note 注册资本 and 参保人数 (under ~10 insured staff usually means a trader).` },
    { name: "US customs shipments", status: configured.customs_api ? "pending" : "manual", how: `Search the company name on importyeti.com to see if it already ships this product type to US buyers.` },
    { name: "1688 listing signals", status: "done", result: { claims_factory: f.verification?.listing_claims_factory ?? null, platform_years: f.platform_years, sales: f.verification?.sales ?? null, city: f.city } },
  ];
  return { ok: true, configured, checks, note: configured.registry_api || configured.customs_api ? "Automatic lookups run when their API keys are set." : "Automatic registry and customs lookups are not configured yet; the steps above are manual for now. Record the result on the factory with the 'Verified factory' switch." };
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Any; try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: "Sign in first" }, 401);
  try {
    switch (String(body.task ?? "")) {
      case "intake": return json(await intake(sb, body));
      case "search_1688": return json(await search1688(sb, body));
      case "rank": return json(await rank(sb, body));
      case "draft_rfq": return json(await draftRfq(sb, body));
      case "verify": return json(await verify(sb, body));
      case "operator": return json(await operator(sb, body));
      case "status": return json({ ok: true, anthropic: Boolean(ANTHROPIC_API_KEY), apify: Boolean(APIFY_TOKEN), actor: APIFY_ACTOR, model: MODEL });
      default: return json({ error: "Unknown task" }, 400);
    }
  } catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500); }
});
