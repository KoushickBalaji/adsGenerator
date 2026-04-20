-- Store which Kling element (ambassador) was used for this run (optional).
-- Useful for tying still previews to the same identity reference.

alter table public.video_runs
  add column if not exists ambassador_element_id text;

alter table public.video_runs
  add column if not exists ambassador_element_name text;

create index if not exists idx_video_runs_company_ambassador_element
  on public.video_runs (company_slug, ambassador_element_id);

