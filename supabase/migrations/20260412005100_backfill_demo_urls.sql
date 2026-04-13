-- Backfill demo_url for all companies (safe to re-run; only fills NULLs).
-- NOTE: if your Vercel domain changes, update demo_url with a single SQL update.

update public.company_prompt_profiles
set demo_url = 'https://ads-generator-hazel.vercel.app' || demo_path
where demo_url is null;

