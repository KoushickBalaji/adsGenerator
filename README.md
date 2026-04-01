# BlueStone Video Generation Demo Tool

Paste a BlueStone product URL -> generate a premium 5-15s jewellery ad video in ~2 minutes.

## Goal (Pitch)

Build a minimal, demo-first web tool to showcase automated ad video generation from a product page:
- Input: a BlueStone product URL
- Output: a short, brand-appropriate video generated via Kling
- Proof: a history feed that makes it feel like a real product (not a one-off script)

Keep it simple enough to build fast, but polished enough to present to the BlueStone marketing team.

## Demo Script (What to show in the meeting)

1. Paste a product URL and click "Generate Video"
2. Watch real-time status updates (queued -> processing -> completed)
3. Play the final video, then download
4. Open History to show previous runs and replays

## Tech Stack (Suggested)

- Frontend: Next.js (App Router) on Vercel
- Backend: Supabase Edge Functions
- DB: Supabase Postgres
- Storage: Supabase Storage (final MP4 + optional thumbnail)
- Video Generation: Kling API v3 (image-to-video, multi-shot)
- Prompt Generation: Claude API (dynamic prompt from product details)
- HTML Parsing: deno-dom (JSON-LD / OG tag extraction in Edge Functions)

## MVP Scope (v1)

In scope:
- Single input type: BlueStone product URL
- Dynamic prompt generation via Claude API (one style guide, product-aware prompts)
- No authentication, single shared history feed
- Async generation + status tracking
- Store output in DB; optionally upload MP4 to Supabase Storage for stable hosting

Out of scope (do not build):
- Login/dashboard, multi-user permissions
- Multiple providers or complex editing
- Batch generation
- Music track selection
- "Campaign builder" UI

## User Flow

### 1) Input
- User pastes a BlueStone product URL
- Clicks "Generate Video"

### 2) Processing
- Fetch the product page HTML
- Extract product data (see Scraping Strategy below):
  - `product_title`, `product_description`, `product_category`
  - `input_image`: the single best product image (highest resolution, clean/neutral background). Optionally extract a second image as an end frame.
- Generate a tailored video prompt via Claude API (see Prompt Generation below)
- Create a provider request:
  - image(s) + generated prompt
  - webhook callback (preferred) or Kling API polling fallback
- Write a `video_runs` row and update status as the job progresses

### 3) Output
- Show progress state + timestamps
- Show final video with replay and download

### 4) History
- List previous runs with:
  - source URL
  - status
  - video/thumbnail preview
  - created time

## Scraping Strategy

Extract product data from BlueStone URLs using a prioritized fallback approach:

1. **JSON-LD** (preferred): Parse `<script type="application/ld+json">` blocks for `@type: Product`. Extracts `name`, `image`, `description`, and `category` reliably.
2. **Open Graph tags** (fallback): Extract `og:title`, `og:image`, `og:description` from `<meta>` tags.
3. **HTML selectors** (last resort): Direct DOM scraping of product title headings, image galleries, etc. Most fragile - only use if structured data is absent.

Image selection: prefer the largest/highest-resolution product image. Avoid thumbnails, lifestyle shots, and size-chart images. Look for CDN URL patterns indicating full-size variants.

## Architecture

**Backend status flow (two layers):**

1. **Kling -> DB:** Kling webhook -> `kling-webhook` Edge Function -> updates `video_runs` row. Fallback: `refresh-run` Edge Function polls the **Kling API** (not Supabase) using `provider_job_id`, then updates DB.
2. **DB -> Frontend:** Supabase Realtime subscription on the `video_runs` row pushes status changes to the UI instantly. The frontend never talks to Kling directly.

```
Frontend (Vercel)
  -> Supabase Edge Function: `create-run`
    -> Claude API (generate prompt)
    -> Kling API (async image-to-video job)
  -> Kling webhook -> `kling-webhook` Edge Function -> updates DB
  -> (fallback) `refresh-run` Edge Function -> polls Kling API -> updates DB
  -> Supabase Realtime -> Frontend gets instant status updates
```

## Data Model

### Table: `video_runs`

| Column              | Type       | Description |
|--------------------|------------|------------|
| `id`               | uuid       | primary key |
| `source_url`       | text       | input URL |
| `product_title`    | text       | extracted title |
| `status`           | text       | `queued` / `processing` / `completed` / `failed` |
| `provider`         | text       | `"kling"` |
| `provider_job_id`  | text       | job ID from provider |
| `product_category` | text       | extracted category (ring, necklace, etc.) |
| `input_images`     | jsonb      | array of image URLs (typically 1-2) |
| `prompt`           | text       | generation prompt sent to provider |
| `output_video_url` | text       | final video URL (provider or storage) |
| `thumbnail_url`    | text       | optional |
| `error_message`    | text       | failure reason |
| `created_at`       | timestamp  | |
| `updated_at`       | timestamp  | |

