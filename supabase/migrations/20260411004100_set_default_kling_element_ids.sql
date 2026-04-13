-- Use a shared Kling persona pool for all demo companies (fastest path to working demos).
-- These are the existing BlueStone muse custom element IDs in this Kling account.
--
-- You can later customize per-company by overwriting company_prompt_profiles.kling_element_ids.

update public.company_prompt_profiles
set kling_element_ids =
  '["307085449718313","306996369939530","306996328062534","306996275472304"]'::jsonb
where company_slug <> 'product-only'
  and kling_element_ids = '[]'::jsonb;

