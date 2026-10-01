# Defect Check

AI-verified production QC for cross-border sourcing. A buyer sets up the approved standard for a product, either from the brand's official listing or from photos of a good unit. Factory or warehouse staff then photograph units on a phone, and Claude checks each unit against the standard. A person makes the final pass or fail call, and every check is stored with its photos and the exact version of the standard it was judged against.

## What's in this repo

| Path | What it is |
| --- | --- |
| `web/` | The phone-first web app (plain HTML/JS, no build step). Sign-in by email link, products, checks, review. |
| `web/config.js` | Your Supabase URL and anon key go here. |
| `supabase/migrations/` | Database schema, row level security, photo storage bucket, realtime. |
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
   `20260930000000_init.sql`, `20260930000100_harden_functions.sql`, `20261001000000_arrival_checks.sql`, `20261001000100_factory_links.sql`.
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
| Backend | Supabase project `jkgevzgfacfqcjqxosnm`: all four migrations applied, `qc` Edge Function deployed with Verify JWT on |

To reproduce on a new Supabase project, follow Setup above, then change `web/config.js` to the new project's URL and anon key.

## Testing

**Without AI (free):** serve the app locally (`cd web && python3 -m http.server 8000`), sign in with the email link, create a product, create a factory link, and open that link in a private window. You should see the Chinese factory page with the standard and photo capture. Photos upload, but checks end with an error until `ANTHROPIC_API_KEY` is set.

**End to end (uses API credit, about 5–10 cents per unit):**
1. Set up a product with a few good-unit photos. Views: Front, Back, Top.
2. On the product page, **Send a link to a factory**, lot `TEST-1`. Open the link on a phone.
3. Enter unit `1`, photograph a good unit, submit. Expect 合格 (PASS) with a Chinese summary.
4. Make a visible mark on the same unit, submit as unit `2`. Expect 不合格 (FAIL) with the mark boxed and described in Chinese.
5. Back in the buyer app, open **Lot TEST-1** on the product page. Both units are listed under *At the factory*, tagged *Factory*.
6. Tap **Check a unit on arrival**, enter unit `1`, photograph it with a new dent or crushed box. Expect *Damaged in transit*, with factory and arrival photos side by side.
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

### Factory links (factory staff, no account)
On a product page, tap **Send a link to a factory**, enter the lot/PO number, and send the link (the app copies a ready-made Chinese/English message for WeChat or email). Factory staff open it on a phone. The page is in Chinese with an English switch. They see your standard, enter a unit number, photograph the unit, and get the result (合格 / 不合格 / 待复核 / 需重拍) with findings in Chinese. Each submission is saved as a factory check in your workspace and shows up live in your lot report, ready to be matched by arrival checks later.

Links expire (60 days by default), cap at 500 units, and can be closed or reopened from the product page. Photos uploaded through a link can only land in that link's folder, and the link can only read its own product and checks. Every submitted unit uses your Anthropic API credit.

Database: `factory_links` (one row per product lot, with a random token), plus `inspections.factory_link_id` and `inspections.submitted_by`. See `supabase/migrations/20261001000100_factory_links.sql`.