Notes:
- Consider `provider_job_id` unique (per provider).
- Add an index on `created_at` for history queries.

## Storage

### Bucket: `generated-videos`

- Store final MP4s (and optionally thumbnails)
- Public read access is OK for a demo; lock down later for production

## Edge Functions

### 1) `create-run`

Input:
```json
{ "url": "https://www.bluestone.com/..." }
```

Steps:
- Validate URL (must be a BlueStone product URL)
- Fetch HTML and extract product data (see Scraping Strategy):
  - `product_title`, `product_description`, `product_category`
  - Best single product image (+ optional second image as end frame)
- Call Claude API to generate a tailored video prompt from product details
- Insert row in `video_runs` with `status = queued`
- Call Kling API (async image-to-video), passing:
  - input image (1-2 images)
  - generated prompt
  - webhook URL (preferred)
- Save `provider_job_id`, update `status = processing`
- Return `{ runId }`

### 2) `kling-webhook`

Triggered by the provider when the job completes/fails.

Steps:
- Verify request (shared secret if supported)
- Extract provider job ID + status + output URL(s)
- Find matching `video_runs` row
- Update row status and `output_video_url`
- Optional: download provider MP4 and upload to Supabase Storage for stable hosting

### 3) Optional: `refresh-run`

Polling fallback if webhook is unreliable - polls the **Kling API** directly:
- Given `runId`, query Kling API status using `provider_job_id`
- Update DB row if status has changed
- Can be triggered manually from the frontend or on a schedule

## Prompt Generation (via Claude API)

Instead of a fixed template, use Claude API to generate a tailored prompt string for Kling. Kling takes a **single `prompt` field** (max 2,500 characters) - no system/user separation on the Kling side.

The flow is:

1. **Claude API call** generates the prompt (system + user prompt are for Claude, not Kling)
2. **Claude's output** becomes the single `prompt` string sent to Kling

**Claude system prompt (style guide - stays constant):**
```
You are a video ad prompt writer for a luxury jewellery brand. Given product details,
write a single Kling image-to-video prompt (2-3 sentences). Always include:
- Premium studio lighting with soft reflections
- Slow cinematic camera motion (pan, orbit, or gentle zoom)
- A clean, premium background (dark velvet, marble, or gradient)
- Preserve the exact product design - no modifications
Keep the prompt under 200 words. Do not include any text overlays or voiceover directions.
Output only the prompt text, nothing else.
```

**Claude user prompt (dynamic per product):**
```
Product: {product_title}
Category: {product_category}
Description: {product_description}
```

**Claude responds with a prompt string -> sent directly to Kling's `prompt` field:**

For a ring:
> "A luxurious diamond solitaire ring rests on dark velvet. The camera slowly orbits the ring as studio lighting catches each facet, creating soft prismatic reflections. Gentle depth-of-field draws focus to the centre stone."

For a necklace:
> "An elegant gold pendant necklace draped over a polished marble surface. The camera glides along the chain in a slow tracking shot, with warm studio lighting highlighting the delicate metalwork and gemstone details."

## Frontend Pages

