// Defect Check AI endpoint. One function, several tasks:
//   identify      – label which part each photo shows and flag unusable photos
//   describe      – draft a standard from photos of a good unit
//   read_listing  – draft a standard from pasted listing text and screenshots
//   import_url    – fetch an official product page, save its images, draft a standard
//   inspect       – run a check on a saved inspection and write the result back.
//                   Arrival checks (stage = arrival) are also compared with the factory
//                   check of the same unit or lot, and each finding gets an origin:
//                   factory, transit or unclear.
//   factory_*     – used by factory staff through a factory link (no account). The link's
//                   token is checked here and the service role acts only inside that
//                   link's workspace, product and lot. Anti-cheat: the factory locks the
//                   lot size, the server draws a random AQL sample of carton/unit positions,
//                   reveals them one at a time with a short capture window, and only accepts
//                   photos uploaded to that pick's folder inside the window.
//   po_*          – used by the factory through a PO hub link (one link per purchase order):
//                   open the order (all SKU lines and their inspections), and run the
//                   container loading check (live photos per stage, container and seal
//                   numbers read by the AI and the ISO 6346 check digit, carton counts
//                   against the packing list).
//   receipt_check – dock receiving: reads the seal, compares it with loading, checks carton
//                   counts against loading and the PO, classifies damaged cartons against the
//                   loading photos, and says who is responsible for each gap.
// Every finding carries a defect code from a shared list (public.defect_codes).
// For every other task the caller's JWT is forwarded, so row level security applies.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL_INSPECT = Deno.env.get("QC_MODEL") ?? "claude-sonnet-5-5";
const MODEL_CAREFUL = Deno.env.get("QC_MODEL_CAREFUL") ?? "claude-opus-5-5";
const MODEL_QUICK = Deno.env.get("QC_MODEL_QUICK") ?? "claude-haiku-4-5-20251001";
const MAX_IMAGES = Number(Deno.env.get("QC_MAX_IMAGES_PER_CALL") ?? "16");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_FACTORY_PHOTOS = 12;
const PICK_GRACE_S = 90; // upload and identify latency allowed past the window

export const WATCH = ["Scratches", "Dents", "Cracks or chips", "Stains or marks", "Color mismatch", "Missing parts", "Loose or bent parts", "Logo or print errors", "Wrong label", "Packaging damage", "Rust or corrosion", "Burrs or sharp edges", "Loose threads", "Bubbles or warping"];
export const VIEWS = ["Front", "Back", "Top", "Bottom", "Side", "Label", "Packaging", "Close-up"];
// Shared defect vocabulary (mirrors public.defect_codes): [code, scope, English, Chinese, default severity]
export const CODES: [string, string, string, string, string][] = [
  ["SCR", "product", "Scratch", "划痕", "minor"], ["DNT", "product", "Dent", "凹痕", "major"], ["CRK", "product", "Crack or chip", "裂纹或缺口", "major"],
  ["STN", "product", "Stain or mark", "污渍或印记", "minor"], ["CLR", "product", "Color mismatch", "颜色不符", "major"], ["MSP", "product", "Missing part", "缺件", "major"],
  ["LSE", "product", "Loose or bent part", "松动或变形", "major"], ["ASM", "product", "Assembly fault", "装配不良", "major"], ["DIM", "product", "Wrong size", "尺寸不符", "major"],
  ["PRT", "product", "Print or logo error", "印刷或标志错误", "major"], ["BUR", "product", "Burr or sharp edge", "毛刺或锋利边缘", "critical"], ["RST", "product", "Rust or corrosion", "生锈或腐蚀", "major"],
  ["THR", "product", "Loose threads", "线头", "minor"], ["WRP", "product", "Bubbles or warping", "气泡或翘曲", "minor"], ["CON", "product", "Foreign matter or contamination", "异物或污染", "critical"],
  ["FNC", "product", "Visible function fault", "功能不良", "major"], ["LBL", "label", "Wrong or missing label", "标签错误或缺失", "major"], ["BCD", "label", "Wrong or unreadable barcode", "条码错误或无法识别", "major"],
  ["TXT", "label", "Required text missing or misspelled", "必需文字缺失或拼写错误", "major"], ["PKG", "packaging", "Retail packaging damaged", "销售包装损坏", "major"], ["PKW", "packaging", "Wrong packaging", "包装不符", "major"],
  ["CTN", "carton", "Crushed or torn carton", "纸箱压坏或破损", "minor"], ["WET", "carton", "Wet or stained carton", "纸箱受潮或污染", "major"], ["PNC", "carton", "Puncture", "刺穿", "major"],
  ["BRK", "carton", "Breakage", "破碎", "critical"], ["LEK", "carton", "Leak", "渗漏", "critical"], ["MRK", "carton", "Wrong carton marks", "箱唛错误", "major"],
  ["QTY", "carton", "Wrong quantity in carton", "装箱数量不符", "major"], ["CNT", "container", "Container damage (holes, dents, broken doors)", "集装箱破损", "major"],
  ["CND", "container", "Container not clean or not dry", "集装箱不干净或潮湿", "major"], ["SEL", "container", "Seal problem", "封条问题", "critical"],
  ["STW", "container", "Poor stowage or bracing", "装载或固定不当", "major"], ["OTH", "product", "Other", "其他", "major"],
];
const CODE_SET = new Set(CODES.map((c) => c[0]));
export const codeList = (scopes: string[]) => CODES.filter((c) => scopes.includes(c[1]) || c[0] === "OTH").map((c) => `${c[0]} = ${c[2]}`).join("; ");
export const asCode = (c: unknown) => { const k = String(c ?? "").trim().toUpperCase().slice(0, 3); return CODE_SET.has(k) ? k : "OTH"; };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Img = { data: string; media_type: string };
type Photo = { path: string; view?: string; part?: string; origin?: string; kind?: string; quality?: string; codes?: string[] };
// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;
type Before = { photos: Photo[]; sameUnit: boolean; origin: any; text: string[] };
export const TRANSIT_WATCH = ["Crushed or torn carton", "Wet or stained packaging", "Punctures", "Dents", "Breakage", "Leaks", "Contents shifted or missing"];

