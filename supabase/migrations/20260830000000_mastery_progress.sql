-- Align the cloud schema with the mastery model.
--
-- The app replaced FSRS scheduling with a single mastery rating per card, but
-- card_progress and reviews were still shaped for the old model, so every sync
-- failed in both directions:
--
--   push  card_progress rejected mastery_rating and rating_updated_at with
--         42703 (column does not exist), and its schedule column was NOT NULL
--         while the client no longer sends it. reviews.next_due had the same
--         problem. Because progress is pushed before reviews, neither landed.
--
--   pull  the card_progress select named columns that do not exist. That query
--         shares a Promise.all with the questions, cards and deletions selects,
--         so one 400 rejected the whole pull and no device could download
--         anything. Shared questions uploaded fine but never came back down,
--         which is why each device appeared to have its own private library.
--
-- Both tables are empty at this point precisely because those writes never
-- succeeded, so dropping the obsolete columns loses nothing.

alter table public.card_progress
  add column if not exists mastery_rating    smallint,
  add column if not exists rating_updated_at timestamptz;

alter table public.card_progress
  drop column if exists schedule,
  drop column if exists suspended;

alter table public.reviews
  drop column if exists next_due;

-- Mirror the MasteryRating union in the client: Again 1, Hard 2, Good 3, Easy 4.
alter table public.card_progress drop constraint if exists card_progress_mastery_rating_check;
alter table public.card_progress
  add constraint card_progress_mastery_rating_check
  check (mastery_rating is null or mastery_rating between 1 and 4);

alter table public.reviews drop constraint if exists reviews_rating_check;
alter table public.reviews
  add constraint reviews_rating_check
  check (rating between 1 and 4);
