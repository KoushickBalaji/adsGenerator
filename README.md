# Jewellery Video Generation Demo Tool

Paste a supported jewellery product URL and generate a premium ~10s video ad.

This repo is a **shared demo sandbox** (not production multi-tenant). It supports multiple companies in one UI, while the backend enforces per-company URL allowlists, scraping behavior, prompt policy, and spend limits.

## What This Does

- Scrapes product title/description/category and multiple product-angle images
- Uses Gemini to write a two-shot Kling prompt
- Starts a Kling Omni-Video job with up to **4** reference images
- Optionally generates 2 storyboard-style still previews (Shot 1 + Shot 2) using Gemini image generation
- Still previews can include multiple reference images (ambassador identity + product angles), capped by the Gemini model limit (currently **14** images per prompt for `gemini-3-pro-image-preview`)
- Streams status updates to the UI via Supabase Realtime
- Uploads completed MP4s to Supabase Storage for stable hosting

## Tech Stack

- Frontend: Next.js (App Router) in `frontend/`
- Backend: Supabase Edge Functions in `supabase/functions/`
- DB: Supabase Postgres
- Storage: Supabase Storage buckets `generated-videos` (MP4) and `generated-images` (preview stills)
- Prompt + image generation: Gemini (`GEMINI_API_KEY`, optional `GEMINI_IMAGE_MODEL` for still previews)
- Video generation: Kling Omni-Video (`KLING_ACCESS_KEY`/`KLING_SECRET_KEY`)

## Static Persona Assets (Kling Elements)

This repo includes a small set of persona images used when creating Kling custom elements:

- Location in repo: `frontend/public/kling-elements/`
- Public URL shape (same domain as the deployed frontend): `https://<your-domain>/kling-elements/<element-name>/<file>`

Default demo persona asset paths:

- `bluestone-muse-01`: `/kling-elements/bluestone-muse-01/Front.jpg`
- `bluestone-muse-02`: `/kling-elements/bluestone-muse-02/front.png`
- `bluestone-muse-03`: `/kling-elements/bluestone-muse-03/Front.jpg`
- `bluestone-muse-04`: `/kling-elements/bluestone-muse-04/front.jpeg`
- `thangamayil-muse-01`: `/kling-elements/thangamayil-muse-01/front.jpg`
  - Refs: `/kling-elements/thangamayil-muse-01/ref1.png`, `/kling-elements/thangamayil-muse-01/ref2.jpg`, `/kling-elements/thangamayil-muse-01/ref3.jpg`

Thangamayil still-preview identity:

- If you want Thangamayil previews to use `thangamayil-muse-01`, set `company_prompt_profiles.ambassador_reference_image_url` to the deployed URL for `/kling-elements/thangamayil-muse-01/front.jpg` (there is a migration to do this automatically).
- Current demo URL: `https://ads-generator-hazel.vercel.app/kling-elements/thangamayil-muse-01/front.jpg`

## Demo UX

- Landing page: paste a product URL; it routes to the correct company demo
- Company demo route: `/demo/<companySlug>`
- History list is filtered by `company_slug`
- Occasion preset: choose `Auto | Casual | Partywear | Marriage/Wedding | Workwear | Festive`
- “Generate shot previews” toggle: best-effort still previews (non-blocking)
- “Shot Previews” panel shows up to **2** still images (Shot 1 + Shot 2)
- “Reference Images” panel shows up to **4** images (the exact images sent to Kling)

## High-Level Flow

0. (Optional) Frontend calls `random-product` with `{ companySlug }` to get a random product URL when the user clicks “Try a random item”
1. Frontend calls `create-run` with `{ companySlug, url, runId?, occasion? }`
2. `create-run` inserts a `video_runs` row, scrapes the product page, picks a brand ambassador (optional), generates a Gemini prompt, calls Kling, then updates the run with:
   - `provider_job_id`
   - `input_images` (first 4 reference images)
   - `ambassador_element_id` / `ambassador_element_name` (when a persona is used)
   - `prompt`
3. (Optional) Frontend calls `generate-previews` with `{ companySlug, runId }`; the function generates 2 still images and updates:
   - `preview_images` (Shot 1 + Shot 2)
   - `preview_error` (non-blocking errors only)