// ---------- Claude ----------
async function askJson(prompt: string, images: Img[], model: string, maxTokens = 4000): Promise<any> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set. Run: supabase secrets set ANTHROPIC_API_KEY=...");
  const content: unknown[] = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
  content.push({ type: "text", text: prompt + "\n\nReply with only the JSON value, no other text." });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return parseJson(text);
}
function parseJson(text: string): any {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const a = Math.min(...["{", "["].map((c) => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
  const b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a !== Infinity && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("Claude did not return JSON");
}

// ---------- storage ----------
function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function loadImages(sb: SupabaseClient, paths: string[]): Promise<Img[]> {
  return await Promise.all(paths.map(async (p) => {
    const { data, error } = await sb.storage.from("photos").download(p);
    if (error || !data) throw new Error(`Could not read photo ${p}: ${error?.message ?? "missing"}`);
    const type = data.type && data.type.startsWith("image/") ? data.type : "image/jpeg";
    return { data: b64(await data.arrayBuffer()), media_type: type };
  }));
}

// ---------- prompts ----------
const lines = (s?: string) => (s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

function identifyPrompt(product: any, n: number) {
  return `These ${n} photos, numbered 1 to ${n}, were taken of one unit of ${product?.name ? `"${product.name}"` : "a consumer product"}${product?.colors ? ` (${product.colors})` : ""}. For each photo, say which side or part of the product it shows and whether the photo is usable for a visual defect check.
"view" must be one of: Front (the side with the main brand label or face), Back (the opposite side, e.g. the back label or nutrition panel), Top (the top of the product, e.g. a bottle's cap and neck), Bottom, Side, Label (a close shot of a label or printed text), Packaging (box, case or outer carton), Close-up (a zoomed detail), Other.
"part" names what is visible in 2 to 5 words, e.g. "Front label", "Cap and tamper ring", "Back label, nutrition panel".
"quality": ok, blurry, dark, glare, cropped, or wrong_product. Use ok unless the problem would stop an inspector judging that part.
JSON: {"photos":[{"index":1,"view":"Front","part":"","quality":"ok","note":"short reason if not ok"}]}`;
}

const STANDARD_JSON = `{"name":"","sku":"model number if stated","material":"","colors":"","finish":"Matte|Satin|Glossy|Textured|Brushed|Mixed|","dims_mm":{"l":null,"w":null,"h":null},"packaging":"","in_box":["each included item with quantity"],"official_specs":["Key: value"],"good_looks":"2-3 sentences an inspector can check visually","must_have":["visible features that must be present"],"allowed_variation":[],"watch_for":["pick from: ${WATCH.join(", ")}"],"images":[{"index":1,"kind":"product_photo|spec_or_text|lifestyle|other","view":"Front|Back|Top|Bottom|Side|Label|Packaging|Close-up|"}],"notes":"one sentence on anything missing, unclear or contradictory"}`;

function listingPrompt(url: string, text: string, nImages: number) {
  const q = [
    "You are setting up a quality-inspection standard for a product an online seller buys from a factory. The source is the OFFICIAL product listing or spec sheet from the brand or manufacturer.",
  ];
  if (url) q.push("Listing URL: " + url);
  if (nImages) q.push(`There are ${nImages} images from the listing, numbered 1 to ${nImages} in order.`);
  if (text) q.push("LISTING TEXT (may include page clutter; ignore navigation, reviews, ads and other products):\n<<<\n" + text.slice(0, 40000) + "\n>>>");
  q.push(`Extract only what the listing actually states or shows. Do not invent specs. Convert sizes to millimetres when a unit is given.\nJSON: ${STANDARD_JSON}`);
  return q.join("\n\n");
}
function describePrompt(n: number) {
  return `These ${n} photos show one approved-good unit of a consumer product that will be sourced from a factory and sold online. Describe it so a factory inspector could tell a good unit from a defective one. Only describe what you can see; leave a field "" or [] if you can't tell.
JSON: {"name":"short product name","material":"","colors":"","finish":"Matte|Satin|Glossy|Textured|Brushed|Mixed|","good_looks":"","must_have":[],"allowed_variation":[],"watch_for":["pick from: ${WATCH.join(", ")}"],"images":[{"index":1,"view":"","part":""}]}`;
}

export function inspectPrompt(p: any, refs: Photo[], units: Photo[], all: Photo[], before: Photo[] = [], ev: Before | null = null, zh = false, pick: { carton: number; unit_pos: number } | null = null) {
  const s = p.spec ?? {};
  const L: string[] = [];
  const arrival = !!ev;
  L.push("You are a strict but fair quality-control inspector working for an online seller who buys from a factory. Decide whether the unit in the photos matches the seller's approved standard and is free of defects.");
  if (arrival) L.push("This is an ARRIVAL CHECK: the unit was made and shipped by the factory and has just been received at the buyer's warehouse. Besides checking it against the standard, you must decide WHERE each problem most likely happened: at the FACTORY (before shipping) or in TRANSIT (shipping, handling, storage). The result is used as evidence in claims against the factory or the freight carrier, so be careful and honest about uncertainty.");
  const label = (u: Photo) => u.part || u.view || "unspecified";
  let n = 0;
  if (refs.length) {
    L.push("REFERENCE images (what a good unit looks like):");
    refs.forEach((r) => L.push(`- Image ${++n}: ${r.origin === "official" ? "OFFICIAL listing image from the brand. It may be a studio render or retouched: use it for shape, color, parts, logo and layout, and ignore its lighting, background, props and perfect surfaces" : "photo of a real APPROVED unit"} (shows: ${label(r)}).`));
  }
  if (before.length) {
    L.push(`FACTORY images, taken at the factory BEFORE shipping, of ${ev?.sameUnit ? "THIS SAME UNIT" : "OTHER units from the same lot (not this exact unit; they only show how the lot looked when it left the factory)"}:`);
    before.forEach((b) => L.push(`- Image ${++n}: factory photo (shows: ${label(b)}).`));
  }
  if (n) L.push(`${units.length > 1 ? `Images ${n + 1}–${n + units.length} show` : `Image ${n + 1} shows`} the UNIT UNDER INSPECTION${arrival ? " as received" : ""} (in order: ${units.map(label).join("; ")}).`);
  else L.push(`There are no reference images. All ${units.length} images show the UNIT UNDER INSPECTION${arrival ? " as received" : ""} (in order: ${units.map(label).join("; ")}).`);
  if (arrival && ev) {
    L.push("FACTORY RECORD:");
    (ev.text.length ? ev.text : ["No factory check was found for this unit or lot."]).forEach((t) => L.push("- " + t));
  }
  if (all.length > units.length) {
    const others = [...new Set(all.filter((u) => !units.includes(u)).map(label))];
    L.push(`These are ${units.length} of ${all.length} photos of this unit; the rest are checked separately${others.length ? ` and show: ${others.join("; ")}` : ""}. Judge only what these photos show, mark items they don't show as "unclear", and never ask for more photos of parts the other photos already show.`);
  }
  L.push("SELLER STANDARD:");
  const add = (k: string, v?: string) => { if (v && String(v).trim()) L.push(`- ${k}: ${String(v).trim()}`); };
  add("Product", p.name); add("Model/SKU", p.sku); add("Material", s.material); add("Colors", s.colors); add("Finish", s.finish);
  const d = s.dims ?? {};
  if (d.l || d.w || d.h) add("Size (mm)", `${d.l || "?"} x ${d.w || "?"} x ${d.h || "?"}${s.tol ? " ± " + s.tol : ""}`);
  add("Packaging", s.packaging); add("Official specs", lines(s.officialSpecs).join("; "));
  add("In the box (a visibly missing item = fail; mark unclear if the contents are not shown)", lines(s.inBox).join("; "));
  add("Official listing URL", p.source_url); add("A good unit", s.goodLooks);
  add("Must have (missing or wrong = fail)", lines(s.mustHave).join("; "));
  add("Allowed variation (do NOT flag these)", lines(s.allowed).join("; "));
  add("Watch especially for", [...new Set([...(s.watch ?? []), ...(arrival ? TRANSIT_WATCH : [])])].join(", "));
  add("Smallest rejectable defect", s.minDefectMm ? s.minDefectMm + " mm (smaller marks are acceptable; estimate size using the known product size)" : "");
  add("Barcode (FNSKU, UPC or EAN) that must be on the product or its label", s.barcode);
  add("Printed text that must appear on the product, label or packaging, spelled exactly", lines(s.labelText).join("; "));
  const scanned = units.map((u, k) => (u.codes ?? []).filter((c) => !c.startsWith("DC:") && !c.startsWith("DC-")).length ? `photo ${k + 1}: ${(u.codes ?? []).filter((c) => !c.startsWith("DC:") && !c.startsWith("DC-")).join(", ")}` : "").filter(Boolean);
  if (scanned.length) L.push("BARCODES READ BY THE PHONE'S SCANNER (exact): " + scanned.join("; ") + ".");
  const views: string[] = s.views ?? [];
  L.push(`RULES:
- Compare the unit with the references and the standard. Ignore differences caused by lighting, angle, background, reflections or camera color.
- If a photo is blurry, too dark, cropped, or the wrong view so that a safe judgement is impossible, the verdict is RETAKE and photo_quality lists what to fix.
- If you see a possible defect but cannot be sure, the verdict is REVIEW. Never PASS when unsure.
- FAIL if any defect is at or above the rejectable size, or a must-have feature is missing or wrong.
- Photos cannot measure size precisely: mark size checks "unclear" unless something in the photo gives a scale.
- Every defect gets a "code" from this list (use the closest; OTH only if nothing fits): ${codeList(arrival ? ["product", "label", "packaging", "carton"] : ["product", "label", "packaging"])}.
- Include one check for each must-have line, each in-the-box item and each watch-for item, plus color and finish.${s.barcode ? `
- Add a check "Barcode": pass if a barcode or its printed digits visibly match ${s.barcode}; fail if a different code is visible (that is a major defect: wrong label); unclear if no barcode is visible.` : ""}${lines(s.labelText).length ? `
- Add one check per required printed text line: pass if it appears spelled exactly, fail if it is missing or misspelled (a misprint is a major defect), unclear if that part is not shown.` : ""}
- Measuring card: if a printed Defect Check card is visible (a ruler marked 0 to 100 mm with colour squares), use the ruler to measure sizes and defects in mm, so size checks can pass or fail instead of unclear, and use its white and grey squares to judge lighting before judging colour.
- Extra photos: ${views.length ? `the seller has decided that ${views.join(", ")} views are enough for this product. ` : ""}Only ask for another photo when a must-have item or a possible defect genuinely cannot be judged from the photos given, and say exactly what to photograph and why. Never ask just for completeness. If you ask, the verdict cannot be PASS.${arrival ? `
- Shipping condition counts: damaged packaging that the seller sells to customers (retail box, label, seal) is a defect. A crushed or wet outer shipping carton is a defect of severity minor unless the product inside is affected.
- For every defect set "origin":
  "factory" when the same problem is visible in the factory photos of this same unit, the factory check of this same unit lists it, or it is a manufacturing fault that shipping cannot cause (wrong or misprinted label, wrong color, wrong or missing part, molding or assembly fault).
  "transit" when factory photos of this same unit show that part clean, or it is typical shipping and handling damage (crush, dent, puncture, tear, water, breakage, leak, scuffs) and nothing in the factory record or factory photos shows it. A problem that the factory found on OTHER units of the lot is a hint, not proof, for this unit.
  "unclear" when you cannot tell. Factory photos of OTHER units only show how the lot looked; they cannot prove this unit was clean, so lean towards "unclear" unless the type of damage itself makes the origin obvious.
- "origin_summary": one or two plain sentences on where the problems most likely happened and what the evidence is. If there are no defects, say the unit arrived in the same condition it left the factory.` : ""}${zh ? `
- Photo authenticity: these photos were sent by the factory being inspected. Add a check "Photo authenticity": fail if any photo looks like a photo of a screen or of a printed picture, a product render or stock image, or digitally edited or composited; otherwise pass. If it fails, the verdict cannot be PASS (use REVIEW).` : ""}${pick ? `
- Random sample: the system randomly chose carton ${pick.carton}, unit ${pick.unit_pos} for this check. Cartons are marked with their number. Add a check "Carton number": pass if a photo clearly shows carton number ${pick.carton}; fail if a photo shows a different carton number; unclear if no carton number is visible. If it is fail or unclear, the verdict cannot be PASS (use RETAKE if the number is simply not visible, REVIEW if it is a different number).` : ""}
JSON:
{"verdict":"PASS|FAIL|REVIEW|RETAKE","summary":"one or two plain sentences","photo_quality":{"ok":true,"issues":["..."]},"checks":[{"item":"...","result":"pass|fail|unclear","note":"short"}],"defects":[{"code":"SCR","type":"short name","where":"plain location on the product","photo":1,"box":[x,y,w,h],"size_estimate_mm":null,"severity":"critical|major|minor","within_spec":false,"confidence":0.8${arrival ? ',"origin":"factory|transit|unclear","origin_reason":"short"' : ""}}],"more_photos":[{"part":"what to photograph","why":"what it would settle"}]${arrival ? ',"origin_summary":""' : ""}${zh ? ',"zh":{"summary":"","defects":[""],"more":[""]}' : ""}}
${zh ? `"zh" is for factory workers who read Chinese: zh.summary is the summary in simplified Chinese; zh.defects has one simplified-Chinese line per defect, same order, written as "问题 — 位置"; zh.more has one line per more_photos item, same order, written as "拍什么 — 原因".
` : ""}"photo" is the 1-based index among the UNIT photos only (never the reference or factory photos). "box" is the approximate region in that photo as fractions 0–1 (x, y = top-left), or null. Use [] when there are no defects and [] for more_photos when the photos are enough.`);
  return L.join("\n");
}

// ---------- result handling ----------
export function normalize(r: any, nUnits: number, arrival = false) {
  const V = ["PASS", "FAIL", "REVIEW", "RETAKE"]; let v = String(r?.verdict ?? "").toUpperCase(); if (!V.includes(v)) v = "REVIEW";
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const defects = (Array.isArray(r?.defects) ? r.defects : []).slice(0, 12).map((d: any) => ({
    code: asCode(d.code), type: String(d.type || "Defect"), where: String(d.where || ""), photo: Math.min(nUnits, Math.max(1, +d.photo || 1)),
    box: Array.isArray(d.box) && d.box.length === 4 && d.box.every((n: any) => isFinite(n)) ? d.box.map((n: any) => clamp(+n)) : null,
    size: d.size_estimate_mm == null ? null : +d.size_estimate_mm, severity: ["critical", "major", "minor"].includes(d.severity) ? d.severity : "major",
    inSpec: !!d.within_spec, conf: clamp(+d.confidence || 0),
    ...(arrival ? { origin: ["factory", "transit", "unclear"].includes(d.origin) ? d.origin : "unclear", originWhy: String(d.origin_reason || "").slice(0, 200) } : {}),
  }));
  const checks = (Array.isArray(r?.checks) ? r.checks : []).slice(0, 30).map((c: any) => ({ item: String(c.item || ""), result: ["pass", "fail", "unclear"].includes(c.result) ? c.result : "unclear", note: String(c.note || "") }));
  const more = (Array.isArray(r?.more_photos) ? r.more_photos : []).filter((m: any) => m?.part).slice(0, 5).map((m: any) => ({ part: String(m.part).slice(0, 80), why: String(m.why || "").slice(0, 140) }));
  if (v === "PASS" && (defects.some((d: any) => !d.inSpec) || checks.some((c: any) => c.result === "fail") || more.length)) v = "REVIEW";
  const pq = r?.photo_quality ?? {};
  const out: any = { verdict: v, summary: String(r?.summary || ""), photoOk: pq.ok !== false, photoIssues: (Array.isArray(pq.issues) ? pq.issues : []).map(String).slice(0, 6), checks, defects, more };
  if (arrival) out.originSummary = String(r?.origin_summary || "").slice(0, 600);
  if (r?.zh && typeof r.zh === "object") {
    const arr = (x: any, n: number) => (Array.isArray(x) ? x : []).slice(0, n).map((t: any) => String(t ?? "").slice(0, 200));
    out.zh = { summary: String(r.zh.summary ?? "").slice(0, 400), defects: arr(r.zh.defects, defects.length), more: arr(r.zh.more, more.length) };
  }
  return out;
}
// Where the problems found on arrival most likely happened, from the out-of-spec findings.
export function damageOrigin(ai: any): string {
  const o = new Set((ai.defects ?? []).filter((d: any) => !d.inSpec).map((d: any) => d.origin || "unclear"));
  if (!o.size) return ai.verdict === "PASS" ? "none" : "unclear";
  if (o.has("factory") && o.has("transit")) return "both";
  if (o.has("factory")) return "factory";
  if (o.has("transit")) return "transit";
  return "unclear";
}
const RANK: Record<string, number> = { FAIL: 4, REVIEW: 3, RETAKE: 2, PASS: 1 };
export function merge(parts: { ai: any; offset: number }[]) {
  if (parts.length === 1) return parts[0].ai;
  const out: any = { verdict: "PASS", summary: "", photoOk: true, photoIssues: [], checks: [], defects: [], more: [] };
  const ck = new Map<string, any>(), RES: Record<string, number> = { fail: 3, pass: 2, unclear: 1 };
  for (const { ai, offset } of parts) {
    if (RANK[ai.verdict] > RANK[out.verdict]) out.verdict = ai.verdict;
    out.summary += (out.summary ? " " : "") + ai.summary; out.photoOk = out.photoOk && ai.photoOk; out.photoIssues.push(...ai.photoIssues);
    ai.defects.forEach((d: any) => out.defects.push({ ...d, photo: d.photo + offset }));
    ai.checks.forEach((c: any) => { const k = c.item.toLowerCase().trim(), o = ck.get(k); if (!o || RES[c.result] > RES[o.result]) ck.set(k, c); });
    (ai.more ?? []).forEach((m: any) => { if (!out.more.some((x: any) => x.part.toLowerCase() === m.part.toLowerCase())) out.more.push(m); });
    if (ai.originSummary !== undefined) out.originSummary = (out.originSummary ? out.originSummary + " " : "") + ai.originSummary;
    if (ai.zh) {
      out.zh ??= { summary: "", defects: [], more: [] };
      out.zh.summary += ai.zh.summary;
      ai.defects.forEach((_: any, k: number) => out.zh.defects.push(ai.zh.defects[k] ?? ""));
      (ai.more ?? []).forEach((m: any, k: number) => { if (out.more.includes(m)) out.zh.more[out.more.indexOf(m)] = ai.zh.more[k] ?? ""; });
    }
  }
  out.checks = [...ck.values()];
  return out;
}
function refPool(photos: Photo[]) {
  return [...photos.filter((x) => x.origin !== "official"), ...photos.filter((x) => x.origin === "official" && !["spec_or_text", "document", "other"].includes(x.kind ?? ""))];
}

// ---------- scanner results: barcode and carton label (deterministic, on top of the AI) ----------
const normCode = (c: string) => String(c ?? "").replace(/\s+/g, "").toUpperCase();
export function applyCodeChecks(ai: any, spec: any, units: Photo[], pick: { carton: number } | null, sessionId: string | null) {
  const codes = [...new Set(units.flatMap((u) => u.codes ?? []).map(String))];
  const setCheck = (item: string, result: string, note: string) => {
    ai.checks = (ai.checks ?? []).filter((c: any) => c.item.toLowerCase() !== item.toLowerCase());
    ai.checks.unshift({ item, result, note });
  };
  const want = normCode(spec?.barcode ?? "");
  const products = codes.filter((c) => !c.startsWith("DC:") && !c.startsWith("DC-"));
  if (want && products.length) {
    if (products.some((c) => normCode(c) === want)) setCheck("Barcode", "pass", `Scanner read ${want}.`);
    else {
      setCheck("Barcode", "fail", `Expected ${want}, scanner read ${products.join(", ")}.`);
      ai.defects = [{ code: "BCD", type: "Wrong barcode", where: "barcode label", photo: 1, box: null, size: null, severity: "major", inSpec: false, conf: 1 }, ...(ai.defects ?? [])];
      ai.verdict = "FAIL";
    }
  }
  const labels = codes.filter((c) => c.startsWith("DC:")).map((c) => c.split(":"));
  if (pick && labels.length) {
    const short = String(sessionId ?? "").slice(0, 8);
    const ok = labels.some((x) => x[1] === short && +x[2] === pick.carton);
    if (ok) setCheck("Carton label", "pass", `QR label confirms carton ${pick.carton}.`);
    else {
      const seen = labels.map((x) => (x[1] === short ? `carton ${x[2]}` : "a label from another lot")).join(", ");
      setCheck("Carton label", "fail", `Asked for carton ${pick.carton}, QR label shows ${seen}.`);
      if (ai.verdict === "PASS") ai.verdict = "REVIEW";
    }
  }
}

// ---------- factory evidence for arrival checks ----------
const finalOf = (r: any) => r?.decision?.final ?? r?.verdict ?? "unchecked";
function findingLine(r: any) {
  const d = (r?.ai?.defects ?? []).filter((x: any) => !x.inSpec).map((x: any) => `${x.type}${x.where ? ` (${x.where})` : ""}`);
  return d.length ? d.join("; ") : "no defects found";
}
export async function factoryEvidence(sb: SupabaseClient, ins: any): Promise<Before> {
  const ev: Before = { photos: [], sameUnit: false, origin: null, text: [] };
  if (ins.origin_id) {
    const { data } = await sb.from("inspections").select("*").eq("id", ins.origin_id).maybeSingle();
    if (data) ev.origin = data;
  }
  let lot: any[] = [];
  if (ins.product_id && ins.lot) {
    const { data } = await sb.from("inspections").select("*").eq("workspace_id", ins.workspace_id).eq("product_id", ins.product_id)
      .eq("lot", ins.lot).eq("stage", "factory").eq("status", "done").order("created_at", { ascending: false }).limit(100);
    lot = data ?? [];
    if (!ev.origin && ins.unit) ev.origin = lot.find((r) => (r.unit ?? "").trim().toLowerCase() === String(ins.unit).trim().toLowerCase()) ?? null;
  }
  const usable = (r: any) => (r.photos ?? []).filter((x: Photo) => x.quality !== "wrong_product");
  if (ev.origin) {
    ev.sameUnit = true;
    ev.photos = usable(ev.origin);
    ev.text.push(`This same unit${ev.origin.unit ? ` (unit ${ev.origin.unit})` : ""} was checked at the factory on ${String(ev.origin.created_at).slice(0, 10)}. Result: ${finalOf(ev.origin)}. Factory findings: ${findingLine(ev.origin)}.`);
  }
  if (lot.length) {
    const count: Record<string, number> = {};
    lot.forEach((r) => { const f = finalOf(r); count[f] = (count[f] ?? 0) + 1; });
    const types: Record<string, number> = {};
    lot.forEach((r) => (r.ai?.defects ?? []).filter((x: any) => !x.inSpec).forEach((x: any) => { types[x.type] = (types[x.type] ?? 0) + 1; }));
    const top = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, k]) => `${t} ×${k}`);
    ev.text.push(`The factory checked ${lot.length} unit${lot.length > 1 ? "s" : ""} of lot ${ins.lot}: ${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(", ")}.${top.length ? ` Factory findings in this lot: ${top.join(", ")}.` : " No defects were found at the factory in this lot."}`);
    if (!ev.origin) {
      // Photos of units from the same lot that passed at the factory: how the lot looked when it left.
      const passed = lot.filter((r) => finalOf(r) === "PASS");
      const seen = new Set<string>();
      for (const r of passed) for (const ph of usable(r)) { const k = ph.view || ph.part || ph.path; if (!seen.has(k) && ev.photos.length < 6) { seen.add(k); ev.photos.push(ph); } }
    }
  } else if (!ev.origin) {
    ev.text.push(ins.lot ? `No factory check was found for lot ${ins.lot}.` : "No lot number was given, so no factory check could be matched.");
  }
  return ev;
}

