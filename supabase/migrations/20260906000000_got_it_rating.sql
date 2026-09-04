-- Make room for a third label.
--
-- The app went from two labels to three. Not yet still writes 1, and the label that
-- puts a question into the Review queue still writes 4, so nothing already stored
-- changes meaning and every question keeps behaving exactly as it does today. The new
-- state, Got it, is the one that leaves the Review queue as well as the Mastery pool,
-- and it needs a number of its own: 5.
--
-- Both checks cap at 4, so without this the first Got it anyone presses is rejected
-- with 23514 and the push queue stops draining. Apply this before, or together with,
-- the deploy that ships the third label.

alter table public.card_progress drop constraint if exists card_progress_mastery_rating_check;
alter table public.card_progress
  add constraint card_progress_mastery_rating_check
  check (mastery_rating is null or mastery_rating between 1 and 5);

alter table public.reviews drop constraint if exists reviews_rating_check;
alter table public.reviews
  add constraint reviews_rating_check
  check (rating between 1 and 5);