4. Kling calls `kling-webhook` on completion; the function uploads the MP4 to Supabase Storage and marks the run `completed`
5. If webhook delivery fails, the UI periodically calls `refresh-run` which polls Kling and performs the same upload + status update

## Environment Variables

Frontend (`frontend/`):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Supabase Edge Functions (Supabase project env vars):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `GEMINI_IMAGE_MODEL` (optional; defaults to `gemini-3-pro-image-preview` for still previews)
- `KLING_ACCESS_KEY`
- `KLING_SECRET_KEY`
- `WEBHOOK_SECRET` (optional)
- `KLING_BASE_URL` (optional; defaults to `https://api-singapore.klingai.com`)

Local scripts (run from repo root):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY` (only for `scripts/company-prompt-profiles-research.mjs`)
- `OPENAI_BASE_URL` (optional; defaults to `https://api.openai.com/v1`)

Example env templates:

- `.env.example` (scripts)
- `supabase/.env.example` (Supabase Edge Functions)
- `frontend/.env.example` (frontend)

## Data Model

### `public.video_runs`

One row per generation attempt.

- `company_slug`: which company demo this run belongs to
- `occasion`: preset steering for setting/wardrobe/mood (`auto|casual|partywear|marriage|workwear|festive`)
- `input_images`: JSON array of up to **4** reference image URLs (used by Kling and shown in the UI)
- `scraped_images`: JSON array of scraped product gallery image URLs (best-effort; bounded by scraper `maxReferenceImages`)
- `ambassador_element_id` / `ambassador_element_name`: which Kling element was used for this run (when personas are enabled)
- `provider_job_id`: Kling task ID (used by webhook + polling)
- `output_video_url`: Supabase Storage public URL (when upload succeeds)
- `preview_images`: JSON array of up to **2** still preview URLs (Shot 1 + Shot 2)
- `preview_error`: non-blocking error message for still previews

### `public.company_prompt_profiles`

One row per company to hold:

- `website_url`
- website audit fields: `has_ecommerce`, `website_notes`, `scrape_profile` (JSONB)
- optional demo UX helpers: `sample_product_urls` (up to ~10 curated product URLs for “Try a random item”)
- prompt overrides: `prompt_style`, `requires_ambassador`, `creative_brief`, `variables`
- ambassador overrides: `kling_element_ids` (optional; element IDs override prefix-based selection)
- optional still-preview identity: `ambassador_reference_image_url` (public URL; used as a Gemini reference image)

### `public.kling_element_assets`

Mapping table to reuse the same frontal image used when creating Kling custom elements:

- `element_id`: Kling element ID
- `frontal_url`: public URL of the element’s frontal/cover image
- Used by `generate-previews` when a run has `ambassador_element_id` but the company has no `ambassador_reference_image_url`

## Company Configuration (Backend Enforcement)

Per-company behavior is defined in:

- `supabase/functions/_shared/companyConfig.ts`

Each company config defines:

- `allowedHosts`: which product URLs are accepted for that demo
- `scraper.adapter`: `bluestone` | `shopify` | `generic`
- `scraper.maxReferenceImages`: max candidate images extracted (up to 12)
- Kling defaults and model candidates
- Prompt policy (`requiresAmbassador`, `style`)
- Spend/abuse limits (per-company concurrency, lifetime successful videos, optional daily attempt cap)

The backend also enforces a demo-wide concurrency cap across *all* companies (currently **5** active runs total),
in addition to each company’s `limits.maxConcurrentRuns` (currently **3** active runs per company).

The backend rejects unsupported `companySlug` (returns “Invalid demo link.”) and rejects URLs whose hostname is not in that company’s `allowedHosts` list.

## Scraping + Image Handling

The scraper returns:

- `product_title`, `product_description`, `product_category`
- `input_images`: product gallery images (best-effort; bounded by `companyConfig.scraper.maxReferenceImages`, currently **30**)

Adapters:

- `bluestone`: BlueStone internal API for metadata + HTML gallery extraction for multiple angles
- `shopify`: prefers `/products/<handle>.js` (or `.json`) for clean `title/description/images`, falls back to HTML when blocked
- `generic`: HTML extraction (JSON-LD `Product` → OG tags → gallery selectors → last-resort image candidates)

