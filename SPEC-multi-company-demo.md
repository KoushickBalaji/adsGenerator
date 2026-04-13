Multi-Company Demo Mode (adsGenerator)

Goal

Enable one shared UI to demo multiple jewellery companies safely and cleanly, without duplicating pages, while keeping the codebase maintainable and avoiding “if company === …” sprawl.

This is a demo sandbox, not a production multi-tenant system.

Definition of done

- A single deployed frontend supports routes like:
  - `/demo/bluestone`
  - `/demo/melorra`
- The UI shows history filtered by the current `companySlug`.
- Backend enforces company constraints (hosts, scraper adapter, prompt policy, spend limits) regardless of frontend behavior.
- Costs are protected per company:
  - Lifetime successful video cap (mandatory)
  - Concurrent run cap (recommended)
  - Attempt throttling (optional)

Non-goals

- No onboarding flow, no user accounts.
- No strict tenant isolation via auth/RLS (this is a shared sandbox).
- No “paste any ecommerce URL” promise. Each demo is a controlled, allowlisted mode.
- No per-video persona selection UI.

Current architecture

Frontend

- Next.js app in `frontend/`.
- Landing page accepts a product URL and routes to the appropriate company demo.
- Company demo route: `frontend/src/app/demo/[company]`.
- Calls Supabase Edge Functions:
  - `create-run` to start a run
  - `random-product` to fetch a random product URL (for “Try a random item”)
  - `refresh-run` as a polling fallback
- Subscribes to Supabase Realtime updates on `public.video_runs`.

Backend

Supabase Edge Functions:

- `create-run`: orchestrates scrape → Gemini prompt → Kling job.
- `random-product`: discovers a random product URL via the company sitemap (best-effort).
- `kling-webhook`: marks completion and uploads MP4 to Supabase Storage.
- `refresh-run`: polling fallback (queries Kling by `provider_job_id`).

Shared backend modules:

- `supabase/functions/_shared/companyConfig.ts`: company registry (allowlist + behavior + limits).
- `supabase/functions/_shared/scraper.ts`: scraper router + adapters.
- `supabase/functions/_shared/geminiPrompt.ts`: prompt policy + image selection + Gemini request.
- `supabase/functions/_shared/kling.ts`: Kling API client.
- `supabase/functions/_shared/companyPromptProfile.ts`: optional per-company overrides loaded from DB.

Data model

`public.video_runs`

- Each row is a generation attempt.
- `company_slug` scopes all reads/writes.
- `input_images` stores the first **4** reference images used for Kling and shown in the UI.

`public.company_prompt_profiles`

One row per company. Used for:

- `website_url`: canonical website.
- Website audit info:
  - `has_ecommerce`
  - `website_notes`
  - `scrape_profile` (JSONB, includes discovered product URL + adapter hint)
- Prompt overrides:
  - `prompt_style`, `requires_ambassador`, `creative_brief`, `variables`
- Kling element overrides:
  - `kling_element_ids` (optional; if present, backend uses these IDs rather than prefix-based selection)

Company config registry

Per-company behavior is defined in `companyConfig.ts` and includes:

- URL allowlist: `allowedHosts`
- Scraper selection: `scraper.adapter` (`bluestone` | `shopify` | `generic`)
- Prompt policy: `prompt.requiresAmbassador`, `prompt.style`
- Kling defaults/model candidates
- Spend/abuse limits:
  - `limits.maxConcurrentRuns`
  - `limits.maxLifetimeSuccessfulVideos`
  - `limits.maxAttemptsPerDay` (optional)

In addition to per-company limits, `create-run` enforces a demo-wide concurrency cap across *all* companies
(currently **5** active runs total).

The backend rejects:

- Unknown `companySlug` (“Invalid demo link.”)
- URLs with a hostname not in `allowedHosts` for that company

Scraping adapters

All scrapers return a unified `ProductData` shape:

- `product_title`
- `product_description`
- `product_category`
- `input_images`: up to 12 candidate image URLs

Adapters:

- `bluestone`: BlueStone metadata API + HTML gallery extraction
- `shopify`: `/products/<handle>.js` or `.json` endpoints; HTML fallback
- `generic`: JSON-LD Product → OG tags → gallery selectors → fallback image candidates

Reference images and why only 4 go to Kling

- Kling Omni-Video uses up to 4 images in `image_list`.
- The prompt template uses `<<<image_1>>>..<<<image_4>>>` tokens.
- When >4 images exist, Gemini can select the best 4 (when enough are fetchable). Remaining images are used as prompt-only context.

Operational scripts

- `scripts/company-website-audit.mjs`: audits sites and backfills `has_ecommerce`, `website_notes`, `scrape_profile`.
- `scripts/company-smoke-generate.mjs`: seeds completed runs to populate History and validate scraping.
- `scripts/report-reference-images.mjs`: reports reference image counts for latest completed runs.
- `scripts/company-prompt-profiles-research.mjs`: uses the OpenAI Responses API (with web search) to generate and upsert prompt profile overrides.

How to onboard a company (repeatable checklist)

1. Add company config entry in `companyConfig.ts`.
2. Add hostname → companySlug mapping in `frontend/src/lib/company.ts`.
3. Insert a `company_prompt_profiles` row with `website_url`.
4. Run `company-website-audit.mjs` and confirm `has_ecommerce=true`.
5. Run `company-smoke-generate.mjs` and confirm reference image count is 3–4.

How to remove a company

- Remove from backend registry (`companyConfig.ts`) and frontend mapping (`frontend/src/lib/company.ts`).
- Delete from `company_prompt_profiles` (and optionally delete `video_runs`) via a migration.

