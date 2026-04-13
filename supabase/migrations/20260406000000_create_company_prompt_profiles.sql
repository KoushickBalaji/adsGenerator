-- Company prompt profiles (brand-specific creative direction) for multi-company demo mode.

create table if not exists public.company_prompt_profiles (
  company_slug text primary key,
  prompt_style text not null default 'jewellery_generic_v1',
  requires_ambassador boolean not null default true,
  creative_brief text,
  variables jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-update updated_at on row change (reuses public.handle_updated_at from earlier migrations).
drop trigger if exists on_company_prompt_profiles_updated on public.company_prompt_profiles;
create trigger on_company_prompt_profiles_updated
  before update on public.company_prompt_profiles
  for each row
  execute function public.handle_updated_at();

-- RLS: only service role needs access (demo runs are created via Edge Functions).
alter table public.company_prompt_profiles enable row level security;

drop policy if exists "Service role full access company_prompt_profiles" on public.company_prompt_profiles;
create policy "Service role full access company_prompt_profiles"
  on public.company_prompt_profiles for all
  to service_role
  using (true)
  with check (true);

-- Seed known companies with safe defaults (you can tweak later in Supabase).
insert into public.company_prompt_profiles (company_slug, prompt_style, requires_ambassador)
values
  ('bluestone', 'jewellery_businesswoman_v1', true),
  ('generic-model', 'jewellery_generic_v1', true),
  ('product-only', 'product_only_v1', false)
on conflict (company_slug) do nothing;

