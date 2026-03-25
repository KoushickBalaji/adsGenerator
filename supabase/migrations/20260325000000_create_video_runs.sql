-- Video runs table
create table public.video_runs (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  product_title text,
  product_category text,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  provider text not null default 'kling',
  provider_job_id text,
  input_images jsonb default '[]'::jsonb,
  prompt text,
  output_video_url text,
  thumbnail_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for history queries (newest first)
create index idx_video_runs_created_at on public.video_runs (created_at desc);

-- Unique index on provider job ID (when set)
create unique index idx_video_runs_provider_job_id
  on public.video_runs (provider_job_id)
  where provider_job_id is not null;

-- Auto-update updated_at on row change
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger on_video_runs_updated
  before update on public.video_runs
  for each row
  execute function public.handle_updated_at();

-- Enable realtime for this table
alter publication supabase_realtime add table public.video_runs;

-- RLS: allow anonymous read access (no auth needed for demo)
alter table public.video_runs enable row level security;

create policy "Allow public read access"
  on public.video_runs for select
  using (true);

create policy "Allow service role full access"
  on public.video_runs for all
  using (true)
  with check (true);

-- Storage bucket for generated videos
insert into storage.buckets (id, name, public)
values ('generated-videos', 'generated-videos', true)
on conflict (id) do nothing;

-- Storage RLS: allow public read on generated-videos bucket
create policy "Public read generated-videos"
  on storage.objects for select
  using (bucket_id = 'generated-videos');

-- Storage RLS: allow service role to upload
create policy "Service role upload generated-videos"
  on storage.objects for insert
  with check (bucket_id = 'generated-videos');
