-- ===========================================================================
-- SlurpQuest cloud passport — phase 1 schema (profiles + entries)
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste ->
-- Run. It is idempotent, so re-running after an edit is safe.
--
-- Trust model, same philosophy as database.rules.json for the chat:
--   * The anon API key ships in the page and is public by design.
--   * Row Level Security is the boundary. Every policy below is owner-only;
--     there is no path to another user's rows no matter what the client sends.
--   * The CHECK constraints are the server-side equivalent of the chat rules'
--     .validate length caps — the client's validation is a courtesy, not the
--     enforcement.
-- ===========================================================================

-- ---------------------------------------------------------------- profiles
-- One row per auth user (anonymous or permanent — the uid survives linking,
-- which is what makes "save your passport" a no-migration upgrade).
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 40),
  color      text not null check (color ~* '^#[0-9a-f]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- entries
-- The client keeps its existing string ids ('entry-<base36 timestamp>').
-- Those are only unique per browser, so the primary key is (user_id, id) —
-- two travelers can hold the same id without colliding, and no id rewriting
-- is needed on import.
--
-- photo_url only accepts a real link (the placeholder or a pasted URL).
-- Camera photos are base64 data-URLs today and stay in the browser; phase 2
-- moves them to Storage and starts filling this column for everything.
create table if not exists public.entries (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null check (char_length(id) between 1 and 64),
  name       text not null check (char_length(name) between 1 and 120),
  location   text not null check (char_length(location) between 1 and 160),
  type       text not null check (char_length(type) between 1 and 40),
  photo_url  text     check (photo_url is null
                             or (photo_url ~* '^https?://' and char_length(photo_url) <= 500)),
  lat        double precision check (lat between  -90 and  90),
  lng        double precision check (lng between -180 and 180),
  richness   smallint not null check (richness between 1 and 5),
  texture    smallint not null check (texture  between 1 and 5),
  vibe       smallint not null check (vibe     between 1 and 5),
  notes      text not null default '' check (char_length(notes) <= 1000),
  visited_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- ------------------------------------------------------------- updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists touch_profiles on public.profiles;
create trigger touch_profiles before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_entries on public.entries;
create trigger touch_entries before update on public.entries
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------- entry cap
-- Bounds how much of the 500 MB database any single account can occupy.
-- Runs as the inserting user (security invoker), so RLS scopes the count to
-- their own rows — no information leak, and no way around the cap.
create or replace function public.enforce_entry_cap()
returns trigger language plpgsql as $$
begin
  if (select count(*) from public.entries where user_id = new.user_id) >= 500 then
    raise exception 'passport is full: 500 stamps per traveler';
  end if;
  return new;
end $$;

drop trigger if exists entries_cap on public.entries;
create trigger entries_cap before insert on public.entries
  for each row execute function public.enforce_entry_cap();

-- ---------------------------------------------------------------- RLS
alter table public.profiles enable row level security;
alter table public.entries  enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Note: do NOT revoke the default grants from the `anon` role. The keep-alive
-- workflow (.github/workflows/keepalive.yml) pings `select id from profiles`
-- with the bare anon key; RLS already guarantees it sees zero rows, and that
-- empty query is what keeps the free project from being paused for
-- inactivity.