// ---------- tasks ----------
async function taskInspect(sb: SupabaseClient, inspectionId: string) {
  const { data: ins, error } = await sb.from("inspections").select("*").eq("id", inspectionId).single();
  if (error || !ins) throw new Error("Inspection not found");
  const product = ins.product_id ? (await sb.from("products").select("*").eq("id", ins.product_id).single()).data : null;
  const p = { name: ins.product_name, sku: product?.sku, source_url: product?.source_url, spec: ins.spec_snapshot ?? product?.spec ?? {} };
  await sb.from("inspections").update({ status: "running", error: null }).eq("id", inspectionId);
  try {
    const units: Photo[] = (ins.photos ?? []).filter((x: Photo) => x.quality !== "wrong_product");
    if (!units.length) throw new Error("No photos to check");
    const arrival = ins.stage === "arrival";
    const ev = arrival ? await factoryEvidence(sb, ins) : null;
    const pick = ins.pick_id ? (await sb.from("factory_picks").select("carton, unit_pos").eq("id", ins.pick_id).maybeSingle()).data : null;
    // photos carry the codes the phone scanned
    const pool = refPool(product?.photos ?? []);
    const beforeCap = ev ? Math.min(ev.photos.length, 4) : 0;
    const refCap = Math.min(pool.length, arrival ? 3 : 4, MAX_IMAGES - beforeCap - 1), per = Math.max(1, MAX_IMAGES - refCap - beforeCap);
    const parts: { ai: any; offset: number }[] = [];
    const model = ins.careful ? MODEL_CAREFUL : MODEL_INSPECT;
    const byView = (list: Photo[], want: Set<string | undefined>) => [...list.filter((r) => want.has(r.view)), ...list.filter((r) => !want.has(r.view))];
    for (let i = 0; i < units.length; i += per) {
      const batch = units.slice(i, i + per);
      const want = new Set(batch.map((u) => u.view).filter(Boolean));
      const before = ev ? byView(ev.photos, want).slice(0, Math.min(beforeCap, MAX_IMAGES - batch.length)) : [];
      const refs = byView(pool, want).slice(0, Math.max(0, Math.min(refCap, MAX_IMAGES - batch.length - before.length)));
      const imgs = await loadImages(sb, [...refs, ...before, ...batch].map((x) => x.path));
      const r = await askJson(inspectPrompt(p, refs, batch, units, before, ev, !!ins.factory_link_id, pick), imgs, model, 6000);
      parts.push({ ai: normalize(r, batch.length, arrival), offset: i });
    }
    const ai = merge(parts);
    applyCodeChecks(ai, p.spec, units, pick, ins.session_id);
    const extra: Record<string, unknown> = {};
    if (arrival) {
      extra.damage_origin = damageOrigin(ai);
      if (ev?.origin && !ins.origin_id) extra.origin_id = ev.origin.id;
      ai.factory = { matched: !!ev?.origin, sameUnit: !!ev?.sameUnit, photos: ev?.photos.length ?? 0, record: ev?.text ?? [] };
    }
    const { data: done } = await sb.from("inspections").update({ status: "done", ai, verdict: ai.verdict, model, checked_at: new Date().toISOString(), ...extra }).eq("id", inspectionId).select().single();
    return done;
  } catch (e) {
    await sb.from("inspections").update({ status: "error", error: String((e as Error).message ?? e).slice(0, 500) }).eq("id", inspectionId);
    throw e;
  }
}

