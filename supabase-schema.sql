create table if not exists public.home_care_shared_data (
  family_hash text primary key,
  data jsonb not null default '{"manuals":[],"tasks":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.home_care_shared_data enable row level security;
