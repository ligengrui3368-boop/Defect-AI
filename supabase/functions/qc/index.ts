// Defect Check AI endpoint. One function, several tasks:
//   identify      – label which part each photo shows and flag unusable photos
//   describe      – draft a standard from photos of a good unit
//   read_listing  – draft a standard from pasted listing text and screenshots
//   import_url    – fetch an official product page, save its images, draft a standard
//   inspect       – run a check on a saved inspection and write the result back
// The caller's JWT is forwarded, so row level security applies to every read and write.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL_INSPECT = Deno.env.get("QC_MODEL") ?? "claude-sonnet-5-5";
const MODEL_CAREFUL = Deno.env.get("QC_MODEL_CAREFUL") ?? "claude-opus-5-5";
const MODEL_QUICK = Deno.env.get("QC_MODEL_QUICK") ?? "claude-haiku-4-5-20251001";
const MAX_IMAGES = Number(Deno.env.get("QC_MAX_IMAGES_PER_CALL") ?? "16");

export const WATCH = ["Scratches", "Dents", "Cracks or chips", "Stains or marks", "Color mismatch", "Missing parts", "Loose or bent parts", "Logo or print errors", "Wrong label", "Packaging damage", "Rust or corrosion", "Burrs or sharp edges", "Loose threads", "Bubbles or warping"];
export const VIEWS = ["Front", "Back", "Top", "Bottom", "Side", "Label", "Packaging", "Close-up"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Img = { data: string; media_type: string };
type Photo = { path: string; view?: string; part?: string; origin?: string; kind?: string; quality?: string };

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

function inspectPrompt(p: any, refs: Photo[], units: Photo[], all: Photo[]) {
  const s = p.spec ?? {};
  const L: string[] = [];
  L.push("You are a strict but fair quality-control inspector working for an online seller who buys from a factory. Decide whether the unit in the photos matches the seller's approved standard and is free of defects.");
  const label = (u: Photo) => u.part || u.view || "unspecified";
  if (refs.length) {
    L.push("REFERENCE images (what a good unit looks like):");
    refs.forEach((r, k) => L.push(`- Image ${k + 1}: ${r.origin === "official" ? "OFFICIAL listing image from the brand. It may be a studio render or retouched: use it for shape, color, parts, logo and layout, and ignore its lighting, background, props and perfect surfaces" : "photo of a real APPROVED unit"} (shows: ${label(r)}).`));
    L.push(`${units.length > 1 ? `Images ${refs.length + 1}–${refs.length + units.length} show` : `Image ${refs.length + 1} shows`} the UNIT UNDER INSPECTION (in order: ${units.map(label).join("; ")}).`);
  } else L.push(`There are no reference images. All ${units.length} images show the UNIT UNDER INSPECTION (in order: ${units.map(label).join("; ")}).`);
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
  add("Watch especially for", (s.watch ?? []).join(", "));
  add("Smallest rejectable defect", s.minDefectMm ? s.minDefectMm + " mm (smaller marks are acceptable; estimate size using the known product size)" : "");
  const views: string[] = s.views ?? [];
  L.push(`RULES:
- Compare the unit with the references and the standard. Ignore differences caused by lighting, angle, background, reflections or camera color.
- If a photo is blurry, too dark, cropped, or the wrong view so that a safe judgement is impossible, the verdict is RETAKE and photo_quality lists what to fix.
- If you see a possible defect but cannot be sure, the verdict is REVIEW. Never PASS when unsure.
- FAIL if any defect is at or above the rejectable size, or a must-have feature is missing or wrong.
- Photos cannot measure size precisely: mark size checks "unclear" unless something in the photo gives a scale.
- Include one check for each must-have line, each in-the-box item and each watch-for item, plus color and finish.
- Extra photos: ${views.length ? `the seller has decided that ${views.join(", ")} views are enough for this product. ` : ""}Only ask for another photo when a must-have item or a possible defect genuinely cannot be judged from the photos given, and say exactly what to photograph and why. Never ask just for completeness. If you ask, the verdict cannot be PASS.
JSON:
{"verdict":"PASS|FAIL|REVIEW|RETAKE","summary":"one or two plain sentences","photo_quality":{"ok":true,"issues":["..."]},"checks":[{"item":"...","result":"pass|fail|unclear","note":"short"}],"defects":[{"type":"short name","where":"plain location on the product","photo":1,"box":[x,y,w,h],"size_estimate_mm":null,"severity":"critical|major|minor","within_spec":false,"confidence":0.8}],"more_photos":[{"part":"what to photograph","why":"what it would settle"}]}
"photo" is the 1-based index among the UNIT photos only. "box" is the approximate region in that photo as fractions 0–1 (x, y = top-left), or null. Use [] when there are no defects and [] for more_photos when the photos are enough.`);
  return L.join("\n");
}

// ---------- result handling ----------
export function normalize(r: any, nUnits: number) {
  const V = ["PASS", "FAIL", "REVIEW", "RETAKE"]; let v = String(r?.verdict ?? "").toUpperCase(); if (!V.includes(v)) v = "REVIEW";
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const defects = (Array.isArray(r?.defects) ? r.defects : []).slice(0, 12).map((d: any) => ({
    type: String(d.type || "Defect"), where: String(d.where || ""), photo: Math.min(nUnits, Math.max(1, +d.photo || 1)),
    box: Array.isArray(d.box) && d.box.length === 4 && d.box.every((n: any) => isFinite(n)) ? d.box.map((n: any) => clamp(+n)) : null,
    size: d.size_estimate_mm == null ? null : +d.size_estimate_mm, severity: ["critical", "major", "minor"].includes(d.severity) ? d.severity : "major",
    inSpec: !!d.within_spec, conf: clamp(+d.confidence || 0),
  }));
  const checks = (Array.isArray(r?.checks) ? r.checks : []).slice(0, 30).map((c: any) => ({ item: String(c.item || ""), result: ["pass", "fail", "unclear"].includes(c.result) ? c.result : "unclear", note: String(c.note || "") }));
  const more = (Array.isArray(r?.more_photos) ? r.more_photos : []).filter((m: any) => m?.part).slice(0, 5).map((m: any) => ({ part: String(m.part).slice(0, 80), why: String(m.why || "").slice(0, 140) }));
  if (v === "PASS" && (defects.some((d: any) => !d.inSpec) || checks.some((c: any) => c.result === "fail") || more.length)) v = "REVIEW";
  const pq = r?.photo_quality ?? {};
  return { verdict: v, summary: String(r?.summary || ""), photoOk: pq.ok !== false, photoIssues: (Array.isArray(pq.issues) ? pq.issues : []).map(String).slice(0, 6), checks, defects, more };
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
  }
  out.checks = [...ck.values()];
  return out;
}
function refPool(photos: Photo[]) {
  return [...photos.filter((x) => x.origin !== "official"), ...photos.filter((x) => x.origin === "official" && !["spec_or_text", "document", "other"].includes(x.kind ?? ""))];
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
    const pool = refPool(product?.photos ?? []);
    const refCap = Math.min(pool.length, 4, MAX_IMAGES - 1), per = Math.max(1, MAX_IMAGES - refCap);
    const parts: { ai: any; offset: number }[] = [];
    const model = ins.careful ? MODEL_CAREFUL : MODEL_INSPECT;
    for (let i = 0; i < units.length; i += per) {
      const batch = units.slice(i, i + per);
      const want = new Set(batch.map((u) => u.view).filter(Boolean));
      const refs = [...pool.filter((r) => want.has(r.view)), ...pool.filter((r) => !want.has(r.view))].slice(0, Math.min(refCap, MAX_IMAGES - batch.length));
      const imgs = await loadImages(sb, [...refs, ...batch].map((x) => x.path));
      const r = await askJson(inspectPrompt(p, refs, batch, units), imgs, model, 6000);
      parts.push({ ai: normalize(r, batch.length), offset: i });
    }
    const ai = merge(parts);
    const { data: done } = await sb.from("inspections").update({ status: "done", ai, verdict: ai.verdict, model, checked_at: new Date().toISOString() }).eq("id", inspectionId).select().single();
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

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: "Sign in first" }, 401);
  let body: any; try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  const task = body?.task;
  try {
    if (task === "inspect") return json({ inspection: await taskInspect(sb, String(body.inspection_id)) });
    if (task === "identify") {
      const paths: string[] = (body.paths ?? []).slice(0, 40); const out: any[] = [];
      for (let i = 0; i < paths.length; i += MAX_IMAGES) {
        const chunk = paths.slice(i, i + MAX_IMAGES);
        const r = await askJson(identifyPrompt(body.product, chunk.length), await loadImages(sb, chunk), MODEL_QUICK, 2000);
        (r.photos ?? []).forEach((x: any) => out.push({ ...x, index: (+x.index || 0) + i }));
      }
      return json({ photos: out });
    }
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