function isPublicHttpUrl(raw: string) {
  let u: URL; try { u = new URL(raw); } catch { return false; }
  if (!["http:", "https:"].includes(u.protocol)) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":")) return false;
  return true;
}
function pageText(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
function pageImages(html: string, base: string): string[] {
  const out: string[] = [];
  const push = (s?: string) => { if (!s) return; try { const u = new URL(s.replace(/&amp;/g, "&"), base).toString(); if (!out.includes(u)) out.push(u); } catch { /* skip */ } };
  for (const m of html.matchAll(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(m[1]); const items = Array.isArray(j) ? j : [j, ...(j["@graph"] ?? [])]; for (const it of items) { const im = it?.image; (Array.isArray(im) ? im : [im]).forEach((x: any) => push(typeof x === "string" ? x : x?.url)); } } catch { /* skip */ }
  }
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)) { const s = m[1]; if (/product|cdn\/shop|images\/I\/|media/i.test(s) && !/logo|icon|sprite|\.svg/i.test(s)) push(s.startsWith("//") ? "https:" + s : s); }
  return out.filter((u) => /^https?:/.test(u)).slice(0, 12);
}
async function taskImportUrl(sb: SupabaseClient, workspaceId: string, url: string) {
  if (!isPublicHttpUrl(url)) throw new Error("That link can't be opened. Use a public http(s) product page.");
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (DefectCheck importer)", "Accept": "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error(`The page returned ${res.status}. Paste the listing text or add screenshots instead.`);
  const html = (await res.text()).slice(0, 2_000_000);
  const text = pageText(html).slice(0, 40000);
  const saved: Photo[] = []; const imgs: Img[] = [];
  for (const src of pageImages(html, res.url)) {
    if (saved.length >= 6) break;
    if (!isPublicHttpUrl(src)) continue;
    try {
      const r = await fetch(src); if (!r.ok) continue;
      const type = (r.headers.get("content-type") ?? "").split(";")[0];
      if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) continue;
      const buf = await r.arrayBuffer(); if (buf.byteLength < 8000 || buf.byteLength > 4_500_000) continue;
      const path = `${workspaceId}/official/${crypto.randomUUID()}.${type.split("/")[1].replace("jpeg", "jpg")}`;
      const up = await sb.storage.from("photos").upload(path, new Blob([buf], { type }), { contentType: type });
      if (up.error) continue;
      saved.push({ path, origin: "official", view: "", part: "", kind: "" }); imgs.push({ data: b64(buf), media_type: type });
    } catch { /* skip image */ }
  }
  const fields = await askJson(listingPrompt(res.url, text, imgs.length), imgs, MODEL_INSPECT);
  (Array.isArray(fields.images) ? fields.images : []).forEach((im: any) => { const ph = saved[(+im.index || 0) - 1]; if (!ph) return; if (["product_photo", "spec_or_text", "lifestyle", "other"].includes(im.kind)) ph.kind = im.kind; if (VIEWS.includes(im.view)) ph.view = im.view; });
  return { fields, photos: saved, listing_text: text.slice(0, 20000), final_url: res.url };
}

// ---------- identify (shared) ----------
async function identifyPaths(sb: SupabaseClient, product: any, pathsIn: string[]) {
  const paths = pathsIn.slice(0, 40); const out: any[] = [];
  for (let i = 0; i < paths.length; i += MAX_IMAGES) {
    const chunk = paths.slice(i, i + MAX_IMAGES);
    const r = await askJson(identifyPrompt(product, chunk.length), await loadImages(sb, chunk), MODEL_QUICK, 2000);
    (r.photos ?? []).forEach((x: any) => out.push({ ...x, index: (+x.index || 0) + i }));
  }
  return out;
}

// ---------- factory links (no account; token-scoped) ----------
class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
async function openLink(admin: SupabaseClient, token: string) {
  if (!/^[a-f0-9]{48,80}$/.test(token)) throw new HttpError(404, "This link is not valid.");
  const { data: link } = await admin.from("factory_links").select("*").eq("token", token).maybeSingle();
  if (!link) throw new HttpError(404, "This link is not valid.");
  if (!link.active) throw new HttpError(410, "The buyer has closed this link.");
  if (new Date(link.expires_at).getTime() < Date.now()) throw new HttpError(410, "This link has expired. Ask the buyer for a new one.");
  const { data: product } = await admin.from("products").select("*").eq("id", link.product_id).maybeSingle();
  if (!product) throw new HttpError(410, "The buyer removed this product.");
  return { link, product };
}
const linkPrefix = (link: any) => `${link.workspace_id}/factory/${link.id}/`;
function ownPaths(link: any, paths: unknown): string[] {
  const pre = linkPrefix(link);
  const list = (Array.isArray(paths) ? paths : []).map(String);
  if (list.some((x) => !x.startsWith(pre) || x.includes(".."))) throw new HttpError(403, "Photo does not belong to this link.");
  return list;
}
async function signMap(admin: SupabaseClient, paths: string[]) {
  const m: Record<string, string> = {};
  const uniq = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 100) {
    const { data } = await admin.storage.from("photos").createSignedUrls(uniq.slice(i, i + 100), 60 * 60 * 6);
    (data ?? []).forEach((x: any) => { if (x.signedUrl && x.path) m[x.path] = x.signedUrl; });
  }
  return m;
}
function publicUnit(r: any) {
  const a = r.ai ?? null;
  return { id: r.id, unit: r.unit ?? "", status: r.status, verdict: r.verdict, error: r.status === "error" ? r.error : null, created_at: r.created_at, submitted_by: r.submitted_by ?? "",
    photos: (r.photos ?? []).map((p: Photo) => ({ path: p.path, view: p.view ?? "", part: p.part ?? "" })),
    ai: a ? { verdict: a.verdict, summary: a.summary, photoOk: a.photoOk, photoIssues: a.photoIssues ?? [], checks: a.checks ?? [], defects: a.defects ?? [], more: a.more ?? [], zh: a.zh ?? null } : null };
}
async function latestSession(admin: SupabaseClient, link: any) {
  const { data } = await admin.from("factory_sessions").select("*").eq("link_id", link.id).neq("status", "cancelled").order("created_at", { ascending: false }).limit(1);
  if (!data || !data.length) return null;
  let ses = data[0];
  if (ses.status === "sampling") {
    const { count } = await admin.from("factory_picks").select("id", { count: "exact", head: true }).eq("session_id", ses.id).in("status", ["pending", "issued", "checking"]);
    if (!count) return await finalize(admin, ses);
  }
  return await sessionState(admin, ses);
}
// ---------- sampling (ANSI/ASQ Z1.4 single sampling, general level II, AQL 2.5 for major defects) ----------
const AQL: [number, number, number][] = [[50, 8, 0], [90, 13, 1], [150, 20, 1], [280, 32, 2], [500, 50, 3], [1200, 80, 5], [3200, 125, 7], [10000, 200, 10], [35000, 315, 14], [Infinity, 500, 21]];
export function aqlPlan(lot: number) { const row = AQL.find((r) => lot <= r[0])!; return { n: Math.min(row[1], lot), ac: row[2] }; }
function randInt(max: number) { const a = new Uint32Array(1); const lim = Math.floor(0x100000000 / max) * max; do crypto.getRandomValues(a); while (a[0] >= lim); return a[0] % max; }
export function randomSample(total: number, n: number): number[] {
  const out: number[] = [], seen = new Set<number>();
  while (out.length < n) { const u = randInt(total) + 1; if (!seen.has(u)) { seen.add(u); out.push(u); } }
  return out;
}
const newToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function activeSession(admin: SupabaseClient, link: any) {
  const { data } = await admin.from("factory_sessions").select("*").eq("link_id", link.id).eq("status", "sampling").order("created_at", { ascending: false }).limit(1);
  if (!data || !data.length) throw new HttpError(409, "Start the inspection first: enter the lot size.");
  return data[0];
}
// Draw one more random unit that has not been picked yet (after a missed or unreadable pick).
async function addReplacement(admin: SupabaseClient, ses: any, known?: any[]) {
  const all = known ?? ((await admin.from("factory_picks").select("seq, carton, unit_pos").eq("session_id", ses.id)).data ?? []);
  const used = new Set(all.map((x: any) => (x.carton - 1) * ses.units_per_carton + x.unit_pos));
  if (used.size >= ses.total_units) return null;
  let u = 0; do u = randInt(ses.total_units) + 1; while (used.has(u));
  const seq = Math.max(0, ...all.map((x: any) => x.seq)) + 1;
  const { data } = await admin.from("factory_picks").insert({ session_id: ses.id, workspace_id: ses.workspace_id, seq, carton: Math.floor((u - 1) / ses.units_per_carton) + 1, unit_pos: ((u - 1) % ses.units_per_carton) + 1 }).select().single();
  return data;
}
// The issued pick, or the next one. A pick whose window ran out is recorded as missed and replaced by a new random unit.
async function currentPick(admin: SupabaseClient, ses: any): Promise<any> {
  const { data: picks } = await admin.from("factory_picks").select("*").eq("session_id", ses.id).order("seq");
  const all = picks ?? [];
  const now = Date.now();
  for (const pk of all.filter((x: any) => x.status === "issued")) {
    if (now <= new Date(pk.expires_at).getTime() + PICK_GRACE_S * 1000) return pk;
    await admin.from("factory_picks").update({ status: "missed", token: null }).eq("id", pk.id);
    pk.status = "missed";
    const added = await addReplacement(admin, ses, all);
    if (added) all.push(added);
  }
  const next = all.filter((x: any) => x.status === "pending").sort((a: any, b: any) => a.seq - b.seq)[0];
  if (!next) return null;
  const { data: issued } = await admin.from("factory_picks").update({ status: "issued", token: newToken(), issued_at: new Date().toISOString(), expires_at: new Date(now + ses.window_seconds * 1000).toISOString() }).eq("id", next.id).eq("status", "pending").select().single();
  return issued;
}
const publicPick = (pk: any, ses: any) => ({ seq: pk.seq, carton: pk.carton, unit_pos: pk.unit_pos, token: pk.token, expires_at: pk.expires_at, attempts: pk.attempts, of: ses.sample_size });
async function sessionState(admin: SupabaseClient, ses: any) {
  const { data: picks } = await admin.from("factory_picks").select("status, verdict").eq("session_id", ses.id);
  const c = (f: (x: any) => boolean) => (picks ?? []).filter(f).length;
  return { id: ses.id, total_units: ses.total_units, cartons: ses.cartons, units_per_carton: ses.units_per_carton, sample_size: ses.sample_size, window_seconds: ses.window_seconds,
    status: ses.status, result: ses.result, done: c((x) => x.status === "done"), checking: c((x) => x.status === "checking"), missed: c((x) => x.status === "missed"), failed: c((x) => x.status === "done" && x.verdict === "FAIL") };
}
async function finalize(admin: SupabaseClient, ses: any) {
  if (ses.status === "sampling") {
    const { data: picks } = await admin.from("factory_picks").select("status, verdict, inspection_id").eq("session_id", ses.id);
    const done = (picks ?? []).filter((x: any) => x.status === "done");
    const ids = done.map((x: any) => x.inspection_id).filter(Boolean);
    const { data: ins } = ids.length ? await admin.from("inspections").select("ai").in("id", ids) : { data: [] as any[] };
    const critical = (ins ?? []).some((r: any) => (r.ai?.defects ?? []).some((d: any) => !d.inSpec && d.severity === "critical"));
    const fails = done.filter((x: any) => x.verdict === "FAIL").length;
    const unsure = done.filter((x: any) => x.verdict !== "PASS" && x.verdict !== "FAIL").length + (picks ?? []).filter((x: any) => x.status === "missed").length;
    const result = critical || fails > ses.accept_major ? "FAIL" : unsure ? "REVIEW" : "PASS";
    const { data: upd } = await admin.from("factory_sessions").update({ status: "done", result, finished_at: new Date().toISOString() }).eq("id", ses.id).eq("status", "sampling").select().single();
    if (upd) ses = upd;
  }
  return await sessionState(admin, ses);
}

