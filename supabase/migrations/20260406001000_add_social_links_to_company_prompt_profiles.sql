-- Add social profile links for easy reference during outreach + prompt tuning.

alter table if exists public.company_prompt_profiles
  add column if not exists social_links jsonb not null default '{}'::jsonb;

