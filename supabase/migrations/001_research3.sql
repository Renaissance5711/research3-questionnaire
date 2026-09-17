-- Research 3 questionnaire storage.
-- The raw company name is never stored. The Edge Function stores only a
-- salted hash and the anonymous assignment generated for that hash.

create extension if not exists pgcrypto;

create table if not exists public.research3_teams (
  team_id text primary key,
  company_hash text not null unique,
  architecture_id text not null check (architecture_id in ('G1','G2','G3','G4')),
  structure_factor smallint not null check (structure_factor in (0,1)),
  division_factor smallint not null check (division_factor in (0,1)),
  pair text not null check (pair in ('ES','ER','SR')),
  case_e text not null check (case_e in ('E1','E2','E3')),
  case_s text not null check (case_s in ('S1','S2','S3')),
  case_r text not null check (case_r in ('R1','R2','R3')),
  created_at timestamptz not null default now()
);

create table if not exists public.research3_submissions (
  submission_id uuid primary key default gen_random_uuid(),
  team_id text not null references public.research3_teams(team_id) on delete cascade,
  member_slot text not null check (member_slot in ('1','2','3')),
  role text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (team_id, member_slot)
);

create index if not exists research3_submissions_team_idx
  on public.research3_submissions(team_id);

alter table public.research3_teams enable row level security;
alter table public.research3_submissions enable row level security;

-- The browser never queries these tables directly. The Edge Function uses the
-- service-role key, while anonymous clients are denied by default.
drop policy if exists research3_teams_deny_anon on public.research3_teams;
create policy research3_teams_deny_anon on public.research3_teams
  for all to anon using (false) with check (false);

drop policy if exists research3_submissions_deny_anon on public.research3_submissions;
create policy research3_submissions_deny_anon on public.research3_submissions
  for all to anon using (false) with check (false);
