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
  masteryCardIds: string[];
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

export function filterMasteryPool(cards: readonly StudyCard[], pool: MasteryPool): StudyCard[] {
  return cards.filter((card) => {
    if (card.masteryRating === MasteryRating.Easy) return false;
    if (pool === "again-hard") {
      return card.masteryRating === MasteryRating.Again || card.masteryRating === MasteryRating.Hard;
    }
    return true;
  });
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

export function filterEasyReviewPool(cards: readonly StudyCard[]): StudyCard[] {
  return cards
    .filter((card) => card.masteryRating === MasteryRating.Easy)
    .sort((left, right) => (left.ratingUpdatedAt ?? "").localeCompare(right.ratingUpdatedAt ?? ""));
}

function uniqueCardIds(cardIds: readonly string[]): string[] {
  return [...new Set(cardIds.filter(Boolean))];
}

export function cleanMasteryCardIds(cards: readonly StudyCard[], cardIds: readonly string[]): string[] {
  const activeIds = new Set(cards.filter((card) => card.masteryRating !== MasteryRating.Easy).map((card) => card.id));
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
  /** Marked Got it, so their label has to be cleared or the pool will shed them again. */
  unretire: string[];
}

/**
 * Works out what adding a hand-picked set of questions to the Mastery pool involves.
 *
 * The pool holds what you have not got yet, and every sync strips anything marked Got
 * it out of it. So a question you already know cannot simply be put back: its label has
 * to go first, or it would appear to be added and then quietly vanish. Choosing a
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
    if (card.masteryRating === MasteryRating.Easy) plan.unretire.push(card.id);
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
  if (rating === MasteryRating.Easy) return current.filter((id) => id !== cardId);
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
    const pool = filterEasyReviewPool(cards);
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
 * Reached by stepping back through history, usually to correct a misclick. The
 * queue has to follow: a question re-rated below Easy was previously removed from
 * the set and has to come back, and one raised to Easy has to leave. Ratings inside
 * an Easy review never change queue membership, since every answer there completes.
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
  const wasCompleted = session.mode === "easy-review" || previous.rating === MasteryRating.Easy;
  const nowCompleted = session.mode === "easy-review" || rating === MasteryRating.Easy;
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
  const completed = session.mode === "easy-review" || rating === MasteryRating.Easy;
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