async function factoryTask(task: string, body: any) {
  if (!SERVICE_KEY) throw new HttpError(500, "Server is missing SUPABASE_SERVICE_ROLE_KEY.");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false } });
  const { link, product } = await openLink(admin, String(body?.token ?? ""));
  if (task === "factory_open") {
    const { data: rows } = await admin.from("inspections").select("*").eq("factory_link_id", link.id).order("created_at", { ascending: false }).limit(300);
    const s = product.spec ?? {};
    const refs = refPool(product.photos ?? []).slice(0, 8);
    const units = (rows ?? []).map(publicUnit);
    const urls = await signMap(admin, [...refs.map((r) => r.path), ...units.flatMap((u: any) => u.photos.map((p: any) => p.path))]);
    return {
      link: { lot: link.lot, factory_name: link.factory_name ?? "", expires_at: link.expires_at, max_units: link.max_units, prefix: linkPrefix(link) },
      product: { name: product.name, sku: product.sku ?? "", version: product.version,
        spec: { barcode: s.barcode ?? "", labelText: s.labelText ?? "", material: s.material ?? "", colors: s.colors ?? "", finish: s.finish ?? "", dims: s.dims ?? {}, tol: s.tol ?? "", packaging: s.packaging ?? "", inBox: s.inBox ?? "", goodLooks: s.goodLooks ?? "", mustHave: s.mustHave ?? "", allowed: s.allowed ?? "", watch: s.watch ?? [], minDefectMm: s.minDefectMm ?? "", views: s.views ?? [] },
        photos: refs.map((r) => ({ path: r.path, view: r.view ?? "", part: r.part ?? "", origin: r.origin ?? "unit" })) },
      units, urls, session: await latestSession(admin, link),
    };
  }
  if (task === "factory_session_start") {
    const total = Math.floor(+body.total_units), cartons = Math.floor(+body.cartons), per = Math.floor(+body.units_per_carton);
    if (!(total >= 1 && total <= 500000 && cartons >= 1 && per >= 1)) throw new HttpError(400, "Enter the total units, number of cartons and units per carton.");
    if (total > cartons * per || total <= (cartons - 1) * per) throw new HttpError(400, `${cartons} cartons of ${per} cannot hold ${total} units. Check the numbers.`);
    const { data: existing } = await admin.from("factory_sessions").select("id, status").eq("link_id", link.id).in("status", ["sampling", "done"]).limit(1);
    if (existing && existing.length) throw new HttpError(409, "This lot is already locked. Ask the buyer if it needs to be inspected again.");
    const plan = aqlPlan(total);
    const { data: ses, error } = await admin.from("factory_sessions").insert({ link_id: link.id, workspace_id: link.workspace_id, product_id: link.product_id, lot: link.lot,
      total_units: total, cartons, units_per_carton: per, sample_size: plan.n, accept_major: plan.ac }).select().single();
    if (error || !ses) throw new HttpError(500, "Could not lock the lot: " + (error?.message ?? ""));
    const idx = randomSample(total, plan.n);
    const rows = idx.map((u, k) => ({ session_id: ses.id, workspace_id: link.workspace_id, seq: k + 1, carton: Math.floor((u - 1) / per) + 1, unit_pos: ((u - 1) % per) + 1 }));
    for (let i = 0; i < rows.length; i += 200) { const { error: e2 } = await admin.from("factory_picks").insert(rows.slice(i, i + 200)); if (e2) throw new HttpError(500, "Could not draw the sample: " + e2.message); }
    return { session: await sessionState(admin, ses) };
  }
  if (task === "factory_pick_next") {
    const ses = await activeSession(admin, link);
    const cur = await currentPick(admin, ses);
    if (cur) return { session: await sessionState(admin, ses), pick: publicPick(cur, ses) };
    const { count } = await admin.from("factory_picks").select("id", { count: "exact", head: true }).eq("session_id", ses.id).eq("status", "checking");
    return { session: count ? await sessionState(admin, ses) : await finalize(admin, ses) };
  }
  const pickOf = async () => {
    const ses = await activeSession(admin, link);
    const { data: pk } = await admin.from("factory_picks").select("*").eq("session_id", ses.id).eq("token", String(body.pick_token ?? "")).eq("status", "issued").maybeSingle();
    if (!pk) throw new HttpError(409, "This unit's photo window is closed. Tap Next unit.");
    if (Date.now() > new Date(pk.expires_at).getTime() + PICK_GRACE_S * 1000) throw new HttpError(409, "Time ran out for this unit. It has been recorded as missed. Tap Next unit.");
    return { ses, pk, folder: `${linkPrefix(link)}picks/${pk.id}/` };
  };
  if (task === "factory_upload") {
    const { pk, folder } = await pickOf();
    if (Date.now() > new Date(pk.expires_at).getTime()) throw new HttpError(409, "Time ran out for this unit. Tap Next unit.");
    const path = `${folder}${crypto.randomUUID()}.jpg`;
    const { data, error } = await admin.storage.from("photos").createSignedUploadUrl(path);
    if (error || !data) throw new HttpError(500, "Could not prepare the upload: " + (error?.message ?? ""));
    return { uploads: [{ path, token: data.token }] };
  }
  if (task === "factory_identify") {
    const { folder } = await pickOf();
    const paths = (Array.isArray(body.paths) ? body.paths : []).map(String).slice(0, MAX_FACTORY_PHOTOS);
    if (paths.some((x: string) => !x.startsWith(folder) || x.includes(".."))) throw new HttpError(403, "Photo does not belong to this unit.");
    return { photos: await identifyPaths(admin, { name: product.name, colors: product.spec?.colors }, paths) };
  }
  if (task === "factory_submit") {
    const { ses, pk, folder } = await pickOf();
    const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, MAX_FACTORY_PHOTOS)
      .map((p: any) => ({ path: String(p?.path ?? ""), view: String(p?.view ?? "").slice(0, 30), part: String(p?.part ?? "").slice(0, 40), quality: String(p?.quality ?? "").slice(0, 20),
        codes: (Array.isArray(p?.codes) ? p.codes : []).slice(0, 6).map((c: any) => String(c).slice(0, 80)) }));
    if (!photos.length) throw new HttpError(400, "Take at least one photo.");
    if (photos.some((p: Photo) => !p.path.startsWith(folder) || p.path.includes(".."))) throw new HttpError(403, "Photo does not belong to this unit.");
    // Every photo must have been uploaded into this pick's folder after the pick was revealed.
    const { data: listed } = await admin.storage.from("photos").list(folder.replace(/\/$/, ""), { limit: 100 });
    const made = new Map((listed ?? []).map((o: any) => [folder + o.name, new Date(o.created_at).getTime()]));
    const issued = new Date(pk.issued_at).getTime() - 5000;
    if (photos.some((p: Photo) => !made.has(p.path) || (made.get(p.path) as number) < issued)) throw new HttpError(403, "Photos must be taken live for this unit.");
    const { data: row, error } = await admin.from("inspections").insert({
      workspace_id: link.workspace_id, product_id: product.id, product_name: product.name, product_version: product.version, spec_snapshot: product.spec,
      lot: link.lot, unit: `C${pk.carton}-U${pk.unit_pos}`, photos, status: "pending", stage: "factory",
      factory_link_id: link.id, submitted_by: String(body.worker ?? "").slice(0, 60) || null, session_id: ses.id, pick_id: pk.id,
    }).select().single();
    if (error || !row) throw new HttpError(500, "Could not save the check: " + (error?.message ?? ""));
    // The unit is handed in: the factory can move to the next pick while the AI checks this one.
    await admin.from("factory_picks").update({ status: "checking", token: null, attempts: pk.attempts + 1, submitted_at: new Date().toISOString(), inspection_id: row.id }).eq("id", pk.id);
    const job = (async () => {
      let done: any = row;
      try { done = await taskInspect(admin, row.id); } catch { done = (await admin.from("inspections").select("*").eq("id", row.id).single()).data ?? row; }
      const verdict = done?.verdict ?? "ERROR";
      await admin.from("factory_picks").update({ status: "done", verdict }).eq("id", pk.id);
      // Photos too poor to judge: draw a replacement random unit so the sample stays full size.
      if (verdict === "RETAKE" || verdict === "ERROR") await addReplacement(admin, ses);
      return done;
    })();
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      EdgeRuntime.waitUntil(job);
      return { accepted: true, unit: publicUnit(row), urls: await signMap(admin, photos.map((p: Photo) => p.path)) };
    }
    const done = await job;
    return { accepted: true, unit: publicUnit(done), urls: await signMap(admin, photos.map((p: Photo) => p.path)) };
  }
  if (task === "factory_units") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 50);
    if (!ids.length) return { units: [], session: await latestSession(admin, link) };
    const { data: rows } = await admin.from("inspections").select("*").eq("factory_link_id", link.id).in("id", ids);
    return { units: (rows ?? []).map(publicUnit), session: await latestSession(admin, link) };
  }
  if (task === "factory_retry") {
    const { data: r } = await admin.from("inspections").select("*").eq("id", String(body.id ?? "")).eq("factory_link_id", link.id).maybeSingle();
    if (!r) throw new HttpError(404, "Check not found.");
    let done: any = r;
    try { done = await taskInspect(admin, r.id); } catch { done = (await admin.from("inspections").select("*").eq("id", r.id).single()).data ?? r; }
    return { unit: publicUnit(done) };
  }
  throw new HttpError(400, "Unknown task");
}

