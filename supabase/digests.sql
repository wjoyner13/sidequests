create extension if not exists "pgcrypto";

create table if not exists public.digests (
  id uuid primary key default gen_random_uuid(),
  headline text,
  -- [{ title, highlight, explanation, sources: [{ name, url }] }, ...]
  topics jsonb,
  created_at timestamptz not null default now()
);

create index if not exists digests_created_at_idx on public.digests (created_at desc);

alter table public.digests enable row level security;

-- Pulling is async: a row starts 'pending' (headline/topics still null) and
-- a background function fills it in once the search finishes, or marks it
-- 'error' with a message. Lets the page poll instead of holding one long
-- HTTP request open past Netlify's synchronous function time limit.
alter table public.digests alter column headline drop not null;
alter table public.digests alter column topics drop not null;
alter table public.digests add column if not exists status text not null default 'ready'
  check (status in ('pending', 'ready', 'error'));
alter table public.digests add column if not exists error text;
