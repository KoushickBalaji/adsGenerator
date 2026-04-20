-- Add occasion presets and generated preview images to runs.

alter table public.video_runs
  add column if not exists occasion text not null default 'auto';

alter table public.video_runs
  add column if not exists preview_images jsonb not null default '[]'::jsonb;

alter table public.video_runs
  add column if not exists preview_error text;

-- Storage bucket for generated preview images
insert into storage.buckets (id, name, public)
values ('generated-images', 'generated-images', true)
on conflict (id) do nothing;

-- Storage RLS: allow public read on generated-images bucket
create policy "Public read generated-images"
  on storage.objects for select
  using (bucket_id = 'generated-images');

-- Storage RLS: allow service role to upload preview images
create policy "Service role upload generated-images"
  on storage.objects for insert
  with check (bucket_id = 'generated-images');

