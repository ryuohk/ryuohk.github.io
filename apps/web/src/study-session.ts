import { MasteryRating, type MasteryRating as MasteryRatingValue, type StudyCard } from "./types";

export type StudyMode = "mastery" | "easy-review";
export type MasteryPool = "all-not-easy" | "again-hard";
export type EasyReviewScope = "all" | "batch";

export interface StudySettings {
  masterySetSize: number;
  /** Present answer choices in a random order, so their position cannot be learned. */
  shuffleChoices: boolean;
  masteryPool: MasteryPool;
  /**
   * Whether a review takes the whole ready pool or one part of it.
   *
   * "all" is the default, because the number on the empty-state heading is the number
   * of questions that are ready and pressing Start should hand you exactly those. A
   * fixed size used to be applied silently, so a pool of 57 quietly became a session
   * of 20 with nothing on screen to say the other 37 had been left behind.
   */
  easyReviewScope: EasyReviewScope;
  /** Questions per part. Only read when the scope is "batch". */
  easyReviewSize: number;
  /**
   * Sweep questions marked Got it into a review as well.
   *
   * Off by default, because Got it is how you say you are finished with a question and
   * a review that ignored that would leave the label doing nothing. Worth turning on
   * for a last pass before an exam.
   */
  reviewIncludesGotIt: boolean;
  masteryCardIds: string[];
  /** Your own groupings of related questions. See CardGroups. */
  cardGroups: CardGroups;
  /** Read each question aloud as it appears. Syncs, so it follows you between devices. */
  speakQuestions: boolean;
  /** Speaking rate, roughly 0.5 to 2. Voice choice stays per-device, see speech.ts. */
  speechRate: number;
  /** Speaking volume, 0 to 1, independent of the device's own volume control. */
  speechVolume: number;
}

export interface StudyResult {
  cardId: string;
  selectedAnswers: string[];
  correctAnswers: string[];
  correct: boolean | null;
  rating: MasteryRatingValue;
  answeredAt: string;
  elapsedSeconds: number;
}

export interface StudySession {
  id: string;
  mode: StudyMode;
  queue: string[];
  order: string[];
  total: number;
  completed: number;
  attempts: number;
  results: StudyResult[];
  answers: Record<string, string[]>;
  startedAt: string;
}

export interface SessionSummary {
  total: number;
  completed: number;
  attempts: number;
  correct: number;
  gradable: number;
  accuracy: number | null;
  durationSeconds: number;
  averageSeconds: number;
}

export function shuffleItems<T>(items: readonly T[], random = Math.random): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

/**
 * Whether saying this about a question takes it out of the Mastery pool.
 *
 * The two strongest labels both do. They differ in where the question goes next, not
 * in whether you are still drilling it, and every place that used to compare against
 * a single "Easy" now has two answers to consider. One predicate, so adding a fourth
 * state later is one edit rather than a hunt.
 */
export function leavesMasteryPool(rating: MasteryRatingValue | null): boolean {
  return rating === MasteryRating.KeepFresh || rating === MasteryRating.GotIt;
}

export function filterMasteryPool(cards: readonly StudyCard[], pool: MasteryPool): StudyCard[] {
  return cards.filter((card) => {
    if (leavesMasteryPool(card.masteryRating)) return false;
    if (pool === "again-hard") {
      return card.masteryRating === MasteryRating.Again || card.masteryRating === MasteryRating.Hard;
    }
    return true;
  });
}

/**
 * Personal groupings of related questions, keyed by name.
 *
 * Name to ids rather than id to names, because the operations are all about the group:
 * renaming one is a single key, deleting one is a single key, and listing what exists
 * needs no scan. The inverse, what groups a question is in, is wanted only while
 * rendering a row and is cheap to build once for the whole list.
 *
 * Rides in StudySettings, so it is carried between one person's own devices by the
 * study-state sync and never reaches the shared library. Two people studying the same
 * exam group questions for their own reasons, and neither should be editing the
 * other's grouping.
 */
export type CardGroups = Record<string, string[]>;