// ---------- purchase orders: factory hub, container loading check, dock receiving ----------
// ISO 6346 container number: 4 letters (owner + category), 6 digits, 1 check digit.
export function iso6346(raw: string) {
  const s = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{4}\d{7}$/.test(s)) return { number: s, valid: false };
  const val = (ch: string) => { if (/\d/.test(ch)) return +ch; let v = 10; for (let c = 65; c < ch.charCodeAt(0); c++) { v++; if (v % 11 === 0) v++; } return v; };
  let sum = 0; for (let i = 0; i < 10; i++) sum += val(s[i]) * 2 ** i;
  return { number: s, valid: (sum % 11) % 10 === +s[10] };
}
const normSeal = (x: unknown) => String(x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const LOAD_STEPS = [
  { key: "empty", en: "Empty container, inside, doors open", zh: "空箱内部（开门拍）", required: true },
  { key: "number", en: "Container number on the door", zh: "箱门上的集装箱号", required: true },
  { key: "half", en: "Half loaded", zh: "装到一半", required: true },
  { key: "full", en: "Fully loaded, doors still open", zh: "装满（关门前）", required: true },
  { key: "marks", en: "Carton shipping marks", zh: "箱唛", required: false },
  { key: "sealed", en: "Doors closed with the seal on", zh: "关门并上封条", required: true },
  { key: "seal", en: "Seal number close-up", zh: "封条号码特写", required: true },
];
const LOAD_WINDOW_H = 12; // a loading check must be finished within this many hours of starting

async function openPo(admin: SupabaseClient, token: string) {
  if (!/^[a-f0-9]{48,80}$/.test(token)) throw new HttpError(404, "This link is not valid.");
  const { data: po } = await admin.from("purchase_orders").select("*").eq("token", token).maybeSingle();
  if (!po || !po.token_active) throw new HttpError(404, "This link is not valid or the buyer has closed it.");
  if (po.closed) throw new HttpError(410, "The buyer has closed this order.");
  const { data: lines } = await admin.from("po_lines").select("*").eq("po_id", po.id).order("seq");
  const pids = (lines ?? []).map((l: any) => l.product_id), lids = (lines ?? []).map((l: any) => l.link_id).filter(Boolean);
  const [{ data: prods }, { data: links }, { data: sess }] = await Promise.all([
    pids.length ? admin.from("products").select("id, name, sku, photos, spec").in("id", pids) : Promise.resolve({ data: [] as any[] }),
    lids.length ? admin.from("factory_links").select("id, token, active, expires_at").in("id", lids) : Promise.resolve({ data: [] as any[] }),
    lids.length ? admin.from("factory_sessions").select("*").in("link_id", lids).neq("status", "cancelled").order("created_at", { ascending: false }) : Promise.resolve({ data: [] as any[] }),
  ]);
  return { po, lines: lines ?? [], prods: prods ?? [], links: links ?? [], sess: sess ?? [] };
}
async function latestLoading(admin: SupabaseClient, poId: string) {
  const { data } = await admin.from("loading_checks").select("*").eq("po_id", poId).neq("status", "cancelled").order("started_at", { ascending: false }).limit(1);
  return data && data.length ? data[0] : null;
}
const loadPrefix = (lc: any) => `${lc.workspace_id}/loading/${lc.id}/`;
function publicLoading(lc: any) {
  if (!lc) return null;
  return { id: lc.id, status: lc.status, result: lc.result, container_no: lc.container_no ?? "", seal_no: lc.seal_no ?? "", container_no_read: lc.container_no_read ?? "", seal_no_read: lc.seal_no_read ?? "",
    container_no_valid: lc.container_no_valid, counts: lc.counts ?? {}, photos: lc.photos ?? [], error: lc.status === "error" ? lc.error : null, started_at: lc.started_at, submitted_at: lc.submitted_at,
    expires_at: new Date(new Date(lc.started_at).getTime() + LOAD_WINDOW_H * 3600e3).toISOString(),
    ai: lc.ai ? { summary: lc.ai.summary ?? "", zh: lc.ai.zh ?? null, issues: lc.ai.issues ?? [], checks: lc.ai.checks ?? [], defects: lc.ai.defects ?? [] } : null };
}

function loadingPrompt(po: any, lines: any[], prods: any[], steps: string[], lc: any) {
  const name = (pid: string) => prods.find((p: any) => p.id === pid)?.name ?? "product";
  const L: string[] = [];
  L.push(`You are a container loading supervisor working for a US importer. The factory loaded a shipping container for purchase order ${po.po_number}${po.supplier_name ? ` from ${po.supplier_name}` : ""} and photographed each stage. Check that the container was sound, that the right goods went in, that they were loaded properly, and that the container was sealed.`);
  L.push(`The ${steps.length} photos, numbered 1 to ${steps.length}, are in this order: ${steps.map((k, i) => `photo ${i + 1} = ${LOAD_STEPS.find((x) => x.key === k)?.en ?? k}`).join("; ")}.`);
  L.push("PACKING LIST (what should be in the container):");
  lines.forEach((l: any) => L.push(`- ${name(l.product_id)}: ${l.qty} units in ${l.cartons} cartons of ${l.units_per_carton}; factory says ${lc.counts?.[l.id] ?? "?"} cartons loaded.`));
  L.push(`The factory typed container number "${lc.container_no ?? ""}" and seal number "${lc.seal_no ?? ""}".`);
  L.push(`RULES:
- Read the container number exactly as painted on the door or side (4 letters, 6 digits, 1 check digit, often with the check digit in a box). Read the seal number exactly as printed on the seal. Use "" if you cannot read it.
- Empty container: look for holes (daylight through walls or roof), dents that reduce space, broken doors or door seals, wet or dirty floor, rust, smells you cannot judge (ignore), old labels or debris.
- Loading: cartons stacked squarely, heavy on the bottom, no crushed or torn cartons, gaps braced or filled, nothing leaning against the doors.
- Carton marks: if visible, they should name this buyer's PO or products. Marks for a different order or product are a problem.
- Half loaded and fully loaded photos must show the same container as the empty photo (same interior, same door markings when visible). If they look like different containers, say so.
- Doors closed with a bolt or cable seal through the door locking bar; the seal looks intact.
- Photo authenticity: fail if any photo looks like a photo of a screen or print, a stock image or render, or edited.
- Each problem is a defect with a "code" from this list: ${codeList(["container", "carton"])}.
- Judge only what the photos show. Use "unclear" when a photo does not show something.
JSON:
{"container_no_read":"","seal_no_read":"","summary":"one or two plain sentences","checks":[{"item":"Container sound and clean","result":"pass|fail|unclear","note":"short"},{"item":"Same container in every photo","result":"pass|fail|unclear","note":""},{"item":"Loading and stowage","result":"pass|fail|unclear","note":""},{"item":"Carton marks","result":"pass|fail|unclear","note":""},{"item":"Doors sealed","result":"pass|fail|unclear","note":""},{"item":"Photo authenticity","result":"pass|fail|unclear","note":""}],"defects":[{"code":"CNT","type":"short name","where":"plain location","photo":1,"box":[0.1,0.2,0.3,0.3],"severity":"critical|major|minor","confidence":0.8}],"zh":{"summary":"the summary in simplified Chinese","defects":["one Chinese line per defect, same order, as 问题 — 位置"]}}
"box" is the region in that photo as fractions 0–1 (x, y = top-left), or null. Use [] when there are no defects.`);
  return L.join("\n");
}

async function runLoadingCheck(admin: SupabaseClient, lcId: string) {
  const { data: lc } = await admin.from("loading_checks").select("*").eq("id", lcId).single();
  const { data: po } = await admin.from("purchase_orders").select("*").eq("id", lc.po_id).single();
  const { data: lines } = await admin.from("po_lines").select("*").eq("po_id", po.id).order("seq");
  const pids = (lines ?? []).map((l: any) => l.product_id);
  const { data: prods } = pids.length ? await admin.from("products").select("id, name").in("id", pids) : { data: [] as any[] };
  try {
    // At most 2 photos per stage, in stage order, within the per-call image limit.
    const chosen: any[] = [];
    for (const st of LOAD_STEPS) chosen.push(...(lc.photos ?? []).filter((p: any) => p.step === st.key).slice(0, 2));
    const use = chosen.slice(0, MAX_IMAGES);
    const r = await askJson(loadingPrompt(po, lines ?? [], prods ?? [], use.map((p) => p.step), lc), await loadImages(admin, use.map((p) => p.path)), MODEL_INSPECT, 4000);
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    const defects = (Array.isArray(r?.defects) ? r.defects : []).slice(0, 12).map((d: any) => ({
      code: asCode(d.code), type: String(d.type || "Problem"), where: String(d.where || ""), photo: Math.min(use.length, Math.max(1, +d.photo || 1)), step: use[Math.min(use.length, Math.max(1, +d.photo || 1)) - 1]?.step ?? "",
      box: Array.isArray(d.box) && d.box.length === 4 && d.box.every((n: any) => isFinite(n)) ? d.box.map((n: any) => clamp(+n)) : null,
      severity: ["critical", "major", "minor"].includes(d.severity) ? d.severity : "major", conf: clamp(+d.confidence || 0) }));
    const checks = (Array.isArray(r?.checks) ? r.checks : []).slice(0, 12).map((c: any) => ({ item: String(c.item || ""), result: ["pass", "fail", "unclear"].includes(c.result) ? c.result : "unclear", note: String(c.note || "").slice(0, 200) }));
    // Deterministic checks on top of the AI.
    const issues: { level: "FAIL" | "REVIEW"; en: string; zh: string }[] = [];
    const typed = iso6346(lc.container_no ?? ""), read = iso6346(r?.container_no_read ?? "");
    if (!typed.valid) issues.push({ level: "REVIEW", en: `Container number ${typed.number || "(blank)"} fails the ISO 6346 check digit. It was probably typed wrong.`, zh: `集装箱号 ${typed.number || "（空）"} 校验位不正确，可能输入错误。` });
    if (read.number && typed.number && read.number !== typed.number) issues.push({ level: "REVIEW", en: `Typed container number ${typed.number}, but the photo reads ${read.number}.`, zh: `输入的箱号为 ${typed.number}，照片上为 ${read.number}。` });
    if (!read.number) issues.push({ level: "REVIEW", en: "The container number could not be read from the photos.", zh: "照片上看不清集装箱号。" });
    const sealT = normSeal(lc.seal_no), sealR = normSeal(r?.seal_no_read);
    if (!sealR) issues.push({ level: "REVIEW", en: "The seal number could not be read from the photos.", zh: "照片上看不清封条号。" });
    else if (sealT && sealR !== sealT) issues.push({ level: "REVIEW", en: `Typed seal ${sealT}, but the photo reads ${sealR}.`, zh: `输入的封条号为 ${sealT}，照片上为 ${sealR}。` });
    const name = (pid: string) => (prods ?? []).find((p: any) => p.id === pid)?.name ?? "product";
    for (const l of lines ?? []) {
      const n = Math.floor(+(lc.counts?.[l.id] ?? NaN));
      if (!isFinite(n)) issues.push({ level: "REVIEW", en: `No carton count entered for ${name(l.product_id)}.`, zh: `${name(l.product_id)} 未填写装箱数。` });
      else if (n < l.cartons) issues.push({ level: "FAIL", en: `Short shipment: ${name(l.product_id)} has ${n} of ${l.cartons} cartons loaded.`, zh: `少装：${name(l.product_id)} 装了 ${n} 箱，应为 ${l.cartons} 箱。` });
      else if (n > l.cartons) issues.push({ level: "REVIEW", en: `Over shipment: ${name(l.product_id)} has ${n} cartons loaded, the order is ${l.cartons}.`, zh: `多装：${name(l.product_id)} 装了 ${n} 箱，订单为 ${l.cartons} 箱。` });
    }
    // The goods themselves should have passed their sampled inspection before loading.
    const lids = (lines ?? []).map((l: any) => l.link_id).filter(Boolean);
    const { data: sess } = lids.length ? await admin.from("factory_sessions").select("link_id, status, result").in("link_id", lids).neq("status", "cancelled") : { data: [] as any[] };
    for (const l of lines ?? []) {
      const s = (sess ?? []).find((x: any) => x.link_id === l.link_id && x.status === "done");
      if (!s) issues.push({ level: "REVIEW", en: `${name(l.product_id)} was loaded before its factory inspection finished.`, zh: `${name(l.product_id)} 在验货完成前已装柜。` });
      else if (s.result !== "PASS") issues.push({ level: "REVIEW", en: `${name(l.product_id)} was loaded although its factory inspection result is ${s.result}.`, zh: `${name(l.product_id)} 验货结果为 ${s.result}，但已装柜。` });
    }
    let result: "PASS" | "REVIEW" | "FAIL" = "PASS";
    if (issues.some((x) => x.level === "REVIEW") || checks.some((c: any) => c.result !== "pass") || defects.some((d: any) => d.severity === "major")) result = "REVIEW";
    if (issues.some((x) => x.level === "FAIL") || defects.some((d: any) => d.severity === "critical")) result = "FAIL";
    const zh = r?.zh && typeof r.zh === "object" ? { summary: String(r.zh.summary ?? "").slice(0, 400), defects: (Array.isArray(r.zh.defects) ? r.zh.defects : []).slice(0, defects.length).map((t: any) => String(t).slice(0, 200)) } : null;
    const ai = { summary: String(r?.summary ?? "").slice(0, 600), zh, checks, defects, issues, photos_used: use.map((p) => p.path) };
    await admin.from("loading_checks").update({ status: "done", result, ai, container_no_read: read.number || null, seal_no_read: sealR || null,
      container_no_valid: typed.valid || (read.valid && read.number === typed.number), checked_at: new Date().toISOString(), error: null }).eq("id", lcId);
  } catch (e) {
    await admin.from("loading_checks").update({ status: "error", error: String((e as Error).message ?? e).slice(0, 500) }).eq("id", lcId);
  }
}

async function poTask(task: string, body: any) {
  if (!SERVICE_KEY) throw new HttpError(500, "Server is missing SUPABASE_SERVICE_ROLE_KEY.");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_KEY, { auth: { persistSession: false } });
  const { po, lines, prods, links, sess } = await openPo(admin, String(body?.token ?? ""));
  if (task === "po_open") {
    const lc = await latestLoading(admin, po.id);
    const thumbs: string[] = [];
    const outLines = lines.map((l: any) => {
      const p = prods.find((x: any) => x.id === l.product_id) ?? {};
      const link = links.find((x: any) => x.id === l.link_id);
      const s = sess.find((x: any) => x.link_id === l.link_id);
      const ref = refPool(p.photos ?? [])[0]; if (ref) thumbs.push(ref.path);
      return { id: l.id, seq: l.seq, name: p.name ?? "", sku: p.sku ?? "", qty: l.qty, cartons: l.cartons, units_per_carton: l.units_per_carton, thumb: ref?.path ?? "",
        link_token: link && link.active && new Date(link.expires_at).getTime() > Date.now() ? link.token : "",
        inspection: s ? { status: s.status, result: s.result, sample_size: s.sample_size } : null };
    });
    const pub = publicLoading(lc);
    const urls = await signMap(admin, [...thumbs, ...(pub?.photos ?? []).map((p: any) => p.path)]);
    return { po: { po_number: po.po_number, supplier_name: po.supplier_name ?? "", ship_by: po.ship_by, notes: po.notes ?? "" }, lines: outLines, loading: pub, steps: LOAD_STEPS, urls };
  }
  if (task === "po_load_start") {
    const cur = await latestLoading(admin, po.id);
    if (cur && cur.status === "open" && Date.now() < new Date(cur.started_at).getTime() + LOAD_WINDOW_H * 3600e3) return { loading: publicLoading(cur) };
    if (cur && ["checking", "done"].includes(cur.status)) throw new HttpError(409, "This container has already been checked. Ask the buyer if it needs to be checked again.");
    if (cur && cur.status === "open") await admin.from("loading_checks").update({ status: "cancelled" }).eq("id", cur.id);
    const { data: lc, error } = await admin.from("loading_checks").insert({ po_id: po.id, workspace_id: po.workspace_id }).select().single();
    if (error || !lc) throw new HttpError(500, "Could not start the loading check: " + (error?.message ?? ""));
    return { loading: publicLoading(lc) };
  }
  const openLc = async () => {
    const lc = await latestLoading(admin, po.id);
    if (!lc || lc.status !== "open") throw new HttpError(409, "Start the loading check first.");
    if (Date.now() > new Date(lc.started_at).getTime() + LOAD_WINDOW_H * 3600e3) throw new HttpError(409, `A loading check must be finished within ${LOAD_WINDOW_H} hours. Start again.`);
    return lc;
  };
  if (task === "po_load_upload") {
    const lc = await openLc();
    const step = String(body.step ?? "");
    if (!LOAD_STEPS.some((s) => s.key === step)) throw new HttpError(400, "Unknown step.");
    const path = `${loadPrefix(lc)}${step}-${crypto.randomUUID()}.jpg`;
    const { data, error } = await admin.storage.from("photos").createSignedUploadUrl(path);
    if (error || !data) throw new HttpError(500, "Could not prepare the upload: " + (error?.message ?? ""));
    return { path, token: data.token };
  }
  if (task === "po_load_submit") {
    const lc = await openLc();
    const pre = loadPrefix(lc);
    const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, 40).map((p: any) => ({ path: String(p?.path ?? ""), step: String(p?.step ?? "") }));
    if (photos.some((p: any) => !p.path.startsWith(pre) || p.path.includes("..") || !LOAD_STEPS.some((s) => s.key === p.step) || !p.path.slice(pre.length).startsWith(p.step + "-"))) throw new HttpError(403, "Photo does not belong to this loading check.");
    const missing = LOAD_STEPS.filter((s) => s.required && !photos.some((p: any) => p.step === s.key));
    if (missing.length) throw new HttpError(400, "缺少照片 Missing photos: " + missing.map((s) => `${s.zh} (${s.en})`).join(", "));
    // Every photo must have been taken after this loading check started.
    const { data: listed } = await admin.storage.from("photos").list(pre.replace(/\/$/, ""), { limit: 200 });
    const made = new Map((listed ?? []).map((o: any) => [pre + o.name, new Date(o.created_at).getTime()]));
    const since = new Date(lc.started_at).getTime() - 5000;
    if (photos.some((p: any) => !made.has(p.path) || (made.get(p.path) as number) < since)) throw new HttpError(403, "Photos must be taken live during this loading check.");
    const counts: Record<string, number> = {};
    for (const l of lines) { const n = Math.floor(+(body.counts?.[l.id] ?? NaN)); if (!(n >= 0 && n <= 1000000)) throw new HttpError(400, "请填写每个产品的装箱数 Enter the cartons loaded for every product."); counts[l.id] = n; }
    const container = iso6346(String(body.container_no ?? "")).number, seal = normSeal(body.seal_no);
    if (!container || !seal) throw new HttpError(400, "请填写集装箱号和封条号 Enter the container number and seal number.");
    await admin.from("loading_checks").update({ status: "checking", photos, counts, container_no: container, seal_no: seal, submitted_by: String(body.worker ?? "").slice(0, 60) || null, submitted_at: new Date().toISOString() }).eq("id", lc.id);
    const job = runLoadingCheck(admin, lc.id);
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job); else await job;
    return { accepted: true, loading: publicLoading((await admin.from("loading_checks").select("*").eq("id", lc.id).single()).data) };
  }
  throw new HttpError(400, "Unknown task");
}

