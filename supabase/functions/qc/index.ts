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
{"verdict":"PASS|FAIL|REVIEW|RETAKE","summary":"one or two plain sentences","photo_quality":{"ok":true,"issues":["..."]},"checks":[{"item":"...","result":"pass|fail|unclear","note":"short"}],"defects":[{"type":"short name","where":"plain location on the product","photo":1,"box":[x,y,w,h],"size_estimate_mm":null,"severity":"critical|major|minor","within_spec":false,"confidence":0.8${arrival ? ',"origin":"factory|transit|unclear","origin_reason":"short"' : ""}}],"more_photos":[{"part":"what to photograph","why":"what it would settle"}]${arrival ? ',"origin_summary":""' : ""}${zh ? ',"zh":{"summary":"","defects":[""],"more":[""]}' : ""}}
${zh ? `"zh" is for factory workers who read Chinese: zh.summary is the summary in simplified Chinese; zh.defects has one simplified-Chinese line per defect, same order, written as "问题 — 位置"; zh.more has one line per more_photos item, same order, written as "拍什么 — 原因".
` : ""}"photo" is the 1-based index among the UNIT photos only (never the reference or factory photos). "box" is the approximate region in that photo as fractions 0–1 (x, y = top-left), or null. Use [] when there are no defects and [] for more_photos when the photos are enough.`);
  return L.join("\n");
}

// ---------- result handling ----------
export function normalize(r: any, nUnits: number, arrival = false) {
  const V = ["PASS", "FAIL", "REVIEW", "RETAKE"]; let v = String(r?.verdict ?? "").toUpperCase(); if (!V.includes(v)) v = "REVIEW";
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const defects = (Array.isArray(r?.defects) ? r.defects : []).slice(0, 12).map((d: any) => ({
    type: String(d.type || "Defect"), where: String(d.where || ""), photo: Math.min(nUnits, Math.max(1, +d.photo || 1)),
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
      ai.defects = [{ type: "Wrong barcode", where: "barcode label", photo: 1, box: null, size: null, severity: "major", inSpec: false, conf: 1 }, ...(ai.defects ?? [])];
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

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any; try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const task = String(body?.task ?? "");
  if (task.startsWith("factory_")) {
    try { return json(await factoryTask(task, body)); }
    catch (e) { return json({ error: String((e as Error).message ?? e) }, e instanceof HttpError ? e.status : 500); }
  }
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: "Sign in first" }, 401);
  try {
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
