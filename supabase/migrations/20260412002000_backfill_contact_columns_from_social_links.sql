-- Backfill new outreach columns from existing social_links JSONB.
-- This migration is safe to re-run; it only populates empty columns.

with extracted as (
  select
    company_slug,
    -- Email buckets (lowercased for consistency)
    coalesce(
      (select array_agg(distinct lower(e) order by lower(e))
         from jsonb_array_elements_text(coalesce(social_links->'emails'->'general','[]'::jsonb)) as e),
      '{}'::text[]
    ) as emails_general,
    coalesce(
      (select array_agg(distinct lower(e) order by lower(e))
         from jsonb_array_elements_text(coalesce(social_links->'emails'->'support','[]'::jsonb)) as e),
      '{}'::text[]
    ) as emails_support,
    coalesce(
      (select array_agg(distinct lower(e) order by lower(e))
         from jsonb_array_elements_text(coalesce(social_links->'emails'->'sales','[]'::jsonb)) as e),
      '{}'::text[]
    ) as emails_sales,
    coalesce(
      (select array_agg(distinct lower(e) order by lower(e))
         from jsonb_array_elements_text(coalesce(social_links->'emails'->'founder','[]'::jsonb)) as e),
      '{}'::text[]
    ) as emails_founder,
    coalesce(
      (select array_agg(distinct lower(e) order by lower(e))
         from jsonb_array_elements_text(coalesce(social_links->'emails'->'other','[]'::jsonb)) as e),
      '{}'::text[]
    ) as emails_other,

    -- LinkedIn company page (best effort)
    nullif(
      coalesce(
        nullif(social_links->>'linkedin_company_url',''),
        case
          when (social_links->>'linkedin') ilike '%linkedin.com/company/%'
            then nullif(social_links->>'linkedin','')
          else null
        end,
        case
          when jsonb_typeof(social_links->'linkedin_company_urls') = 'array'
            then nullif(social_links->'linkedin_company_urls'->>0, '')
          else null
        end
      ),
      ''
    ) as linkedin_company_url,

    -- LinkedIn people URLs
    coalesce(
      (select array_agg(distinct p order by p)
         from jsonb_array_elements_text(coalesce(social_links->'linkedin_people_urls','[]'::jsonb)) as p),
      '{}'::text[]
    ) as linkedin_people_urls
  from public.company_prompt_profiles
)
update public.company_prompt_profiles c
set
  emails_general = case when coalesce(array_length(c.emails_general, 1), 0) = 0 then e.emails_general else c.emails_general end,
  emails_support = case when coalesce(array_length(c.emails_support, 1), 0) = 0 then e.emails_support else c.emails_support end,
  emails_sales   = case when coalesce(array_length(c.emails_sales, 1), 0) = 0 then e.emails_sales else c.emails_sales end,
  emails_founder = case when coalesce(array_length(c.emails_founder, 1), 0) = 0 then e.emails_founder else c.emails_founder end,
  emails_other   = case when coalesce(array_length(c.emails_other, 1), 0) = 0 then e.emails_other else c.emails_other end,
  linkedin_company_url = coalesce(c.linkedin_company_url, e.linkedin_company_url),
  linkedin_people_urls = case when coalesce(array_length(c.linkedin_people_urls, 1), 0) = 0 then e.linkedin_people_urls else c.linkedin_people_urls end
from extracted e
where c.company_slug = e.company_slug;