// ---------- dock receiving (buyer JWT; row level security applies) ----------
function sealPrompt(expected: string) {
  return `These photos were taken at a US warehouse dock before a shipping container was opened. Read the seal number exactly as printed on the bolt or cable seal, and say whether the seal looks intact (not cut, broken, re-glued or tampered with) and properly through the door locking bar.${expected ? ` The seal recorded at loading in China was ${expected}.` : ""}
JSON: {"seal_no_read":"","intact":true,"note":"one short sentence"}
Use "" for seal_no_read and null for intact if the photos do not show it.`;
}
function damagePrompt(nRef: number, nDmg: number, product: string, note: string) {
  return `You are checking damaged cartons received at a US warehouse from a factory in China. ${nRef ? `Images 1 to ${nRef} were taken by the factory while the container was being loaded and sealed; they show how the goods looked when they left. ` : "There are no loading photos. "}Images ${nRef + 1} to ${nRef + nDmg} show the damaged carton${product ? ` of "${product}"` : ""} as received${note ? ` (dock note: ${note})` : ""}.
Describe each problem, give it a "code" from this list: ${codeList(["carton", "packaging", "product"])}, and decide where it most likely happened:
"factory" if the loading photos show the same damage, or it is a manufacturing or packing fault shipping cannot cause (wrong marks, wrong quantity, wrong or missing product, poor packing);
"transit" if the loading photos show the cartons clean and well stowed and this is typical shipping damage (crush, puncture, water, breakage, leak);
"unclear" if you cannot tell. Loading photos show the load, not every carton, so be honest about uncertainty.
JSON: {"summary":"one or two plain sentences","product_affected":true,"origin":"factory|transit|unclear","origin_reason":"short","defects":[{"code":"CTN","type":"short name","where":"plain location","photo":1,"box":[0.1,0.2,0.3,0.3],"severity":"critical|major|minor","confidence":0.8}]}
"photo" is the 1-based index among the DAMAGE photos only. "box" is fractions 0–1 or null.`;
}
async function runReceiptCheck(sb: SupabaseClient, rid: string) {
  const { data: rc } = await sb.from("receipts").select("*").eq("id", rid).single();
  try {
    const { data: po } = await sb.from("purchase_orders").select("*").eq("id", rc.po_id).single();
    const { data: lines } = await sb.from("po_lines").select("*").eq("po_id", po.id).order("seq");
    const pids = (lines ?? []).map((l: any) => l.product_id);
    const { data: prods } = pids.length ? await sb.from("products").select("id, name").in("id", pids) : { data: [] as any[] };
    const name = (pid: string) => (prods ?? []).find((p: any) => p.id === pid)?.name ?? "product";
    const { data: lcs } = await sb.from("loading_checks").select("*").eq("po_id", po.id).eq("status", "done").order("started_at", { ascending: false }).limit(1);
    const lc = lcs && lcs.length ? lcs[0] : null;
    const loadSeal = normSeal(lc?.seal_no_read || lc?.seal_no || "");
    // 1. Seal
    const sealPhotos = (rc.photos ?? []).filter((p: any) => p.step === "seal").slice(0, 3);
    let seal: any = { read: "", intact: null, note: "No seal photo." };
    if (sealPhotos.length) {
      const r = await askJson(sealPrompt(loadSeal), await loadImages(sb, sealPhotos.map((p: any) => p.path)), MODEL_INSPECT, 800);
      seal = { read: normSeal(r?.seal_no_read), intact: typeof r?.intact === "boolean" ? r.intact : null, note: String(r?.note ?? "").slice(0, 200) };
    }
    const dockSeal = normSeal(rc.seal_no) || seal.read;
    const sealMatch = loadSeal && dockSeal ? dockSeal === loadSeal : null;
    // 2. Damaged cartons, a few at a time, each compared with the loading photos.
    const refs = lc ? (lc.photos ?? []).filter((p: any) => ["full", "marks", "half"].includes(p.step)).slice(0, 4) : [];
    const refImgs = refs.length ? await loadImages(sb, refs.map((p: any) => p.path)) : [];
    const damage = Array.isArray(rc.damage) ? rc.damage.slice(0, 30) : [];
    for (let i = 0; i < damage.length; i += 4) {
      await Promise.all(damage.slice(i, i + 4).map(async (dm: any) => {
        const ph = (dm.photos ?? []).slice(0, 6);
        if (!ph.length) { dm.ai = { summary: "No photos.", origin: "unclear", defects: [] }; return; }
        const line = (lines ?? []).find((l: any) => l.id === dm.line_id);
        const r = await askJson(damagePrompt(refImgs.length, ph.length, line ? name(line.product_id) : "", String(dm.note ?? "").slice(0, 200)), [...refImgs, ...await loadImages(sb, ph.map((p: any) => p.path))], MODEL_INSPECT, 2000);
        const clamp = (n: number) => Math.min(1, Math.max(0, n));
        dm.ai = { summary: String(r?.summary ?? "").slice(0, 400), product_affected: !!r?.product_affected, origin: ["factory", "transit", "unclear"].includes(r?.origin) ? r.origin : "unclear", origin_reason: String(r?.origin_reason ?? "").slice(0, 200),
          defects: (Array.isArray(r?.defects) ? r.defects : []).slice(0, 8).map((d: any) => ({ code: asCode(d.code), type: String(d.type || "Damage"), where: String(d.where || ""), photo: Math.min(ph.length, Math.max(1, +d.photo || 1)),
            box: Array.isArray(d.box) && d.box.length === 4 && d.box.every((n: any) => isFinite(n)) ? d.box.map((n: any) => clamp(+n)) : null, severity: ["critical", "major", "minor"].includes(d.severity) ? d.severity : "major", conf: clamp(+d.confidence || 0) })) };
      }));
    }
    // 3. Counts and who is responsible for each gap.
    const issues: { level: string; text: string; origin: string }[] = [];
    if (seal.intact === false) issues.push({ level: "FAIL", text: "The seal looks cut, broken or tampered with.", origin: "transit" });
    if (sealMatch === false) issues.push({ level: "FAIL", text: `Seal ${dockSeal} does not match the seal recorded at loading (${loadSeal}).`, origin: "transit" });
    if (!lc) issues.push({ level: "REVIEW", text: "No loading check on record, so carton counts are compared with the purchase order only.", origin: "unclear" });
    const sealOk = seal.intact !== false && sealMatch !== false;
    const outLines = (lines ?? []).map((l: any) => {
      const c = rc.counts?.[l.id] ?? {};
      const received = Math.max(0, Math.floor(+c.received || 0)), damaged = Math.max(0, Math.floor(+c.damaged || 0));
      const loaded = lc && isFinite(+lc.counts?.[l.id]) ? +lc.counts[l.id] : null;
      const expected = l.cartons;
      const out: any = { line_id: l.id, name: name(l.product_id), ordered: expected, loaded, received, damaged, short: 0, over: 0, origin: "none", why: "" };
      if (received < expected) {
        out.short = expected - received;
        const factoryShort = loaded !== null ? Math.max(0, expected - loaded) : 0;
        const lostAfter = loaded !== null ? Math.max(0, loaded - received) : out.short;
        if (loaded !== null && factoryShort >= out.short) { out.origin = "factory"; out.why = `Only ${loaded} of ${expected} cartons were loaded at the factory.`; }
        else if (loaded === null) { out.origin = "unclear"; out.why = "No loading count on record."; }
        else if (sealOk) { out.origin = "factory"; out.why = `${loaded} cartons were reported loaded, but the container arrived with ${sealMatch ? "the same, intact seal" : "an intact seal"}, so ${lostAfter} carton${lostAfter > 1 ? "s were" : " was"} most likely never loaded.`; }
        else { out.origin = "transit"; out.why = `${loaded} cartons were loaded and the seal was not intact on arrival, so ${lostAfter} carton${lostAfter > 1 ? "s were" : " was"} most likely lost or taken in transit.`; }
        issues.push({ level: "FAIL", text: `${out.name}: ${out.short} carton${out.short > 1 ? "s" : ""} short (ordered ${expected}, received ${received}). ${out.why}`, origin: out.origin });
      } else if (received > expected) {
        out.over = received - expected;
        issues.push({ level: "REVIEW", text: `${out.name}: ${out.over} carton${out.over > 1 ? "s" : ""} over the order.`, origin: "factory" });
      }
      const logged = damage.filter((d: any) => d.line_id === l.id).length;
      if (damaged > logged) issues.push({ level: "REVIEW", text: `${out.name}: ${damaged} damaged cartons counted, ${logged} photographed.`, origin: "unclear" });
      return out;
    });
    for (const dm of damage) {
      const sev = (dm.ai?.defects ?? []).map((d: any) => d.severity);
      const line = outLines.find((x: any) => x.line_id === dm.line_id);
      issues.push({ level: sev.includes("critical") || sev.includes("major") || dm.ai?.product_affected ? "FAIL" : "REVIEW",
        text: `${line?.name ?? "Carton"}${dm.carton ? ` carton ${dm.carton}` : ""}: ${dm.ai?.summary ?? "damaged"}`, origin: dm.ai?.origin ?? "unclear" });
    }
    const result = issues.some((x) => x.level === "FAIL") ? "FAIL" : issues.some((x) => x.level === "REVIEW") ? "REVIEW" : "PASS";
    const tot = (k: string) => outLines.reduce((a: number, x: any) => a + (x[k] || 0), 0);
    const summary = result === "PASS" ? `All ${tot("received")} cartons received against the order, seal ${loadSeal ? "matches loading" : "checked"}, no damage logged.`
      : `${tot("short") ? `${tot("short")} cartons short. ` : ""}${damage.length ? `${damage.length} damaged carton${damage.length > 1 ? "s" : ""} logged. ` : ""}${sealMatch === false || seal.intact === false ? "Seal problem. " : ""}`.trim();
    await sb.from("receipts").update({ status: "done", result, seal_no_read: seal.read || null, seal_intact: seal.intact, seal_match: sealMatch, damage,
      ai: { summary, issues, lines: outLines, seal: { ...seal, loading: loadSeal, dock: dockSeal }, loading_check_id: lc?.id ?? null }, checked_at: new Date().toISOString(), error: null }).eq("id", rid);
  } catch (e) {
    await sb.from("receipts").update({ status: "error", error: String((e as Error).message ?? e).slice(0, 500) }).eq("id", rid);
  }
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const task = String(body?.task ?? "");
  if (task.startsWith("factory_") || task.startsWith("po_")) {
    try { return json(task.startsWith("po_") ? await poTask(task, body) : await factoryTask(task, body)); }
    catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500); }
  }
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: "Sign in first" }, 401);
  try {
    if (task === "receipt_check") {
      const rid = String(body.receipt_id ?? "");
      const { data: rc } = await sb.from("receipts").select("id, status").eq("id", rid).maybeSingle();
      if (!rc) return json({ error: "Receipt not found" }, 404);
      if (rc.status === "checking") return json({ error: "This receipt is already being checked" }, 409);
      await sb.from("receipts").update({ status: "checking", error: null }).eq("id", rid);
      const job = runReceiptCheck(sb, rid);
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(job); else await job;
      return json({ accepted: true });
    }
    if (task === "inspect") return json({ inspection: await taskInspect(sb, String(body.inspection_id)) });
    if (task === "identify") return json({ photos: await identifyPaths(sb, body.product, (body.paths ?? []).map(String)) });
    if (task === "describe") {
      const paths: string[] = (body.paths ?? []).slice(0, MAX_IMAGES);
      return json({ fields: await askJson(describePrompt(paths.length), await loadImages(sb, paths), MODEL_INSPECT) });
    }
    if (task === "read_listing") {
      const paths: string[] = (body.paths ?? []).slice(0, MAX_IMAGES);
      return json({ fields: await askJson(listingPrompt(String(body.url ?? ""), String(body.text ?? ""), paths.length), await loadImages(sb, paths), MODEL_INSPECT) });
    }
    if (task === "import_url") {
      const ws = String(body.workspace_id ?? "");
      const { data: member } = await sb.from("workspace_members").select("workspace_id").eq("workspace_id", ws).eq("user_id", user.id).maybeSingle();
      if (!member) return json({ error: "Not a member of that workspace" }, 403);
      return json(await taskImportUrl(sb, ws, String(body.url ?? "")));
    }
    return json({ error: "Unknown task" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
