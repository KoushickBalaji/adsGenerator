-- Pin Thangamayil still-preview identity to the current Vercel demo asset URL.
--
-- This is used by `generate-previews` to keep a consistent ambassador identity in Shot 1/2,
-- even when Kling elements were created manually and `kling_element_assets` has no Thangamayil row.
--
-- Repo asset: `frontend/public/kling-elements/thangamayil-muse-01/front.jpg`
-- Deployed (current demo): `https://ads-generator-hazel.vercel.app/kling-elements/thangamayil-muse-01/front.jpg`

update public.company_prompt_profiles
set
  ambassador_reference_image_url = 'https://ads-generator-hazel.vercel.app/kling-elements/thangamayil-muse-01/front.jpg',
  variables = jsonb_set(
    coalesce(variables, '{}'::jsonb),
    '{ambassador_reference_image_urls}',
    jsonb_build_array(
      'https://ads-generator-hazel.vercel.app/kling-elements/thangamayil-muse-01/front.jpg',
      'https://ads-generator-hazel.vercel.app/kling-elements/thangamayil-muse-01/ref1.png',
      'https://ads-generator-hazel.vercel.app/kling-elements/thangamayil-muse-01/ref2.jpg',
      'https://ads-generator-hazel.vercel.app/kling-elements/thangamayil-muse-01/ref3.jpg'
    ),
    true
  )
where company_slug = 'thangamayil'
;
