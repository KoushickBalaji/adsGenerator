-- Seed initial outreach wave assignments (safe defaults).
-- Only fills `outreach_wave` when it is currently NULL so it remains easy to override.

update public.company_prompt_profiles
set outreach_wave = 1
where outreach_wave is null
  and company_slug in (
    'quirksmith',
    'klarity',
    'iyal-silvers',
    'caratcult',
    'onya',
    'aukera',
    'kushals',
    'shravia',
    'houseofmila',
    'ishhaara'
  );

update public.company_prompt_profiles
set outreach_wave = 2
where outreach_wave is null
  and company_slug in (
    'giva',
    'melorra',
    'bluestone'
  );

