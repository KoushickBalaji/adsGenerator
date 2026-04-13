-- Backfill website_url for existing company_prompt_profiles rows.
-- Sources: official websites discovered via web search.

update public.company_prompt_profiles
set website_url = 'https://www.bluestone.com'
where company_slug = 'bluestone'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://www.kushals.com'
where company_slug = 'kushals'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://www.giva.co'
where company_slug = 'giva'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://www.melorra.com'
where company_slug = 'melorra'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://shopklarity.com'
where company_slug = 'klarity'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://quirksmith.com'
where company_slug = 'quirksmith'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://www.skkanda.com'
where company_slug = 'skkanda'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://iyalsilvers.com'
where company_slug = 'iyal-silvers'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://onyadiamonds.com'
where company_slug = 'onya'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://aukerajewellery.com'
where company_slug = 'aukera'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://tridia.in'
where company_slug = 'tridia'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://caratcult.com'
where company_slug = 'caratcult'
  and coalesce(nullif(website_url, ''), '') = '';

update public.company_prompt_profiles
set website_url = 'https://auryadiamonds.com'
where company_slug = 'aurya'
  and coalesce(nullif(website_url, ''), '') = '';

