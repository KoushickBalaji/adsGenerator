-- Seed Thangamayil for multi-company demo mode.
-- Safe to re-run: inserts if missing, then backfills key fields if empty.

insert into public.company_prompt_profiles (company_slug, prompt_style, requires_ambassador)
values ('thangamayil', 'jewellery_generic_v1', true)
on conflict (company_slug) do nothing;

update public.company_prompt_profiles
set
  website_url = coalesce(nullif(website_url, ''), 'https://www.thangamayil.com'),
  has_ecommerce = coalesce(has_ecommerce, true),
  website_notes = coalesce(
    nullif(website_notes, ''),
    'Magento-style ecommerce storefront; product URLs typically end with .html'
  ),
  scrape_profile = case
    when scrape_profile is null or scrape_profile = '{}'::jsonb
      then jsonb_build_object('adapter', 'generic', 'platform', 'magento')
    else scrape_profile
  end,
  sample_product_urls = case
    when sample_product_urls is null or array_length(sample_product_urls, 1) is null
      then array[
        'https://www.thangamayil.com/traditional-wedding-gold-stone-stud-cgl24kstu03876.html',
        'https://www.thangamayil.com/elegant-gold-bangle-cgl24aban01496.html'
      ]::text[]
    else sample_product_urls
  end,
  emails_sales = case
    when emails_sales is null or array_length(emails_sales, 1) is null
      then array['shopping@thangamayil.com']::text[]
    else emails_sales
  end,
  emails_support = case
    when emails_support is null or array_length(emails_support, 1) is null
      then array['customercare@thangamayil.com']::text[]
    else emails_support
  end,
  emails_general = case
    when emails_general is null or array_length(emails_general, 1) is null
      then array['companysecretary@thangamayil.com']::text[]
    else emails_general
  end
where company_slug = 'thangamayil';

