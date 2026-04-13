# Jewellery Video Generation Demo Tool

Paste a supported jewellery product URL and generate a premium ~10s video ad.

This repo is a **shared demo sandbox** (not production multi-tenant). It supports multiple companies in one UI, while the backend enforces per-company URL allowlists, scraping behavior, prompt policy, and spend limits.

## What This Does

- Scrapes product title/description/category and multiple product-angle images
- Uses Gemini to write a two-shot Kling prompt
- Starts a Kling Omni-Video job with up to **4** reference images
- Streams status updates to the UI via Supabase Realtime
- Uploads completed MP4s to Supabase Storage for stable hosting

## Tech Stack

- Frontend: Next.js (App Router) in `frontend/`
- Backend: Supabase Edge Functions in `supabase/functions/`
- DB: Supabase Postgres
- Storage: Supabase Storage bucket `generated-videos`
- Prompt generation: Gemini (`GEMINI_API_KEY`)
- Video generation: Kling Omni-Video (`KLING_ACCESS_KEY`/`KLING_SECRET_KEY`)

## Demo UX

- Landing page: paste a product URL; it routes to the correct company demo
- Company demo route: `/demo/<companySlug>`
- History list is filtered by `company_slug`
- “Reference Images” panel shows up to **4** images (the exact images sent to Kling)

## High-Level Flow

0. (Optional) Frontend calls `random-product` with `{ companySlug }` to get a random product URL when the user clicks “Try a random item”
1. Frontend calls `create-run` with `{ companySlug, url, runId? }`
2. `create-run` inserts a `video_runs` row, scrapes the product page, generates a Gemini prompt, calls Kling, then updates the run with:
   - `provider_job_id`
   - `input_images` (first 4 reference images)
   - `prompt`
3. Kling calls `kling-webhook` on completion; the function uploads the MP4 to Supabase Storage and marks the run `completed`
4. If webhook delivery fails, the UI periodically calls `refresh-run` which polls Kling and performs the same upload + status update

## Environment Variables

Frontend (`frontend/`):

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Supabase Edge Functions (Supabase project env vars):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
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
- `frontend/.env.example` (frontend)

## Data Model

### `public.video_runs`

One row per generation attempt.

- `company_slug`: which company demo this run belongs to
- `input_images`: JSON array of up to **4** reference image URLs (used by Kling and shown in the UI)
- `provider_job_id`: Kling task ID (used by webhook + polling)
- `output_video_url`: Supabase Storage public URL (when upload succeeds)

### `public.company_prompt_profiles`

One row per company to hold:

- `website_url`
- website audit fields: `has_ecommerce`, `website_notes`, `scrape_profile` (JSONB)
- prompt overrides: `prompt_style`, `requires_ambassador`, `creative_brief`, `variables`
- ambassador overrides: `kling_element_ids` (optional; element IDs override prefix-based selection)

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
- `input_images`: up to 12 URLs (best-effort)

Adapters:

- `bluestone`: BlueStone internal API for metadata + HTML gallery extraction for multiple angles
- `shopify`: prefers `/products/<handle>.js` (or `.json`) for clean `title/description/images`, falls back to HTML when blocked
- `generic`: HTML extraction (JSON-LD `Product` → OG tags → gallery selectors → last-resort image candidates)

Image usage rules:

- Kling uses up to **4** reference images per run
- When a product has >4 images and at least 4 are fetchable, Gemini can select the best 4
- Additional images (beyond the first 4) are used as **prompt-only context** (not sent to Kling)

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

Admin utility endpoints (via `supabase/functions/test-prompt`):

- List elements:
  - `GET /functions/v1/test-prompt?mode=elements&kind=custom|preset|all&all=true&pageSize=100&maxPages=20&prefix=<prefix>`
- Create elements in bulk:
  - `POST /functions/v1/test-prompt?mode=elements-create`
  - Header: `x-admin-secret: <WEBHOOK_SECRET>`
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

