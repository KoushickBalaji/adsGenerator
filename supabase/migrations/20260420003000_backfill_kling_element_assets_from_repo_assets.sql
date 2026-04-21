-- Backfill `public.kling_element_assets` for the default demo personas using the repo-hosted assets
-- in `frontend/public/kling-elements/`.
--
-- This is helpful when Kling elements were created manually (outside `test-prompt?mode=elements-create`),
-- so the `kling_element_assets` table is empty and preview generation can't reuse the same frontal image.
--
-- Assumption: the default `kling_element_ids` (set in 20260411004100_set_default_kling_element_ids.sql)
-- correspond to:
--   - bluestone-muse-01..04 (in the same array order).
--
-- If your IDs differ, edit the element_id values below.
--
-- Note: Thangamayil has a separate persona asset directory (`thangamayil-muse-01`) but its element ID
-- is not known in this migration. Use `company_prompt_profiles.ambassador_reference_image_url` (see
-- 20260420003100_set_thangamayil_ambassador_reference_image_url.sql) or add a dedicated row once you
-- know the Thangamayil element ID.

with base as (
  select regexp_replace(demo_url, '/demo/.*$', '') as assets_base_url
  from public.company_prompt_profiles
  where demo_url is not null and demo_url <> ''
  limit 1
),
seed as (
  select
    v.element_id,
    v.element_name,
    b.assets_base_url || v.frontal_path as frontal_url,
    jsonb_build_array(
      b.assets_base_url || v.ref1_path,
      b.assets_base_url || v.ref2_path,
      b.assets_base_url || v.ref3_path
    ) as ref_urls
  from (values
    ('307085449718313', 'bluestone-muse-01', '/kling-elements/bluestone-muse-01/Front.jpg',  '/kling-elements/bluestone-muse-01/ref1.jpg', '/kling-elements/bluestone-muse-01/ref2.jpg', '/kling-elements/bluestone-muse-01/ref3.jpg'),
    ('306996369939530', 'bluestone-muse-02', '/kling-elements/bluestone-muse-02/front.png', '/kling-elements/bluestone-muse-02/ref1.jpg', '/kling-elements/bluestone-muse-02/ref2.jpg', '/kling-elements/bluestone-muse-02/ref3.png'),
    ('306996328062534', 'bluestone-muse-03', '/kling-elements/bluestone-muse-03/Front.jpg',  '/kling-elements/bluestone-muse-03/ref1.jpg', '/kling-elements/bluestone-muse-03/ref2.jpg', '/kling-elements/bluestone-muse-03/ref3.jpg'),
    ('306996275472304', 'bluestone-muse-04', '/kling-elements/bluestone-muse-04/front.jpeg', '/kling-elements/bluestone-muse-04/ref1.jpg', '/kling-elements/bluestone-muse-04/ref2.png', '/kling-elements/bluestone-muse-04/ref3.jpg')
  ) as v(element_id, element_name, frontal_path, ref1_path, ref2_path, ref3_path)
  cross join base b
)
insert into public.kling_element_assets (element_id, element_name, frontal_url, ref_urls)
select
  s.element_id,
  s.element_name,
  s.frontal_url,
  (
    select jsonb_agg(x) from (
      select trim(value) as x
      from jsonb_array_elements_text(s.ref_urls)
      where trim(value) <> ''
    ) t
  ) as ref_urls
from seed s
where s.frontal_url is not null and s.frontal_url <> ''
on conflict (element_id) do update set
  element_name = excluded.element_name,
  frontal_url = excluded.frontal_url,
  ref_urls = excluded.ref_urls;
