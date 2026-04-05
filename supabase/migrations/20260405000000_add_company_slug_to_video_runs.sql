-- Add company scoping to video_runs for multi-company demo mode.

alter table public.video_runs
  add column if not exists company_slug text not null default 'bluestone';

-- Defensive backfill for any pre-existing rows.
update public.video_runs
set company_slug = 'bluestone'
where company_slug is null;

-- Indexes for per-company history + active run queries.
create index if not exists idx_video_runs_company_created_at
  on public.video_runs (company_slug, created_at desc);

create index if not exists idx_video_runs_company_status
  on public.video_runs (company_slug, status);

