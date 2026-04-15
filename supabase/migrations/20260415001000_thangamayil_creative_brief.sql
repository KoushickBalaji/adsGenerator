-- Make Thangamayil generations feel Tamil Nadu rooted via `creative_brief` + `variables`.
-- Safe to re-run: only fills creative_brief if empty; variables are merged.

update public.company_prompt_profiles
set
  creative_brief = coalesce(
    nullif(creative_brief, ''),
    $$
Thangamayil is a Tamil Nadu-rooted jewellery brand. Reflect its culture in the video while staying premium and brand-neutral:

- Location & vibe: unmistakably Tamil Nadu (heritage courtyard / South Indian home aesthetic); warm, family-forward, heritage-modern.
- Visual motifs: kolam/rangoli at the doorstep, jasmine (mallipoo) in hair, Kanchipuram silk saree textures, brass lamps/urli, banana-leaf tones, terracotta + gold palette, carved teak/heritage courtyard.
- Wardrobe: elegant South Indian festive wear (saree/half-saree/salwar), traditional jewellery pairing, no western office/corporate vibe.
- Story beats: auspicious everyday moments (getting ready for a family function, wedding invite prep, gifting, festive morning), subtle and natural - never "presenting" to camera.
- Camera/lighting: soft golden-hour warmth, gentle movement, authentic skin tones; avoid neon/club/ultra-modern sets.
- Avoid: visible religious worship/rituals, logos/brand text, stereotypes, or anything that feels like a tourism ad.
$$
  ),
  variables = coalesce(variables, '{}'::jsonb) || jsonb_build_object(
    'locale', 'Tamil Nadu, India',
    'aesthetic_keywords', jsonb_build_array(
      'South Indian festive',
      'heritage courtyard',
      'kolam',
      'jasmine flowers',
      'Kanchipuram silk texture',
      'brass lamp / urli',
      'warm gold + terracotta palette'
    ),
    'wardrobe_preference', 'Traditional South Indian festive attire (saree/half-saree/salwar), premium and modest',
    'avoid_keywords', jsonb_build_array(
      'corporate office',
      'western business suit',
      'club lighting',
      'temple worship',
      'logos',
      'brand text'
    )
  )
where company_slug = 'thangamayil';
