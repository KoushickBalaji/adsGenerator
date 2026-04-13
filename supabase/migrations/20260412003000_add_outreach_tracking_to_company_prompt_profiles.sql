-- Outreach tracking fields for managing the demo-to-outreach funnel in Supabase UI.

alter table if exists public.company_prompt_profiles
  add column if not exists outreach_wave integer,
  add column if not exists outreach_status text not null default 'todo',
  add column if not exists outreach_notes text,
  add column if not exists outreach_last_contacted_at timestamptz,
  add column if not exists outreach_next_followup_at timestamptz;

-- Keep status values consistent.
alter table if exists public.company_prompt_profiles
  drop constraint if exists company_prompt_profiles_outreach_status_check;

alter table if exists public.company_prompt_profiles
  add constraint company_prompt_profiles_outreach_status_check
  check (
    outreach_status in (
      'todo',
      'emailed',
      'linkedin_message_sent',
      'replied',
      'meeting_scheduled',
      'demo_sent',
      'won',
      'lost',
      'paused'
    )
  );

create index if not exists company_prompt_profiles_outreach_wave_idx
  on public.company_prompt_profiles (outreach_wave);

create index if not exists company_prompt_profiles_outreach_status_idx
  on public.company_prompt_profiles (outreach_status);