- `/` (Home)
  - URL input + Generate button
  - Progress and latest result (via Supabase Realtime subscription on the active run's row)
  - History list

## States

Each run supports:
- `queued`
- `processing`
- `completed`
- `failed`

## Provider Constraints (Kling API v3)

- **Concurrency limit:** 5 simultaneous requests - queue additional requests if needed
- **Single-shot duration:** 3-15 seconds (flexible in v3)
- **Multi-shot:** Up to 6 scenes, max 15 seconds total, min 3 seconds per scene. Set `multi_shot: true` and provide a `multi_prompt` array with per-scene prompts and durations
- **Image input:** `image_list` array - 1 image as `first_frame`, optionally 1 as `end_frame`. Note: multi-shot is incompatible with both first + end frame images
- **Prompt:** Single `prompt` string, max 2,500 characters. For multi-shot, use `multi_prompt` array instead (mutually exclusive with `prompt`)
- **Output URL expiry:** Kling-hosted video URLs may expire - always download and upload to Supabase Storage

## Error States

| Scenario | User Sees | Action |
|----------|-----------|--------|
| Invalid / non-BlueStone URL | Inline validation error below input | Fix URL and retry |
| Scraping fails (no product data found) | "Could not extract product details from this URL" | Try a different product URL |
| Kling generation fails | Error message from provider + retry button | Click retry or try different product |
| Webhook missed (stuck in `processing`) | "Still processing..." with manual refresh button | Triggers `refresh-run` to poll Kling API |

## Environment Variables (Draft)

Frontend (Vercel):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Supabase Edge Functions:
- `KLING_ACCESS_KEY` (from Kling developer portal)
- `KLING_SECRET_KEY` (from Kling developer portal - used with access key to generate JWT)
- `GEMINI_API_KEY` (for Gemini prompt generation)
- `WEBHOOK_SECRET` (optional but recommended)

## Brand Ambassador Elements (Kling Custom Elements)

This demo uses Kling **custom elements** as brand ambassadors.

Important rule:
- Only custom elements whose **name starts with `bluestone`** are eligible to be used in production runs.
  - Example names: `bluestone-anya`, `bluestone-01`, `bluestone-muse-3`

Why:
- Prevents accidentally selecting leftover test elements (e.g. `codex-test`) when `create-run` picks a random ambassador.

How to verify:
- Call `GET /functions/v1/test-prompt?mode=elements` and check the `eligible: true` flag.
- If there are **zero eligible** elements, `create-run` fails with a friendly error asking you to create `bluestone*` elements.

Cleanup note:
- This demo **never uses** elements whose names don’t start with `bluestone`, so leftover test elements are safe to ignore.
- If you want to delete old **custom** elements via the API, use the existing Edge Function (no new function):
  - `POST /functions/v1/test-prompt?mode=elements-delete`
  - Header: `x-admin-secret: <WEBHOOK_SECRET>`
  - Start with `dry_run: true` and verify the list before running with `dry_run: false` + `confirm: "DELETE"`.

How to create a few elements quickly (local bulk upload):
1. Copy `scripts/kling-elements-manifest.example.json` and update names + image paths (you can point to different folders on `D:\`).
2. Set `KLING_ACCESS_KEY` and `KLING_SECRET_KEY` in your shell.
3. Run `node scripts/kling-elements-upload.mjs --manifest "D:\path\to\elements.manifest.json"`
   - If Kling expects data-URLs instead of raw Base64, rerun with `--data-url`.

How to create a few elements quickly (Vercel-hosted images + Postman, no local keys):
1. Add images to the frontend repo (example structure):
   - `frontend/public/kling-elements/bluestone-anya/front.jpg`
   - `frontend/public/kling-elements/bluestone-anya/ref1.jpg`
   - This repo also includes sample sets for `bluestone-muse-01` -> `bluestone-muse-04` under `frontend/public/kling-elements/`.
2. Deploy the frontend to Vercel (the images must be publicly reachable by URL for Kling to ingest them).
3. Call the existing Edge Function (no new function):
   - `POST /functions/v1/test-prompt?mode=elements-create`
   - Header: `x-admin-secret: <WEBHOOK_SECRET>`
   - Body example (or start from `scripts/bluestone-elements-create.example.json`):
     ```json
     {
       "assets_base_url": "https://<your-vercel-domain>",
        "elements": [
          {
           "name": "bluestone-anya",
           "frontal_path": "/kling-elements/bluestone-anya/front.jpg",
           "ref_paths": ["/kling-elements/bluestone-anya/ref1.jpg", "/kling-elements/bluestone-anya/ref2.jpg"]
         }
       ]
     }
     ```

Note:
- These images are not linked from the UI, but any publicly reachable URL is technically accessible if someone knows the exact path.

How to delete old `bluestone*` elements (API cleanup):
1. List what exists:
   - `GET /functions/v1/test-prompt?mode=elements&kind=custom&all=true&pageSize=100`
2. Dry run delete by prefix:
   - `POST /functions/v1/test-prompt?mode=elements-delete`
   - Header: `x-admin-secret: <WEBHOOK_SECRET>`
   - Body: `scripts/bluestone-elements-delete.example.json` (starts as `dry_run: true`)
3. Real delete:
   - Re-run with `dry_run: false` and `confirm: "DELETE"`.

## Success Criteria

- User pastes URL -> gets video in < 2 minutes
- Output looks like a real jewellery ad (premium lighting + motion)
- History clearly shows past runs
- No visible backend complexity in the UI

## Risks / Notes (Demo Reality)

- Product page scraping can break if markup changes; prefer JSON-LD / OG tags when available.
- Provider output URLs may expire; upload final MP4 to Supabase Storage for stability.
- Webhooks can fail; `refresh-run` polling is a good fallback.

## Future Enhancements (Not in v1)

- Multi-shot videos (Kling v3 native support: up to 6 scenes, 15s total)
- Multiple templates/styles
- Batch generation
- Brand-specific prompt tuning
- Model/face consistency (if required later)

## Before the Demo (Checklist)

- [ ] Pre-generate 3-5 videos across product categories (ring, necklace, earring, bracelet) so the history feed looks populated
- [ ] Verify all pre-generated videos are stored in Supabase Storage (not relying on expired Kling URLs)
- [ ] Have 2-3 backup product URLs ready in case a live generation is slow
- [ ] Test the full flow end-to-end at least once on the day of the demo

---

This is demo-first, not production-grade. Optimize for:
- speed of build
- output quality
- simplicity