Image usage rules:

- Kling uses up to **4** reference images per run
- When a product has >4 images and at least 4 are fetchable, Gemini can select the best 4
- Additional images are stored on `video_runs.scraped_images` and (best-effort) used by `generate-previews` as Gemini product references (capped by the Gemini per-prompt image limit; extra angles are spread across Shot 1 + Shot 2)

Special cases:

- Melorra: product pages often embed `enlarged_images` paths; the scraper reconstructs high-res URLs so multiple angles are available.

## Operational Scripts

All scripts live in `scripts/` and can read env vars from `.env.local`.

- `node scripts/company-prompt-profiles-seed.mjs --companies scripts/companies.india.json`
  - Upserts minimal `company_prompt_profiles` rows (primarily `website_url`) from a JSON list
- `node scripts/company-prompt-profiles-delete.mjs --company <slug>`
  - Deletes one or more `company_prompt_profiles` rows by slug (useful for cleaning up invalid/non-shoppable sites)
- `node scripts/company-website-audit.mjs --out-dir scripts/out/website-audit`
  - Audits each company website and backfills `has_ecommerce`, `website_notes`, and `scrape_profile`
  - For sites that block automated fetches (e.g. 402/403/429/TLS errors), it records `has_ecommerce=null` and a “manual check needed” note (so the table still captures current state)
- `node scripts/company-contacts-extract.mjs --out-dir scripts/out/contacts`
  - Extracts **publicly listed** contact emails from each company site (homepage + contact/about pages) and stores them in `company_prompt_profiles.social_links.emails`
  - Also captures any Instagram/LinkedIn links discovered and stores them on `company_prompt_profiles.social_links`
  - Mirrors email buckets into dedicated columns for easier filtering in Supabase UI: `emails_general`, `emails_support`, `emails_sales`, `emails_founder`, `emails_other` (plus computed `email_primary`)
- `node scripts/company-linkedin-people-research.mjs --out-dir scripts/out/linkedin`
  - Uses OpenAI `web_search` to find the official LinkedIn company page + founder/CXO profile URLs and stores them in `company_prompt_profiles.social_links.linkedin_company_url` and `company_prompt_profiles.social_links.linkedin_people`
  - If OpenAI quota/tooling isn’t available, you can still add LinkedIn entry points via `company-linkedin-manual-merge.mjs` (using URLs found in normal web search or from each company’s own site)
- `node scripts/company-linkedin-people-from-website.mjs`
  - Derives `linkedin_company_urls` + `linkedin_people_urls` from on-site LinkedIn links already captured in `social_links.linkedin` (no web search)
- `node scripts/company-linkedin-company-ddg-jina.mjs --out-dir scripts/out/linkedin-company`
  - Uses DuckDuckGo HTML (fetched via `r.jina.ai`) to discover LinkedIn **company page** URLs and stores them in `company_prompt_profiles.social_links.linkedin_company_urls` (no OpenAI API)
  - Records `company_prompt_profiles.social_links.linkedin_company_audit.no_company_page_found=true` when no LinkedIn company page is discoverable (so reruns can skip unless forced)
- `node scripts/company-linkedin-ddg-search.mjs --out-dir scripts/out/linkedin-ddg`
  - Uses DuckDuckGo HTML (fetched via `r.jina.ai`) to discover LinkedIn **company pages** + **people profile** entry points (founder/CXO-ish queries)
  - Stores results in `company_prompt_profiles.social_links.linkedin_company_urls` and `company_prompt_profiles.social_links.linkedin_people_urls` (no OpenAI API)
  - Mirrors key fields into columns: `linkedin_company_url`, `linkedin_people_urls` (plus computed `linkedin_person_primary`)
- `node scripts/company-emails-search-ddg-jina.mjs --out-dir scripts/out/email-search`
  - Fallback email discovery: searches `site:<domain>` via DuckDuckGo (fetched through `r.jina.ai`) to find **publicly listed** contact email addresses when direct scraping finds none
- `node scripts/outreach-wave-init.mjs`
  - Sets `outreach_wave` (and optionally resets `outreach_status`) for the first set of companies you want to contact, so you can track outreach directly from the `company_prompt_profiles` table
