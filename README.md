# Defect Check

End-to-end sourcing platform for US brands buying from Chinese factories: a client submits what they want made, agents find and verify factories on 1688, Gary negotiates, the system computes landed cost and margin (duties, tariffs, freight, fees), and a client portal tracks everything. The quality module below checks the goods before the balance is paid.

QC module: AI-verified production QC for cross-border sourcing. A buyer sets up the approved standard for a product, either from the brand's official listing or from photos of a good unit. Factory or warehouse staff then photograph units on a phone, and Claude checks each unit against the standard. A person makes the final pass or fail call, and every check is stored with its photos and the exact version of the standard it was judged against.

## What's in this repo

| Path | What it is |
| --- | --- |
| `web/` | The phone-first web app (plain HTML/JS, no build step). Products, checks, review. |
| `web/ops.html` | Operations console for buyers: purchase orders, container loading, dock receiving, defects, suppliers. |
| `web/po.html` | Factory page for one purchase order (Chinese first): each product's inspection and the container loading check. |
| `web/sourcing.html` | Sourcing CRM: client requests, intake agent, 1688 candidates and ranking, negotiations with RFQ drafting, landed-cost quotes, orders. |
| `web/portal.html` | Client portal (token link, no login): submit requests, add requirements and mistakes to watch for, see released shortlists, quotes and order status. |
| `web/config.js` | Your Supabase URL and anon key go here. |
| `supabase/migrations/` | Database schema, row level security, photo storage bucket, realtime. |
| `supabase/functions/sourcing/` | Edge Function for the sourcing agents: `intake` (brief → structured spec, Chinese search terms, HTS guess), `search_1688` (via an Apify scraper actor, needs `APIFY_TOKEN`), `rank`, `draft_rfq` (Chinese first-contact message), `verify` (factory checks). |
| `supabase/functions/qc/` | Edge Function that talks to the Claude API: identify photo parts, import a product page from a link, read listings, draft a standard from photos, run inspections. |
| `.github/workflows/pages.yml` | Publishes `web/` to GitHub Pages on every push to `main`. |

## How it fits together

```
Phone browser (web/)
  ├─ Supabase Auth ........ email sign-in link
  ├─ Supabase Postgres .... products, inspections (row level security per workspace)
  ├─ Supabase Storage ..... private "photos" bucket: <workspace_id>/<file>.jpg
  └─ Edge Function "qc" ... runs with the user's own token, so the same security rules apply
                             └─ Claude API (photos + standard → verdict, findings, checklist)
```

The Anthropic API key lives only in Supabase as a secret. The web app never sees it.

Each new user gets their own workspace automatically. Everything they create lives in that workspace, and other accounts can't read it.

## Setup

You need a Supabase project, an Anthropic API key, and (optionally) a GitHub repo for hosting.

