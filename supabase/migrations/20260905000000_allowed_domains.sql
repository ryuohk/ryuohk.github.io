-- Allow a whole email domain in, alongside the per-address invite list.
--
-- Membership still works the same way: a row in library_members is what grants
-- access, and the signup trigger is what creates it. This adds a second way to earn
-- that row, so an address is admitted if it is named in allowed_emails OR its domain
-- is listed here. A named address always wins, which is how one person can be an
-- owner while the rest of their domain are ordinary members.

create table if not exists public.allowed_domains (
  -- Bare domain, lowercase, no "@". Example: aeonnexus.com
  domain   text primary key,
  role     text not null default 'member' check (role in ('owner', 'member')),
  note     text,
  added_at timestamptz not null default now()
);

-- No policies at all, exactly like allowed_emails: manage it from the SQL editor.
-- A client that could read this would learn who is allowed in; one that could write
-- it could let itself in.
alter table public.allowed_domains enable row level security;

/**
 * Grants membership at signup to a named address or a listed domain.
 *
 * The domain is taken from the address Supabase Auth verified, and a magic link
 * proves control of that mailbox, so this admits anyone who can receive mail at the
 * domain. That is the intent, but it is a real widening: it is no longer a list of
 * people you chose individually.
 */
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
  where lower(trim(a.email)) = lower(trim(new.email));

  -- A named address takes precedence, so a domain rule cannot demote an owner.
  if invited_role is null then
    select d.role into invited_role
    from public.allowed_domains d
    where lower(trim(d.domain)) = lower(split_part(trim(new.email), '@', 2));
  end if;

  if invited_role is not null then
    insert into public.library_members (user_id, email, role)
    values (new.id, new.email, invited_role)
    on conflict (user_id) do update set role = excluded.role;
  end if;
  return new;
end;
$$;

-- Add the domain. Change or remove this line to suit.
insert into public.allowed_domains (domain, role, note)
values ('aeonnexus.com', 'member', 'colleagues')
on conflict (domain) do nothing;

-- Grant membership to anyone on an allowed domain who already has an account.
-- The trigger only fires at signup, so existing accounts need this once.
insert into public.library_members (user_id, email, role)
select u.id, u.email, d.role
from auth.users u
join public.allowed_domains d on lower(trim(d.domain)) = lower(split_part(trim(u.email), '@', 2))
on conflict (user_id) do nothing;
