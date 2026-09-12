-- SlurpQuest phase 3: the public Noodle Atlas. Run once in the SQL editor.
-- Idempotent. Copy the whole file from the editor (Cmd+A), not from a preview,
-- so the leading "--" comment markers survive.

-- Ban list: no policies on purpose, so the API can neither read nor write it.
-- Ban someone from the dashboard table editor; unshare their rows there too.
create table if not exists public.banned (
  user_id    uuid primary key,
  reason     text,
  created_at timestamptz not null default now()
);
alter table public.banned enable row level security;

-- Policies run as the calling user, and RLS on `banned` would hide every row
-- from them — so the ban check needs a definer function to peek at the table.
create or replace function public.is_banned()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.banned where user_id = auth.uid()) $$;

-- One row per shared stamp: a denormalized public copy, so private entries
-- never need public read access and unsharing is just a row delete. The
-- composite foreign key means a deleted stamp vanishes from the atlas by
-- itself, and nobody can share an entry that does not exist — which also
-- caps atlas rows at the 500-entry cap.
create table if not exists public.atlas (
  user_id      uuid not null default auth.uid(),
  entry_id     text not null,
  name         text not null check (char_length(name) between 1 and 120),
  location     text not null check (char_length(location) between 1 and 160),
  type         text not null check (char_length(type) between 1 and 40),
  photo_url    text     check (photo_url is null
                               or (photo_url ~* '^https?://' and char_length(photo_url) <= 500)),
  lat          double precision check (lat between  -90 and  90),
  lng          double precision check (lng between -180 and 180),
  richness     smallint not null check (richness between 1 and 5),
  texture      smallint not null check (texture  between 1 and 5),
  vibe         smallint not null check (vibe     between 1 and 5),
  notes        text not null default '' check (char_length(notes) <= 1000),
  visited_on   date,
  author_name  text not null check (char_length(author_name) between 1 and 40),
  author_color text not null check (author_color ~* '^#[0-9a-f]{6}$'),
  shared_at    timestamptz not null default now(),
  primary key (user_id, entry_id),
  foreign key (user_id, entry_id)
    references public.entries (user_id, id) on delete cascade
);

create index if not exists atlas_geo    on public.atlas (lat, lng);
create index if not exists atlas_recent on public.atlas (shared_at desc);

alter table public.atlas enable row level security;

-- World-readable (even without signing in), writable only by the author,
-- and closed to banned accounts.
drop policy if exists "atlas is public" on public.atlas;
create policy "atlas is public" on public.atlas
  for select using (true);

drop policy if exists "share own" on public.atlas;
create policy "share own" on public.atlas
  for insert to authenticated
  with check (auth.uid() = user_id and not public.is_banned());

drop policy if exists "update own share" on public.atlas;
create policy "update own share" on public.atlas
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and not public.is_banned());

drop policy if exists "unshare own" on public.atlas;
create policy "unshare own" on public.atlas
  for delete to authenticated
  using (auth.uid() = user_id);
