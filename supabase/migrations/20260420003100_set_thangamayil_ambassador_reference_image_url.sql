-- Configure a per-company ambassador reference image for Thangamayil still previews.
--
-- This is used by `generate-previews` to keep the same ambassador identity in Shot 1/2.
-- It is intentionally not tied to a Kling `element_id` (works even when elements were created manually).
--
-- Source file in repo: `frontend/public/kling-elements/thangamayil-muse-01/front.jpg`
-- Deployed URL shape: `https://<your-domain>/kling-elements/thangamayil-muse-01/front.jpg`

with base as (
  select regexp_replace(demo_url, '/demo/.*$', '') as assets_base_url
  from public.company_prompt_profiles
  where demo_url is not null and demo_url <> ''
  limit 1
)
update public.company_prompt_profiles
set ambassador_reference_image_url =
  (select assets_base_url from base) || '/kling-elements/thangamayil-muse-01/front.jpg'
where company_slug = 'thangamayil'
  and (ambassador_reference_image_url is null or ambassador_reference_image_url = '');

