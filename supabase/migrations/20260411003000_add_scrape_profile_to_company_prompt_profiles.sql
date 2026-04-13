-- Store website audit + scraping methodology per company (used for multi-company demo mode).

alter table if exists public.company_prompt_profiles
  add column if not exists has_ecommerce boolean,
  add column if not exists website_notes text,
  add column if not exists scrape_profile jsonb not null default '{}'::jsonb;

