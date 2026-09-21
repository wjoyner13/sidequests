create extension if not exists "pgcrypto";

create table if not exists public.digests (
  id uuid primary key default gen_random_uuid(),
  headline text not null,
  -- [{ title, highlight, explanation, sources: [{ name, url }] }, ...]
  topics jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists digests_created_at_idx on public.digests (created_at desc);

alter table public.digests enable row level security;