/** Names sort by what is typed rather than by case, so "azure" files with "Azure". */
export function listGroupNames(groups: CardGroups): string[] {
  return Object.keys(groups).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
}

/**
 * Trims and collapses whitespace, and caps the length.
 *
 * Returns an empty string for anything that is only whitespace, which callers treat
 * as "no name given" rather than creating a group nobody can see or select.
 */
export function normalizeGroupName(name: string): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
}

/**
 * The stored spelling of a group matching `name`, ignoring case.
 *
 * Typing "networking" when "Networking" exists means the one that exists. Without
 * this you get two groups an hour apart that look identical in the filter.
 */
export function findGroupName(groups: CardGroups, name: string): string | null {
  const wanted = normalizeGroupName(name).toLowerCase();
  if (!wanted) return null;
  return Object.keys(groups).find((existing) => existing.toLowerCase() === wanted) ?? null;
}

export function groupsForCard(groups: CardGroups, cardId: string): string[] {
  return listGroupNames(groups).filter((name) => groups[name].includes(cardId));
}

export function addCardsToGroup(groups: CardGroups, name: string, cardIds: readonly string[]): CardGroups {
  const target = findGroupName(groups, name) ?? normalizeGroupName(name);
  const additions = uniqueCardIds(cardIds);
  if (!target || additions.length === 0) return groups;
  return { ...groups, [target]: uniqueCardIds([...(groups[target] ?? []), ...additions]) };
}

/** A group emptied of its last question is removed: an empty one is only clutter. */
export function removeCardsFromGroup(groups: CardGroups, name: string, cardIds: readonly string[]): CardGroups {
  const target = findGroupName(groups, name);
  if (!target) return groups;
  const removing = new Set(cardIds);
  const remaining = (groups[target] ?? []).filter((cardId) => !removing.has(cardId));
  const { [target]: _removed, ...rest } = groups;
  return remaining.length ? { ...rest, [target]: remaining } : rest;
}

export function deleteGroup(groups: CardGroups, name: string): CardGroups {
  const target = findGroupName(groups, name);
  if (!target) return groups;
  const { [target]: _removed, ...rest } = groups;
  return rest;
}

/**
 * Renames a group, merging into the destination when one already goes by that name.
 *
 * Merging rather than refusing, because renaming "Networking " to "Networking" is a
 * tidy-up and being told the name is taken by the group you are looking at is absurd.
 */
export function renameGroup(groups: CardGroups, from: string, to: string): CardGroups {
  const source = findGroupName(groups, from);
  const name = normalizeGroupName(to);
  if (!source || !name) return groups;
  const destination = findGroupName(groups, name);
  if (destination === source) {
    // Same group, different spelling: keep the ids, take the new capitalization.
    const { [source]: ids, ...rest } = groups;
    return { ...rest, [name]: ids };
  }
  const { [source]: moving, ...rest } = groups;
  return { ...rest, [destination ?? name]: uniqueCardIds([...(destination ? groups[destination] : []), ...moving]) };
}

/**
 * Drops ids for questions that no longer exist, and any group left empty by that.
 *
 * Deleting a question from the library does not know or care what it was grouped
 * under, so without this a group slowly fills with ids that match nothing and its
 * count stops agreeing with what the filter shows.
 */
export function cleanCardGroups(groups: CardGroups, cards: readonly StudyCard[]): CardGroups {
  const live = new Set(cards.map((card) => card.id));
  const cleaned: CardGroups = {};
  for (const [name, cardIds] of Object.entries(groups)) {
    const remaining = uniqueCardIds(cardIds).filter((cardId) => live.has(cardId));
    if (remaining.length) cleaned[name] = remaining;
  }
  return cleaned;
}

export function filterCardsByGroup(cards: readonly StudyCard[], groups: CardGroups, name: string): StudyCard[] {
  const target = findGroupName(groups, name);
  if (!target) return [];
  const members = new Set(groups[target]);
  return cards.filter((card) => members.has(card.id));
}

