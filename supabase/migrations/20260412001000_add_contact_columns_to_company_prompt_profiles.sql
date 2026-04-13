-- Separate outreach contact fields from JSONB for easier filtering in Supabase UI.
-- We keep `social_links` as the source-of-truth for scraped/raw metadata, but mirror the
-- most important outreach fields into dedicated columns.

alter table if exists public.company_prompt_profiles
  add column if not exists emails_general text[] not null default '{}'::text[],
  add column if not exists emails_support text[] not null default '{}'::text[],
  add column if not exists emails_sales text[] not null default '{}'::text[],
  add column if not exists emails_founder text[] not null default '{}'::text[],
  add column if not exists emails_other text[] not null default '{}'::text[],
  add column if not exists linkedin_company_url text,
  add column if not exists linkedin_people_urls text[] not null default '{}'::text[];

-- Convenience computed columns for quick outreach usage.
alter table if exists public.company_prompt_profiles
  add column if not exists email_primary text generated always as (
    coalesce(
      nullif(emails_sales[1], ''),
      nullif(emails_founder[1], ''),
      nullif(emails_general[1], ''),
      nullif(emails_other[1], ''),
      nullif(emails_support[1], '')
    )
  ) stored;

alter table if exists public.company_prompt_profiles
  add column if not exists linkedin_person_primary text generated always as (
    nullif(linkedin_people_urls[1], '')
  ) stored;

create index if not exists company_prompt_profiles_email_primary_idx
  on public.company_prompt_profiles (email_primary);

create index if not exists company_prompt_profiles_linkedin_company_url_idx
  on public.company_prompt_profiles (linkedin_company_url);

