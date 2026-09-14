create extension if not exists "pgcrypto";

create table if not exists public.episodes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  podcast text not null,
  summary text not null,
  link text,
  mood text not null,
  topics text[],
  query text,
  rating text check (rating in ('positive', 'neutral', 'negative')),
  created_at timestamptz not null default now(),
  -- Also set when the listener opens an episode link (rating still null) so
  -- it can sit in History before they rate it.
  rated_at timestamptz
);

create index if not exists episodes_rating_idx on public.episodes (rating);
create index if not exists episodes_mood_idx on public.episodes (mood);

alter table public.episodes enable row level security;
