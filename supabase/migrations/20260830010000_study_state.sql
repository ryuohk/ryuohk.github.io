-- Carry the in-progress mastery set between one person's own devices.
--
-- Card ratings already sync through card_progress, but the session itself (which
-- cards are in the set, where you are in the queue, the answers so far) lived only
-- in localStorage, so starting a set on a phone left no trace on a laptop.
--
-- One row per person. This is private study state, never shared with the other
-- member of the library, so the policy is scoped to the owner exactly like
-- card_progress and reviews.

create table if not exists public.study_state (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  session     jsonb,
  settings    jsonb,
  -- The selected exam, or "all". A plain code rather than JSON.
  exam_filter text,
  updated_at  timestamptz not null default now()
);

alter table public.study_state add column if not exists exam_filter text;

-- The server owns updated_at so "most recently touched wins" never depends on
-- whether a phone and a laptop agree about the time.
drop trigger if exists study_state_touch on public.study_state;
create trigger study_state_touch before insert or update on public.study_state
  for each row execute function public.touch_updated_at();

alter table public.study_state enable row level security;

drop policy if exists study_state_owner_all on public.study_state;
create policy study_state_owner_all on public.study_state
  for all to authenticated
  using (user_id = auth.uid() and public.is_member())
  with check (user_id = auth.uid() and public.is_member());
