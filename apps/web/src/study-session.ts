import { MasteryRating, type MasteryRating as MasteryRatingValue, type StudyCard } from "./types";

export type StudyMode = "mastery" | "easy-review";
export type MasteryPool = "all-not-easy" | "again-hard";

export interface StudySettings {
  masterySetSize: number;
  masteryPool: MasteryPool;
  easyReviewSize: number;
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

export function filterEasyReviewPool(cards: readonly StudyCard[]): StudyCard[] {
  return cards
    .filter((card) => card.masteryRating === MasteryRating.Easy)
    .sort((left, right) => (left.ratingUpdatedAt ?? "").localeCompare(right.ratingUpdatedAt ?? ""));
}

export function createStudySession(
  cards: readonly StudyCard[],
  settings: StudySettings,
  mode: StudyMode,
  random = Math.random,
  now = new Date(),
): StudySession {
  const candidates = mode === "mastery"
    ? shuffleItems(filterMasteryPool(cards, settings.masteryPool), random).slice(0, settings.masterySetSize)
    : filterEasyReviewPool(cards).slice(0, settings.easyReviewSize);
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
    answers: { ...session.answers, [cardId]: [...selectedAnswers] },
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
