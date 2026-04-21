-- Persist all scraped product images (not just the first 4 used for Kling).
--
-- `input_images` remains the 1–4 reference images actually sent to Kling (and shown in the UI as "Reference Images").
-- `scraped_images` stores the full scraped gallery (best-effort; bounded by scraper maxReferenceImages).

alter table public.video_runs
  add column if not exists scraped_images jsonb not null default '[]'::jsonb;