/** Questions in no group at all, which is where everything starts. */
export function filterUngroupedCards(cards: readonly StudyCard[], groups: CardGroups): StudyCard[] {
  const grouped = new Set(Object.values(groups).flat());
  return cards.filter((card) => !grouped.has(card.id));
}

export type CardLabel = "not-yet" | "keep-fresh" | "got-it" | "unrated";
export type LabelFilter = CardLabel | "all";

/**
 * Which label the library shows a question under.
 *
 * The retired Hard and Good ratings read as Not yet, as they do everywhere else: they
 * always behaved as in-pool, and a filter that gave them a category of their own would
 * put questions you can still be asked somewhere you would never think to look.
 */
export function cardLabel(card: StudyCard): CardLabel {
  if (card.masteryRating === null || card.masteryRating === undefined) return "unrated";
  if (card.masteryRating === MasteryRating.GotIt) return "got-it";
  return card.masteryRating === MasteryRating.KeepFresh ? "keep-fresh" : "not-yet";
}

export function filterCardsByLabel(cards: readonly StudyCard[], label: LabelFilter): StudyCard[] {
  if (label === "all") return [...cards];
  return cards.filter((card) => cardLabel(card) === label);
}

/** Counts for every label at once, so the filter can say what each one holds. */
export function countCardsByLabel(cards: readonly StudyCard[]): Record<LabelFilter, number> {
  const counts: Record<LabelFilter, number> = { all: cards.length, "not-yet": 0, "keep-fresh": 0, "got-it": 0, unrated: 0 };
  for (const card of cards) counts[cardLabel(card)] += 1;
  return counts;
}

export interface EasyReviewPlan {
  /** How many questions the next session will ask. */
  sessionSize: number;
  /** How many sessions of that size it takes to cover the whole ready pool. */
  parts: number;
}

/**
 * Works out how much of the ready pool one review session takes.
 *
 * Reviewing in parts relies on nothing more than the pool's own ordering: questions
 * are chosen oldest-rated first, and answering one stamps it with the current time,
 * which sends it to the back. So the next part picks up where this one stopped
 * without anything having to be remembered between sessions.
 */
export function planEasyReview(poolSize: number, settings: StudySettings): EasyReviewPlan {
  if (settings.easyReviewScope !== "batch") return { sessionSize: poolSize, parts: poolSize ? 1 : 0 };
  const size = Math.max(1, Math.floor(settings.easyReviewSize));
  return { sessionSize: Math.min(size, poolSize), parts: Math.ceil(poolSize / size) };
}

/**
 * What a review session can draw from, oldest-rated first.
 *
 * Keep fresh is the label that asks to be reviewed, so it is the whole pool by
 * default. Got it means you are finished with a question, and sweeping those back in
 * would make the label mean nothing, so including them is a deliberate choice: turn it
 * on before an exam, when everything is worth one more pass.
 */
export function filterReviewPool(cards: readonly StudyCard[], includeGotIt = false): StudyCard[] {
  return cards
    .filter((card) => card.masteryRating === MasteryRating.KeepFresh
      || (includeGotIt && card.masteryRating === MasteryRating.GotIt))
    .sort((left, right) => (left.ratingUpdatedAt ?? "").localeCompare(right.ratingUpdatedAt ?? ""));
}

function uniqueCardIds(cardIds: readonly string[]): string[] {
  return [...new Set(cardIds.filter(Boolean))];
}

export function cleanMasteryCardIds(cards: readonly StudyCard[], cardIds: readonly string[]): string[] {
  const activeIds = new Set(cards.filter((card) => !leavesMasteryPool(card.masteryRating)).map((card) => card.id));
  return uniqueCardIds(cardIds).filter((cardId) => activeIds.has(cardId));
}

