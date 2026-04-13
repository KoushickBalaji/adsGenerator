-- Demo URL helpers for outreach (makes it easy to copy/paste links from Supabase UI).

alter table if exists public.company_prompt_profiles
  add column if not exists demo_url text,
  add column if not exists demo_http_status integer,
  add column if not exists demo_verified_at timestamptz;

-- Deterministic path for every company row.
alter table if exists public.company_prompt_profiles
  add column if not exists demo_path text generated always as ('/demo/' || company_slug) stored;

-- Convenience: consider any 2xx/3xx as OK.
alter table if exists public.company_prompt_profiles
  add column if not exists demo_ok boolean generated always as (
    demo_http_status is not null and demo_http_status >= 200 and demo_http_status < 400
  ) stored;

create index if not exists company_prompt_profiles_demo_ok_idx
  on public.company_prompt_profiles (demo_ok);

