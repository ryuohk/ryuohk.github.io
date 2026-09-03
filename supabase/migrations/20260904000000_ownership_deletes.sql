-- Restrict deletion to the person who contributed a question, plus library owners.
--
-- The subtle part is the tombstone. Clients treat a row in `deletions` as an
-- instruction to remove that card from local storage, so gating only the DELETE on
-- `cards` would leave a hole: a member could insert a tombstone for someone else's
-- card and every other device would drop it, even though the server row survived.
-- The same ownership test therefore guards the tombstone insert.
--
-- Sync writes the tombstone before deleting the row, so the EXISTS check below still
-- sees the row it is being asked about.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
--
-- `note` stays a free-text human comment. Making it load-bearing would mean a typo
-- or a capital letter silently strips someone's powers, so role is its own column
-- with a constraint, backfilled once from whatever `note` currently says.

alter table public.allowed_emails
  add column if not exists role text not null default 'member';
alter table public.allowed_emails drop constraint if exists allowed_emails_role_check;
alter table public.allowed_emails
  add constraint allowed_emails_role_check check (role in ('owner', 'member'));

alter table public.library_members
  add column if not exists role text not null default 'member';
alter table public.library_members drop constraint if exists library_members_role_check;
alter table public.library_members
  add constraint library_members_role_check check (role in ('owner', 'member'));

update public.allowed_emails set role = 'owner' where lower(trim(note)) = 'owner' and role <> 'owner';

update public.library_members m
set role = a.role
from public.allowed_emails a
where lower(a.email) = lower(m.email) and m.role <> a.role;

-- Carry the role across at signup, alongside the existing membership grant.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invited_role text;
begin
  select a.role into invited_role
  from public.allowed_emails a
  where lower(a.email) = lower(new.email);

  if invited_role is not null then
    insert into public.library_members (user_id, email, role)
    values (new.id, new.email, invited_role)
    on conflict (user_id) do update set role = excluded.role;
  end if;
  return new;
end;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.library_members m
    where m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

-- ---------------------------------------------------------------------------
-- Deletion policies
-- ---------------------------------------------------------------------------
--
-- created_by is null only for rows whose author's account was deleted. Those are
-- treated as owner-only, so orphaned content cannot be removed by just anyone.

drop policy if exists questions_member_delete on public.questions;
create policy questions_member_delete on public.questions
  for delete to authenticated
  using (public.is_member() and (public.is_owner() or created_by = auth.uid()));

drop policy if exists cards_member_delete on public.cards;
create policy cards_member_delete on public.cards
  for delete to authenticated
  using (public.is_member() and (public.is_owner() or created_by = auth.uid()));

-- A tombstone may only be written for something you were allowed to delete.
drop policy if exists deletions_member_write on public.deletions;
create policy deletions_member_write on public.deletions
  for insert to authenticated
  with check (
    public.is_member() and (
      public.is_owner()
      or (entity_type = 'card' and exists (
        select 1 from public.cards c where c.id = entity_id and c.created_by = auth.uid()
      ))
      or (entity_type = 'question' and exists (
        select 1 from public.questions q where q.id = entity_id and q.created_by = auth.uid()
      ))
    )
  );

-- Members may still read every tombstone; that is how deletions propagate.
-- Lifting one stays open to any member, since re-importing a capture is a
-- legitimate way to bring shared content back.

create index if not exists questions_created_by_idx on public.questions (created_by);
create index if not exists cards_created_by_idx     on public.cards (created_by);
