-- Per-company reference image for preview image generation (Gemini).
-- This is optional and best-effort; used only for still previews.

alter table public.company_prompt_profiles
  add column if not exists ambassador_reference_image_url text;

