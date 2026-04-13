-- Store the official company website for easy reference + outreach.

alter table if exists public.company_prompt_profiles
  add column if not exists website_url text;