- `node scripts/demo-pages-verify.mjs --wave 1`
  - Verifies demo pages are reachable (and optionally records `demo_http_status` + `demo_verified_at` on `company_prompt_profiles`)
- `node scripts/company-linkedin-manual-merge.mjs --in scripts/out/linkedin-manual/<file>.json`
  - Merges manually researched LinkedIn company/people URLs into `social_links.linkedin_company_urls` and `social_links.linkedin_people_urls` (useful when automated web search is blocked or rate-limited)
- `node scripts/company-smoke-generate.mjs --out-dir scripts/out/smoke --videos-per-company 1`
  - Seeds 1+ completed run per company (populates History and validates scraping)
- `node scripts/report-reference-images.mjs`
  - Prints how many reference images were stored on the latest completed run per company
- `node scripts/company-prompt-profiles-research.mjs --companies scripts/companies.bangalore.json --out-dir scripts/out` (or any JSON list matching the same shape)
  - Uses the OpenAI Responses API with web search to generate and upsert prompt profile overrides
- `node scripts/kling-elements-list.mjs`
  - Lists Kling elements and helps collect element IDs for `kling_element_ids`

`scripts/out/` is intentionally gitignored (research/audit artifacts).

## Adding a New Company

1. Add a config entry in `supabase/functions/_shared/companyConfig.ts`:
   - `slug`, `allowedHosts`, scraper adapter, prompt policy, limits
2. Add hostname mapping in `frontend/src/lib/company.ts` so the landing page can route URLs to the correct demo
3. Insert a `company_prompt_profiles` row (at minimum: `company_slug`, `website_url`)
   - Either manually in Supabase or via `node scripts/company-prompt-profiles-seed.mjs --companies <file>`
4. Run `company-website-audit.mjs` to populate `has_ecommerce`, `website_notes`, and `scrape_profile`
5. Run `company-smoke-generate.mjs` to seed a completed run and validate multi-image extraction

## Removing a Company

- Remove from backend config (`companyConfig.ts`) and frontend host mapping (`frontend/src/lib/company.ts`)
- Delete its row in `company_prompt_profiles` (and optionally purge `video_runs`) via a migration so the shared demo UI can’t route to it

## Kling Elements (Model Personas)

The demo can optionally use Kling “elements” (custom personas) to keep a consistent on-screen model.

- Per-company element IDs can be set on `company_prompt_profiles.kling_element_ids`
- If no IDs are set, the backend falls back to prefix-based selection from `companyConfig.kling.ambassador.elementPrefixCandidates`
- Still preview identity reference (`generate-previews`): uses `company_prompt_profiles.ambassador_reference_image_url` if set; otherwise tries `kling_element_assets.frontal_url` for the run’s `ambassador_element_id` (best-effort).

Admin utility endpoints (via `supabase/functions/test-prompt`):

- List elements:
  - `GET /functions/v1/test-prompt?mode=elements&kind=custom|preset|all&all=true&pageSize=100&maxPages=20&prefix=<prefix>`
- Create elements in bulk:
  - `POST /functions/v1/test-prompt?mode=elements-create&prefix=<prefix>` (or set `"prefix"` in the JSON body)
  - Header: `x-admin-secret: <WEBHOOK_SECRET>`
  - Deployment note: keep Supabase JWT verification disabled for `test-prompt`; it is protected by `x-admin-secret`, and gateway JWT verification will reject direct admin calls before this function runs.
  - Names are validated to start with the chosen prefix (set `"enforce_prefix": false` to disable).
  - Also records `public.kling_element_assets` so still previews can reuse the same frontal reference image.
- Delete elements in bulk:
  - `POST /functions/v1/test-prompt?mode=elements-delete`
  - Header: `x-admin-secret: <WEBHOOK_SECRET>`

Local bulk upload helpers:

- `node scripts/kling-elements-upload.mjs --manifest scripts/kling-elements-manifest.example.json`
- `node scripts/kling-elements-list.mjs --prefix <prefix>`

## Before You Share Demo Links

- Seed at least 1 completed run per company (`company-smoke-generate.mjs`) so the History panel looks real
- Verify each company produces 3–4 reference images on the latest run (`report-reference-images.mjs`)
- Keep a backup product URL per company in case a product page changes

