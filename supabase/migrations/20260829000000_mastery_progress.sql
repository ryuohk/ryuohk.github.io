alter table public.card_progress
  add column if not exists mastery_rating smallint,
  add column if not exists rating_updated_at timestamptz;

alter table public.card_progress
  drop constraint if exists card_progress_mastery_rating_check;

alter table public.card_progress
  add constraint card_progress_mastery_rating_check
  check (mastery_rating between 1 and 4);

alter table public.card_progress
  alter column schedule drop not null;

alter table public.reviews
  alter column next_due drop not null;

with latest_review as (
  select distinct on (user_id, card_id)
    user_id,
    card_id,
    rating,
    reviewed_at
  from public.reviews
  where rating between 1 and 4
  order by user_id, card_id, reviewed_at desc
)
update public.card_progress as progress
set
  mastery_rating = latest.rating,
  rating_updated_at = latest.reviewed_at
from latest_review as latest
where progress.user_id = latest.user_id
  and progress.card_id = latest.card_id
  and progress.mastery_rating is null;