export function selectMasteryAdditions(
  cards: readonly StudyCard[],
  settings: StudySettings,
  random = Math.random,
): string[] {
  const currentIds = new Set(settings.masteryCardIds);
  const eligible = filterMasteryPool(cards, settings.masteryPool).filter((card) => !currentIds.has(card.id));
  const again = eligible.filter((card) => card.masteryRating === MasteryRating.Again);
  const remaining = eligible.filter((card) => card.masteryRating !== MasteryRating.Again);
  return [...shuffleItems(again, random), ...shuffleItems(remaining, random)]
    .slice(0, settings.masterySetSize)
    .map((card) => card.id);
}

export interface MasteryAdditionPlan {
  /** Not in the pool yet, so these are what actually joins it. */
  add: string[];
  /** Selected but already pooled. Harmless, and worth saying so rather than counting twice. */
  alreadyPooled: string[];
  /** Already out of the pool, so their label has to be cleared or it sheds them again. */
  unretire: string[];
}

/**
 * Works out what adding a hand-picked set of questions to the Mastery pool involves.
 *
 * The pool holds what you have not got yet, and every sync strips anything labelled
 * Keep fresh or Got it out of it. So a question you already know cannot simply be put
 * back: its label has to go first, or it would appear to be added and then quietly
 * vanish. Choosing a
 * question from the library is a deliberate "drill this again", which is exactly what
 * clearing the label means, but it is a change to your ratings and the caller is
 * expected to say so rather than do it silently.
 */
export function planMasteryAdditions(
  selected: readonly StudyCard[],
  masteryCardIds: readonly string[],
): MasteryAdditionPlan {
  const pooled = new Set(masteryCardIds);
  const plan: MasteryAdditionPlan = { add: [], alreadyPooled: [], unretire: [] };
  for (const card of selected) {
    if (leavesMasteryPool(card.masteryRating)) plan.unretire.push(card.id);
    if (pooled.has(card.id)) plan.alreadyPooled.push(card.id);
    else plan.add.push(card.id);
  }
  return plan;
}

export function updateMasteryCardIds(
  cardIds: readonly string[],
  cardId: string,
  mode: StudyMode,
  rating: MasteryRatingValue,
): string[] {
  const current = uniqueCardIds(cardIds);
  if (leavesMasteryPool(rating)) return current.filter((id) => id !== cardId);
  if (mode === "mastery" || rating === MasteryRating.Again) return uniqueCardIds([...current, cardId]);
  return current;
}

export function createStudySession(
  cards: readonly StudyCard[],
  settings: StudySettings,
  mode: StudyMode,
  random = Math.random,
  now = new Date(),
): StudySession {
  let candidates: StudyCard[];
  if (mode === "mastery") {
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    candidates = shuffleItems(
      cleanMasteryCardIds(cards, settings.masteryCardIds).map((cardId) => cardsById.get(cardId)!),
      random,
    );
  } else {
    // Chosen oldest first, so a review works through what you have not seen in
    // longest, but played in a random order: the selection rule alone would walk the
    // same sequence every time and turn the running order itself into a memory aid.
    const pool = filterReviewPool(cards, settings.reviewIncludesGotIt);
    candidates = shuffleItems(pool.slice(0, planEasyReview(pool.length, settings).sessionSize), random);
  }
  const order = candidates.map((card) => card.id);
  return {
    id: `${now.getTime()}-${mode}`,
    mode,
    queue: [...order],
    order,
    total: order.length,
    completed: 0,
    attempts: 0,
    results: [],
    answers: {},
    startedAt: now.toISOString(),
  };
}

export function addCardsToMasterySession(session: StudySession, cardIds: readonly string[]): StudySession {
  if (session.mode !== "mastery") return session;
  const knownIds = new Set(session.order);
  const additions = uniqueCardIds(cardIds).filter((cardId) => !knownIds.has(cardId));
  if (additions.length === 0) return session;
  return {
    ...session,
    queue: [...session.queue, ...additions],
    order: [...session.order, ...additions],
    total: session.total + additions.length,
  };
}

export function normalizeAnswerLabel(value: string): string {
  const normalized = value.trim().match(/^([A-Z])(?:\.|\)|:|\s|$)/i)?.[1];
  return normalized ? normalized.toUpperCase() : value.trim().toUpperCase();
}

