-- CramBot shared library schema
--
-- Model: two invited people share one question library and keep private study progress.
--   * questions / cards   -> shared content, any member may add or correct
--   * card_progress       -> private FSRS schedule, notes and flags, one row per user per card
--   * reviews             -> private review log
--   * allowed_emails      -> the invite list; only these addresses ever become members
--   * library_members     -> accounts that matched the invite list, created by trigger
--
-- Every table has row level security. A signed-out visitor reads nothing. A signed-in
-- account that is not in library_members reads nothing either, so an accidental signup
-- cannot see or write any data.

-- ---------------------------------------------------------------------------
-- Membership
-- ---------------------------------------------------------------------------

create table if not exists public.allowed_emails (
  email    text primary key,
  note     text,
  added_at timestamptz not null default now()
);

create table if not exists public.library_members (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text not null,
  joined_at timestamptz not null default now()
);

-- security definer so the policies below can read library_members without
-- recursing through that table's own row level security.
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.library_members m where m.user_id = auth.uid()
  );
$$;

revoke all on function public.is_member() from public;
grant execute on function public.is_member() to authenticated;

-- Grant membership on signup, but only to invited addresses.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.allowed_emails a
    where lower(a.email) = lower(new.email)
  ) then
    insert into public.library_members (user_id, email)
    values (new.id, new.email)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Shared library
-- ---------------------------------------------------------------------------

-- created_by defaults to the caller so clients never send it and an edit by one
-- member cannot rewrite who first contributed the row.
create table if not exists public.questions (
  id         text primary key,
  data       jsonb not null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.cards (
  id          text primary key,
  question_id text not null,
  data        jsonb not null,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- Tombstones, so a card one person removes also disappears for the other.
-- Re-importing the same capture clears the tombstone and brings the card back.
create table if not exists public.deletions (
  entity_type text not null check (entity_type in ('card', 'question')),
  entity_id   text not null,
  deleted_at  timestamptz not null default now(),
  deleted_by  uuid default auth.uid() references auth.users (id) on delete set null,
  primary key (entity_type, entity_id)
);

create index if not exists questions_updated_at_idx on public.questions (updated_at);
create index if not exists cards_updated_at_idx     on public.cards (updated_at);
create index if not exists cards_question_id_idx    on public.cards (question_id);
create index if not exists deletions_deleted_at_idx on public.deletions (deleted_at);

-- ---------------------------------------------------------------------------
-- Private progress
-- ---------------------------------------------------------------------------

-- No foreign key to cards on purpose: a sync client may push progress before the
-- shared card row lands, and progress for a card someone else deleted is harmless.
create table if not exists public.card_progress (
  user_id        uuid not null references auth.users (id) on delete cascade,
  card_id        text not null,
  schedule       jsonb not null,
  notes          text,
  feedback_flags text[],
  suspended      boolean not null default false,
  updated_at     timestamptz not null default now(),
  primary key (user_id, card_id)
);

create table if not exists public.reviews (
  id          text primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  card_id     text not null,
  rating      smallint not null,
  reviewed_at timestamptz not null,
  next_due    timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists card_progress_user_updated_idx on public.card_progress (user_id, updated_at);
create index if not exists reviews_user_created_idx       on public.reviews (user_id, created_at);
create index if not exists reviews_user_card_idx          on public.reviews (user_id, card_id);

-- ---------------------------------------------------------------------------
-- The server owns updated_at so sync watermarks never depend on device clocks.
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists questions_touch      on public.questions;
drop trigger if exists cards_touch          on public.cards;
drop trigger if exists card_progress_touch  on public.card_progress;

create trigger questions_touch     before insert or update on public.questions
  for each row execute function public.touch_updated_at();
create trigger cards_touch         before insert or update on public.cards
  for each row execute function public.touch_updated_at();
create trigger card_progress_touch before insert or update on public.card_progress
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.allowed_emails  enable row level security;
alter table public.library_members enable row level security;
alter table public.questions       enable row level security;
alter table public.cards           enable row level security;
alter table public.deletions       enable row level security;
alter table public.card_progress   enable row level security;
alter table public.reviews         enable row level security;

-- allowed_emails: no policies at all, so no client can read or change the invite
-- list. Manage it from the SQL editor or with the service role key.

drop policy if exists members_read on public.library_members;
create policy members_read on public.library_members
  for select to authenticated
  using (public.is_member());

-- Shared content: any member may read and write it.
drop policy if exists questions_member_read   on public.questions;
drop policy if exists questions_member_write  on public.questions;
drop policy if exists questions_member_update on public.questions;
drop policy if exists questions_member_delete on public.questions;

create policy questions_member_read on public.questions
  for select to authenticated using (public.is_member());
create policy questions_member_write on public.questions
  for insert to authenticated with check (public.is_member());
create policy questions_member_update on public.questions
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy questions_member_delete on public.questions
  for delete to authenticated using (public.is_member());

drop policy if exists cards_member_read   on public.cards;
drop policy if exists cards_member_write  on public.cards;
drop policy if exists cards_member_update on public.cards;
drop policy if exists cards_member_delete on public.cards;

create policy cards_member_read on public.cards
  for select to authenticated using (public.is_member());
create policy cards_member_write on public.cards
  for insert to authenticated with check (public.is_member());
create policy cards_member_update on public.cards
  for update to authenticated using (public.is_member()) with check (public.is_member());
create policy cards_member_delete on public.cards
  for delete to authenticated using (public.is_member());

drop policy if exists deletions_member_read   on public.deletions;
drop policy if exists deletions_member_write  on public.deletions;
drop policy if exists deletions_member_delete on public.deletions;

create policy deletions_member_read on public.deletions
  for select to authenticated using (public.is_member());
create policy deletions_member_write on public.deletions
  for insert to authenticated with check (public.is_member());
-- Removing a tombstone is how a re-import restores a card for everyone.
create policy deletions_member_delete on public.deletions
  for delete to authenticated using (public.is_member());

-- Private content: a member may only ever touch their own rows.
drop policy if exists progress_owner_all on public.card_progress;
create policy progress_owner_all on public.card_progress
  for all to authenticated
  using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());

drop policy if exists reviews_owner_all on public.reviews;
create policy reviews_owner_all on public.reviews
  for all to authenticated
  using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());

-- ---------------------------------------------------------------------------
-- Invite list
-- ---------------------------------------------------------------------------
--
-- Deliberately left empty. Real addresses do not belong in a public repository,
-- so seed them from the SQL Editor instead. See SETUP-CLOUD.md, step 2b:
--
--   insert into public.allowed_emails (email, note) values
--     ('you@example.com',    'owner'),
--     ('friend@example.com', 'friend')
--   on conflict (email) do nothing;
--
-- Until at least one address is added, nobody can reach the library at all.

-- Backfill: if an invited person already signed up before being added to the
-- list above, this grants their membership row. Safe to re-run at any time.
insert into public.library_members (user_id, email)
select u.id, u.email
from auth.users u
join public.allowed_emails a on lower(a.email) = lower(u.email)
on conflict (user_id) do nothing;