### Required secret: `ANTHROPIC_API_KEY`
The only secret the app needs. Add it **only** in Supabase → Edge Functions → Secrets, under the exact name `ANTHROPIC_API_KEY` (create a key at https://console.anthropic.com). Never put it in this repo, `web/config.js`, the README, screenshots or logs. The web app never sees it: the `qc` Edge Function reads it on the server. Without it, everything except the AI steps works, and checks end with "ANTHROPIC_API_KEY is not set".

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to Edge Functions automatically by Supabase; don't add them yourself.

### 1. Supabase project
Create a project at https://supabase.com/dashboard. The free plan is enough for a pilot.

### 2. Database, function and secret

With the Supabase CLI (https://supabase.com/docs/guides/cli):

```bash
supabase login
supabase init                 # only if supabase/config.toml doesn't exist yet; keep the existing folders
supabase link --project-ref <your-project-ref>
supabase db push              # runs supabase/migrations
supabase secrets set ANTHROPIC_API_KEY=<your key>
supabase functions deploy qc
```

Without the CLI:
1. Dashboard → SQL Editor → run each file in `supabase/migrations/`, one at a time, in filename order:
   `20260930000000_init.sql`, `20260930000100_harden_functions.sql`, `20261001000000_arrival_checks.sql`, `20261001000100_factory_links.sql`, `20261001000200_sampled_inspection.sql`, `20261001000300_continuous_capture_and_decisions.sql`, `20261001000400_leads.sql`, `20261002000000_po_loading_receiving_defects.sql`.
2. Dashboard → Edge Functions → Deploy a new function named `qc` → paste `supabase/functions/qc/index.ts`. Keep "Verify JWT" on (factory links still work: the page sends the public anon key, and the function checks the link token itself).
3. Dashboard → Edge Functions → Secrets → add `ANTHROPIC_API_KEY`.

Optional secrets: `QC_MODEL`, `QC_MODEL_CAREFUL`, `QC_MODEL_QUICK`, `QC_MAX_IMAGES_PER_CALL` (see `.env.example`).

### 3. Point the web app at your project
Dashboard → Project Settings → API. Copy the project URL and the anon (publishable) key into `web/config.js`. The anon key is designed to be public; row level security is what protects the data. Never put the service role key in the web app.

### 4. Allow sign-in redirects
Dashboard → Authentication → URL Configuration. Set the Site URL to where the app is hosted (for GitHub Pages: `https://<user>.github.io/<repo>/`) and add it to Redirect URLs. Add `http://localhost:8000/` too if you test locally.

### 5. Host the app
- **GitHub Pages:** push to `main`, then repo Settings → Pages → Source: GitHub Actions. The included workflow publishes `web/`.
- **Locally:** `cd web && python3 -m http.server 8000`, then open http://localhost:8000.

## Current deployment

| Piece | Where |
| --- | --- |
| Code | https://github.com/ligengrui3368-boop/Defect-AI (branch `main`) |
| Web app | https://ligengrui3368-boop.github.io/Defect-AI/ (GitHub Pages, deployed by `.github/workflows/pages.yml` on every push to `main` that touches `web/`) |
| Backend | Supabase project `jkgevzgfacfqcjqxosnm`: all migrations applied, `qc` Edge Function deployed with Verify JWT on |

The deployed `qc` function is a one-line entry file that imports `supabase/functions/qc/index.ts` from a pinned GitHub commit (`raw.githubusercontent.com/.../<commit>/supabase/functions/qc/index.ts`), so what runs is byte-for-byte what is in the repo. After changing the function, commit it and redeploy with the new commit hash, or deploy `index.ts` directly with `supabase functions deploy qc`.

To reproduce on a new Supabase project, follow Setup above, then change `web/config.js` to the new project's URL and anon key.

## Testing

**Without AI (free):** serve the app locally (`cd web && python3 -m http.server 8000`), sign in with the email link, create a product, create a factory link, and open that link in a private window. You should see the Chinese factory page with the standard and photo capture. Photos upload, but checks end with an error until `ANTHROPIC_API_KEY` is set.

**End to end (uses API credit, about 5–10 cents per unit):**
1. Set up a product with a few good-unit photos. Views: Front, Back, Top.
2. On the product page, **Send a link to a factory**, lot `TEST-1`. Open the link on a phone.
3. Number a few cartons, enter the lot (for example 40 units in 4 cartons of 10) and lock it. The page shows the first random pick and a countdown.
4. Open the camera, photograph the open carton with its number and the unit, submit. Expect 合格 (PASS) with a Chinese summary; a wrong or missing carton number gives 待复核 or 需重拍.
5. Back in the buyer app, the product page shows the sampling progress live; open **Sampling log** to see every pick and its timing.
6. On arrival, tap **Check a unit on arrival** on the lot report and enter the unit as `C<carton>-U<unit>` (for example `C2-U2`). Expect *Damaged in transit* if you added new damage, with factory and arrival photos side by side.
7. Clean up: close the link on the product page and delete the test checks (or the test product).

## Costs and limitations
- **AI checks require paid Anthropic API usage.** Plan on paying from the first check: buy prepaid credit in the Anthropic console and set a monthly spend limit. Rough cost is 5–10 cents per unit with the default Sonnet model, under 1 cent for photo identification, and several times more for *Careful check* (Opus). $5 covers a prototype demo of 50–100 checks.
- Every factory link can submit up to 500 units (`factory_links.max_units`) and expires after 60 days by default. Close links when production is done.
- Supabase free plan: about 1 GB of photo storage, roughly 4,000 photos at the app's compression.

## Using it
1. **Set up a product:** paste the official product page link and tap *Import from this link* (the server opens the page, saves its product images and fills in the specs), or photograph a good unit. Edit anything, set the views that are enough for a check, save.
2. **Check a unit:** add as many photos as you like (camera, library, paste or drag). Each is labelled automatically and bad photos are flagged. You're only asked for more photos if something can't be judged.
3. **Review:** the result shows PASS, FAIL, REVIEW or RETAKE with findings boxed on the photos and a checklist against the standard. A person marks the final pass or fail.

## Data model

- `workspaces`, `workspace_members`: one workspace per company; roles `owner`, `member`, `inspector`.
- `products`: name, SKU, source URL, `spec` (JSON: materials, colors, sizes, official specs, in the box, must-haves, allowed variation, watch-for list, smallest rejectable defect, views that are enough), `photos` (JSON list of storage paths with view, part, origin and kind), `version` (bumped automatically on edit).
- `inspections`: product, `spec_snapshot` (the standard as it was at check time), photos, `status` (pending, running, done, error), `verdict`, `ai` (full result), `decision` (the person's final call), `final_result` (generated: decision if made, else verdict).

- Sourcing CRM (`20261002000100_sourcing_crm.sql`): `clients` (with `portal_token`), `sourcing_requests` (brief, `spec` JSON from the intake agent, status intake → sourcing → shortlisted → negotiating → quoted → approved → ordered → closed), `client_requirements`, `factories` (source, city, contacts, `is_verified_factory`, `verification` JSON), `request_candidates` (listings with rank and match score), `negotiations` (offers, agreed price, log), `cost_assumptions` (dated rate cards: FX, HTS duty, Section 301, other tariffs, MPF, HMF, broker, insurance, payment fees, VAT rebate, commission), `quotes` (inputs, full breakdown, landed unit cost, margin), `sourcing_orders` (links to a `purchase_orders` row for QC).
- `calc_landed_cost(inputs, rates)` computes the breakdown in SQL so the app and reports agree. `portal_view`, `portal_new_request` and `portal_add_requirement` are security-definer functions keyed by the client's portal token.

## Sourcing secrets

Set in Supabase → Edge Functions → Secrets, never in code: `APIFY_TOKEN` for 1688 search (optional `APIFY_1688_ACTOR`, default `viralanalyzer~wholesale-1688-scraper-pro`). Registry and customs lookups are manual until `QICHACHA_KEY`/`TIANYANCHA_TOKEN` and `IMPORT_DATA_KEY` are set. Rate cards hold placeholder duty and fee values; confirm them before quoting.

## Limits and next steps
- AI screening assists a person; it doesn't replace final sign-off, and photo checks can't measure millimetre dimensions without a scale in the frame.
- Some sites block automated page fetches. If *Import from this link* fails, paste the listing text or add screenshots and use *Read pasted text and screenshots*.
- Factory staff see your standard text as you wrote it. If you write it in English, only the AI findings are translated to Chinese.
- Next: invite teammates into a workspace, export lot reports and claim summaries to PDF, and prompt caching to cut per-unit cost on large lots.

### Arrival checks (factory → warehouse)
When a shipment lands, open **Check a unit**, switch to **On arrival**, and enter the same lot/PO number and unit number used at the factory. The arrival photos are compared with that unit's factory photos (or, if the unit wasn't numbered, with photos of other units from the same lot), and every finding is tagged:

- **From the factory** — the problem was already there, or it's a manufacturing fault shipping can't cause.
- **In transit** — the factory photos show that part clean, or it's typical shipping damage.
- **Origin unclear** — not enough evidence either way.

Each product page lists its **lots**. A lot report shows factory and arrival checks side by side and can copy a **claim summary** (transit damage for the carrier, factory faults for the supplier). Evidence is strongest when units are numbered at the factory and the same numbers are used on arrival.

Database: `inspections.stage` (`factory` | `arrival`), `origin_id` (the matched factory check), `damage_origin` (`none` | `factory` | `transit` | `both` | `unclear`). See `supabase/migrations/20261001000000_arrival_checks.sql`.

### Anti-cheat sampling (factory links)
Factories can't choose which units you see, and can't reuse or upload old photos.

1. **Lock the lot.** The factory numbers every carton with a marker, then enters total units, cartons and units per carton. The numbers are locked; a second attempt is refused unless you press *Cancel and resample*.
2. **Server-drawn random sample.** The server draws a random sample of carton/unit positions using ANSI/ASQ Z1.4 general level II, AQL 2.5 for major defects (for example 1,000 units → 80 checked, lot passes with ≤ 5 failed). Any critical defect fails the lot.
3. **One unit at a time, against the clock.** Each pick ("carton 7, unit 3") is revealed only when the factory asks for the next unit, with 8 minutes to photograph it. Asking again returns the same pick, so there is no re-rolling. A pick that runs out of time is recorded as **missed** and replaced by a new random unit; any missed pick puts the lot in REVIEW.
4. **Live camera only.** The factory page has no photo library, paste or drag-and-drop: photos come from the in-page camera. On the server, each pick has its own upload folder and token; a photo is accepted only if it was uploaded into that pick's folder after the pick was revealed. Old photos, other units' photos and forged paths are rejected.
5. **AI checks the evidence.** Every factory photo is checked for authenticity (photo of a screen or print, render, edited image → REVIEW) and must show the picked carton's number (wrong number → REVIEW, not visible → RETAKE, up to 3 tries).
6. **Lot result and audit trail.** When the sample is done the lot is PASS, FAIL or REVIEW. The buyer sees progress live on the product page and a **Sampling log** with every pick, when it was shown, when it was submitted, how long it took, and its verdict.

Known limits: units within a carton are chosen by position ("unit 3, counting from the top layer"), which a worker could fudge; a determined attacker who bypasses the app could still upload a fresh image inside a pick's window. Next steps on the roadmap: per-carton QR labels, duplicate-photo detection, and a factory trust score from arrival checks.

Database: `factory_sessions` (the locked lot and AQL plan) and `factory_picks` (every drawn unit with its window, attempts and verdict), plus `inspections.session_id` and `inspections.pick_id`. See `supabase/migrations/20261001000200_sampled_inspection.sql`.

### Continuous camera, printed labels and scanner checks
- **Continuous camera.** After the lot is locked, the factory taps *Start inspecting* and the camera stays open for the whole sample. The current pick ("carton 7, unit 3") and its countdown are shown over the camera with a checklist (carton label, required views, measuring card) that ticks itself as photos are recognised. *Next unit* hands the unit in and shows the next random pick straight away; the AI check runs in the background on the server and results appear as they finish.
- **Printed sheet.** After locking, the factory (or the buyer, from the product page) can print an A4 sheet: one label per carton with a big number and a QR code tied to that lot, plus a measuring card with a 10 cm ruler and colour squares. Print at 100%.
- **Scanner checks.** The phone reads QR codes and barcodes (Code 128, EAN, UPC, Code 39) in every photo. A carton label from the wrong carton or another lot blocks *Next unit* on the spot and is flagged on the server. If the product has a barcode (FNSKU, UPC or EAN) in its standard, a different barcode fails the unit. Required label text (for example "Made in China") is checked by the AI, and the measuring card lets it measure sizes in mm.
- **No sign-in.** Each browser gets its own private workspace automatically (Supabase anonymous sign-in must be enabled under Authentication, Sign In / Providers).

### Lot decision: review only the exceptions
The lot report starts with a decision card: the recommendation (release payment, hold payment, or review N units first), the AQL rule, the units that need your review with Accept / Reject buttons, and the passed units folded away. *Release payment* or *Hold payment* records your decision on the lot.

### Factory links (factory staff, no account)
On a product page, tap **Send a link to a factory**, enter the lot/PO number, and send the link (the app copies a ready-made Chinese/English message for WeChat or email). Factory staff open it on a phone. The page is in Chinese with an English switch. They see your standard, lock the lot size, and photograph the units the system picks at random (see *Anti-cheat sampling* above). Each unit gets a result (合格 / 不合格 / 待复核 / 需重拍) with findings in Chinese. Each submission is saved as a factory check in your workspace and shows up live in your lot report, ready to be matched by arrival checks later.

Links expire (60 days by default), cap at 500 units, and can be closed or reopened from the product page. Photos uploaded through a link can only land in that link's folder, and the link can only read its own product and checks. Every submitted unit uses your Anthropic API credit.

Database: `factory_links` (one row per product lot, with a random token), plus `inspections.factory_link_id` and `inspections.submitted_by`. See `supabase/migrations/20261001000100_factory_links.sql`.


### Purchase orders, container loading and dock receiving
The operations console (`ops.html`) follows each purchase order from the factory to your dock: **Ordered → In production → Inspected → Loaded → Received**.

- **Purchase orders with many products.** Each line is a product with units, units per carton and cartons. Every line gets its own anti-cheat sampled inspection (a factory link with the PO number as the lot). The factory gets **one link for the whole order** (`po.html?t=…`), plus a ready-to-paste WeChat message in Chinese and English.
- **Container loading check.** From the same link, the factory photographs seven stages live: empty container, container number, half loaded, fully loaded, carton marks (optional), doors sealed, seal close-up. It enters the container number (checked live against the ISO 6346 check digit), the seal number and the cartons loaded per product. Photos must be uploaded into that check's folder after it was started and within 12 hours. The AI reads the container and seal numbers from the photos, checks the container's condition, the stowage, the carton marks and photo authenticity. On top of that the server fails a short shipment, flags typed numbers that don't match the photos, and flags products loaded before their inspection passed.
- **Dock receiving.** Photograph the seal before cutting it, count cartons received and damaged per product, and add each damaged carton with photos. The check reads the seal, compares it with the seal recorded at loading, and decides who is responsible for each gap: cartons short at loading are the factory's; cartons missing after loading with the same intact seal were most likely never loaded (factory); a broken or different seal points to the carrier. Each damaged carton is compared with the loading photos and tagged factory, carrier or unclear. **Copy claim summary** splits the issues by party.
- **Defect codes.** Every finding (unit checks, loading, receiving) carries one of 33 codes from `public.defect_codes` (English and Chinese names, default severity). Older findings are mapped from their text. The **Defects** page ranks them (Pareto) by stage, period and supplier; **Suppliers** shows each factory's lots passed, units failed, containers passed, cartons short and damage attributed to the factory.

Database: `purchase_orders` (with the factory hub `token`), `po_lines` (each with its `factory_links` row), `loading_checks`, `receipts`, `defect_codes`, and the `defect_findings` view (security invoker, so row level security applies). Loading checks are written only by the `qc` function (`po_*` tasks, token-scoped); receiving runs as the signed-in buyer (`receipt_check`).
