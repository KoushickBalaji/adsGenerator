-- SKKANDA: removed from demo (insufficient/unstable product image gallery).

delete from public.video_runs
where company_slug = 'skkanda';

delete from public.company_prompt_profiles
where company_slug = 'skkanda';

