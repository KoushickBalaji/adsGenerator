-- Backfill up to 10 distinct URLs per company from existing demo runs.
-- Preference: newest URLs first, regardless of status (completed runs usually exist already).

with ranked as (
  select
    vr.company_slug,
    vr.source_url,
    row_number() over (
      partition by vr.company_slug
      order by max(vr.created_at) desc
    ) as rn
  from public.video_runs vr
  where vr.source_url is not null
    and length(trim(vr.source_url)) > 0
  group by vr.company_slug, vr.source_url
),
agg as (
  select
    company_slug,
    array_agg(source_url order by rn) as urls
  from ranked
  where rn <= 10
  group by company_slug
)
update public.company_prompt_profiles cpp
set sample_product_urls = agg.urls
from agg
where agg.company_slug = cpp.company_slug;
