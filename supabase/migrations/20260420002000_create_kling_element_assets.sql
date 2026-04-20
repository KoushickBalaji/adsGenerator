-- Map Kling element IDs to the publicly accessible frontal image URL used when creating the element.
-- This allows downstream preview generation to reuse the same identity reference image.

create table if not exists public.kling_element_assets (
  element_id text primary key,
  element_name text not null,
  frontal_url text not null,
  ref_urls jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-update updated_at on row change (reuse the existing trigger function).
drop trigger if exists on_kling_element_assets_updated on public.kling_element_assets;
create trigger on_kling_element_assets_updated
  before update on public.kling_element_assets
  for each row
  execute function public.handle_updated_at();

alter table public.kling_element_assets enable row level security;

create policy "Allow public read access (kling_element_assets)"
  on public.kling_element_assets for select
  using (true);

create policy "Allow service role full access (kling_element_assets)"
  on public.kling_element_assets for all
  using (true)
  with check (true);

