-- Store per-company Kling custom element IDs (model personas / ambassadors) to keep
-- character continuity across a brand's demo runs.

alter table public.company_prompt_profiles
  add column if not exists kling_element_ids jsonb not null default '[]'::jsonb;

