-- Thangamayil prompt tuning: correct ring finger + avoid odd props.
-- No negative_prompt changes: this only adjusts the per-company creative brief + variables appended to Gemini.
-- Safe to re-run: appends guidance once (idempotent) and merges variables.

update public.company_prompt_profiles
set
  creative_brief =
    case
      when creative_brief is null or btrim(creative_brief) = '' then
        -- If a row somehow has no brief yet, keep this self-contained.
        $$
Thangamayil is a Tamil Nadu-rooted jewellery brand. Reflect its culture in the video while staying premium and brand-neutral.

[Ring placement & props]
- Ring placement: if the product is a ring, it MUST be worn on the ring finger (4th finger). Never place it on the index, middle, or thumb.
- Hands: natural, subtle gestures (adjusting saree pleats, tucking hair, holding a jasmine strand, opening a small jewellery box). Hands should never feel like "posing to show the ring".
- Props: minimal and culturally relevant. Use only plausible home/festive items (silk saree pallu texture, wooden jewellery box, jasmine flowers, kolam in the background, brass lamp/urli as background decor).
- IMPORTANT: avoid handheld drinkware (cups/tumblers/mugs/glasses) and avoid random modern props that distract from the jewellery.
$$
      when position('[Ring placement & props]' in creative_brief) > 0 then creative_brief
      else creative_brief || E'\n\n[Ring placement & props]\n' ||
        E'- Ring placement: if the product is a ring, it MUST be worn on the ring finger (4th finger). Never place it on the index, middle, or thumb.\n' ||
        E'- Hands: natural, subtle gestures (adjusting saree pleats, tucking hair, holding a jasmine strand, opening a small jewellery box). Hands should never feel like \"posing to show the ring\".\n' ||
        E'- Props: minimal and culturally relevant. Use only plausible home/festive items (silk saree pallu texture, wooden jewellery box, jasmine flowers, kolam in the background, brass lamp/urli as background decor).\n' ||
        E'- IMPORTANT: avoid handheld drinkware (cups/tumblers/mugs/glasses) and avoid random modern props that distract from the jewellery.'
    end,
  variables = coalesce(variables, '{}'::jsonb) || jsonb_build_object(
    'ring_placement_rule', 'If product category is ring: wear it on the ring finger (4th finger), not index/middle/thumb',
    'prop_guidance', jsonb_build_object(
      'preferred', jsonb_build_array(
        'wooden jewellery box (small)',
        'silk saree pallu texture',
        'jasmine flowers (mallipoo)',
        'kolam/rangoli (background)',
        'brass lamp or urli (background decor only)'
      ),
      'avoid', jsonb_build_array(
        'cups',
        'tumblers',
        'mugs',
        'glasses',
        'random modern gadgets',
        'distracting props'
      )
    )
  )
where company_slug = 'thangamayil';

