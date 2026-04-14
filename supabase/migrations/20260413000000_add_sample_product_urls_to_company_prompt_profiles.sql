alter table public.company_prompt_profiles
  add column if not exists sample_product_urls text[];