export function evaluateAnswer(selectedAnswers: readonly string[], correctAnswers: readonly string[]): boolean | null {
  const selected = [...new Set(selectedAnswers.map(normalizeAnswerLabel).filter(Boolean))].sort();
  const correct = [...new Set(correctAnswers.map(normalizeAnswerLabel).filter(Boolean))].sort();
  if (correct.length === 0) return null;
  return selected.length === correct.length && selected.every((answer, index) => answer === correct[index]);
}

export function setSessionAnswer(session: StudySession, cardId: string, selectedAnswers: readonly string[]): StudySession {
  if (!session.order.includes(cardId)) return session;
  return { ...session, answers: { ...session.answers, [cardId]: [...selectedAnswers] } };
}

/**
 * Replaces the rating on an already-answered question and repairs the queue.
 *
 * Reached by stepping back through history, usually to correct a misclick. The queue
 * has to follow: a question re-rated back into the Mastery pool was removed from the
 * set and has to come back, and one raised out of the pool has to leave. Which of the
 * two labels above the pool it was given makes no difference here; only whether it is
 * still being drilled does. Ratings inside a review never change queue membership,
 * since every answer there completes.
 *
 * `answeredAt` is deliberately left alone so history keeps its original order and
 * stepping back does not shuffle under you.
 */
export function reviseStudyResult(
  session: StudySession,
  resultIndex: number,
  rating: MasteryRatingValue,
): StudySession {
  const previous = session.results[resultIndex];
  if (!previous || previous.rating === rating) return session;

  const results = session.results.map((result, index) => (index === resultIndex ? { ...result, rating } : result));
  const wasCompleted = session.mode === "easy-review" || leavesMasteryPool(previous.rating);
  const nowCompleted = session.mode === "easy-review" || leavesMasteryPool(rating);
  if (wasCompleted === nowCompleted) return { ...session, results };

  const inQueue = session.queue.includes(previous.cardId);
  const queue = nowCompleted
    ? session.queue.filter((cardId) => cardId !== previous.cardId)
    : inQueue ? session.queue : [...session.queue, previous.cardId];

  return {
    ...session,
    results,
    queue,
    completed: Math.max(0, session.completed + (nowCompleted ? 1 : -1)),
  };
}

export function advanceStudySession(
  session: StudySession,
  cardId: string,
  rating: MasteryRatingValue,
  selectedAnswers: readonly string[] = [],
  correctAnswers: readonly string[] = [],
  now = new Date(),
): StudySession {
  if (session.queue[0] !== cardId) return session;
  const remaining = session.queue.slice(1);
  const completed = session.mode === "easy-review" || leavesMasteryPool(rating);
  if (!completed) remaining.push(cardId);
  const result: StudyResult = {
    cardId,
    selectedAnswers: selectedAnswers.map(normalizeAnswerLabel),
    correctAnswers: correctAnswers.map(normalizeAnswerLabel),
    correct: evaluateAnswer(selectedAnswers, correctAnswers),
    rating,
    answeredAt: now.toISOString(),
    elapsedSeconds: Math.max(0, Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 1000)),
  };
  return {
    ...session,
    queue: remaining,
    completed: session.completed + (completed ? 1 : 0),
    attempts: session.attempts + 1,
    results: [...session.results, result],
    answers: { ...session.answers, [cardId]: [] },
  };
}

export function summarizeStudySession(session: StudySession): SessionSummary {
  const gradable = session.results.filter((result) => result.correct !== null);
  const correct = gradable.filter((result) => result.correct).length;
  const finishedAt = session.results.at(-1)?.answeredAt ?? session.startedAt;
  const durationSeconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(session.startedAt).getTime()) / 1000));
  return {
    total: session.total,
    completed: session.completed,
    attempts: session.attempts,
    correct,
    gradable: gradable.length,
    accuracy: gradable.length ? Math.round((correct / gradable.length) * 100) : null,
    durationSeconds,
    averageSeconds: session.completed ? Math.round((durationSeconds / session.completed) * 10) / 10 : 0,
  };
}
