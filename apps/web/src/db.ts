import { openDB, type DBSchema, type IDBPTransaction } from "idb";
import { retagCardTopic, sameTopic } from "./topics";
import { MasteryRating, type CapturedQuestion, type ReviewLog, type StudyCard } from "./types";

/**
 * Kinds of local change the cloud sync still has to push.
 *  question / card      -> shared library content
 *  progress / review    -> the signed-in person's private study record
 *  card-deleted         -> a shared card removed from the library
 *  question-deleted     -> a shared question that lost its last card
 */
export type PendingKind = "question" | "card" | "progress" | "review" | "card-deleted" | "question-deleted";

export interface PendingEntry {
  key: string;
  kind: PendingKind;
  entityId: string;
  queuedAt: string;
}

interface CramBotDatabase extends DBSchema {
  questions: {
    key: string;
    value: CapturedQuestion;
  };
  cards: {
    key: string;
    value: StudyCard;
  };
  reviews: {
    key: string;
    value: ReviewLog;
    indexes: { "by-card": string };
  };
  pending: {
    key: string;
    value: PendingEntry;
  };
}

const databasePromise = openDB<CramBotDatabase>("crambot", 3, {
  upgrade(database, oldVersion, _newVersion, _transaction) {
    if (oldVersion < 1) {
      database.createObjectStore("questions", { keyPath: "id" });
      database.createObjectStore("cards", { keyPath: "id" });
      const reviews = database.createObjectStore("reviews", { keyPath: "id" });
      reviews.createIndex("by-card", "cardId");
    }
    if (oldVersion < 2) {
      database.createObjectStore("pending", { keyPath: "key" });
    }
  },
});

type AnyTransaction = IDBPTransaction<CramBotDatabase, readonly ("questions" | "cards" | "reviews" | "pending")[], "readwrite">;

function pendingEntry(kind: PendingKind, entityId: string): PendingEntry {
  return { key: `${kind}:${entityId}`, kind, entityId, queuedAt: new Date().toISOString() };
}

/** Records local changes inside an existing transaction so the queue can never drift from the data. */
function queue(transaction: AnyTransaction, entries: Array<[PendingKind, string]>): Array<Promise<unknown>> {
  const store = transaction.objectStore("pending");
  return entries.map(([kind, entityId]) => store.put(pendingEntry(kind, entityId)));
}

function isMasteryRating(value: unknown): value is ReviewLog["rating"] {
  return value === MasteryRating.Again
    || value === MasteryRating.Hard
    || value === MasteryRating.Good
    || value === MasteryRating.KeepFresh
    || value === MasteryRating.GotIt;
}

export async function ensureMasteryProgress(): Promise<void> {
  const database = await databasePromise;
  const transaction = database.transaction(["cards", "reviews", "pending"], "readwrite");
  const cards = await transaction.objectStore("cards").getAll();
  const unmigrated = cards.filter((card) => !Object.hasOwn(card, "masteryRating"));
  if (unmigrated.length === 0) {
    await transaction.done;
    return;
  }

  const latest = new Map<string, { rating: ReviewLog["rating"]; at: string }>();
  for (const review of await transaction.objectStore("reviews").getAll()) {
    if (!isMasteryRating(review.rating)) continue;
    const current = latest.get(review.cardId);
    if (!current || current.at < review.reviewedAt) latest.set(review.cardId, { rating: review.rating, at: review.reviewedAt });
  }

  if (typeof localStorage !== "undefined") {
    for (const key of ["crambot-active-study-session", "crambot-study-history"]) {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
        const sessions = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        for (const session of sessions) {
          if (!session || typeof session !== "object" || !("results" in session) || !Array.isArray(session.results)) continue;
          for (const result of session.results) {
            if (!result || typeof result !== "object" || !("cardId" in result) || !("rating" in result) || !("answeredAt" in result)) continue;
            if (typeof result.cardId !== "string" || typeof result.answeredAt !== "string" || !isMasteryRating(result.rating)) continue;
            const current = latest.get(result.cardId);
            if (!current || current.at < result.answeredAt) latest.set(result.cardId, { rating: result.rating, at: result.answeredAt });
          }
        }
      } catch {
        // A malformed obsolete session must not block the card migration.
      }
    }
  }

  const migrated = unmigrated.map((card): StudyCard => {
    const progress = latest.get(card.id);
    const { schedule: _schedule, suspended: _suspended, ...content } = card as StudyCard & { schedule?: unknown; suspended?: boolean };
    return {
      ...content,
      masteryRating: progress?.rating ?? null,
      ratingUpdatedAt: progress?.at ?? null,
    };
  });
  await Promise.all([
    ...migrated.map((card) => transaction.objectStore("cards").put(card)),
    ...queue(transaction, migrated.map((card): [PendingKind, string] => ["progress", card.id])),
    transaction.done,
  ]);
}

export async function resetMasteryRatings(cardIds: readonly string[], now = new Date()): Promise<StudyCard[]> {
  const database = await databasePromise;
  const transaction = database.transaction(["cards", "pending"], "readwrite");
  const cards = await transaction.objectStore("cards").getAll();
  const targetIds = new Set(cardIds);
  const changed = cards
    .filter((card) => targetIds.has(card.id))
    .map((card): StudyCard => ({
      ...card,
      masteryRating: null,
      ratingUpdatedAt: null,
      updatedAt: now.toISOString(),
    }));
  const changedById = new Map(changed.map((card) => [card.id, card]));
  const updated = cards.map((card) => changedById.get(card.id) ?? card);
  await Promise.all([
    ...changed.map((card) => transaction.objectStore("cards").put(card)),
    ...queue(transaction, changed.map((card): [PendingKind, string] => ["progress", card.id])),
    transaction.done,
  ]);
  return updated;
}

export async function listCards(): Promise<StudyCard[]> {
  return (await databasePromise).getAll("cards");
}

export async function listQuestions(): Promise<CapturedQuestion[]> {
  return (await databasePromise).getAll("questions");
}

export async function listReviews(): Promise<ReviewLog[]> {
  return (await databasePromise).getAll("reviews");
}

export async function listPending(): Promise<PendingEntry[]> {
  return (await databasePromise).getAll("pending");
}

export async function clearPending(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const database = await databasePromise;
  const transaction = database.transaction("pending", "readwrite");
  await Promise.all([...keys.map((key) => transaction.store.delete(key)), transaction.done]);
}

export async function saveCard(card: StudyCard): Promise<void> {
  const database = await databasePromise;
  const transaction = database.transaction(["cards", "pending"], "readwrite");
  await Promise.all([
    transaction.objectStore("cards").put(card),
    ...queue(transaction, [["card", card.id], ["progress", card.id]]),
    transaction.done,
  ]);
}

export async function saveImport(questions: CapturedQuestion[], cards: StudyCard[]): Promise<void> {
  const database = await databasePromise;
  const transaction = database.transaction(["questions", "cards", "pending"], "readwrite");
  await Promise.all([
    ...questions.map((question) => transaction.objectStore("questions").put(question)),
    ...cards.map((card) => transaction.objectStore("cards").put(card)),
    ...queue(transaction, [
      ...questions.map((question): [PendingKind, string] => ["question", question.id]),
      ...cards.flatMap((card): Array<[PendingKind, string]> => [["card", card.id], ["progress", card.id]]),
    ]),
    transaction.done,
  ]);
}

export async function restoreLibrary(questions: CapturedQuestion[], cards: StudyCard[], reviews: ReviewLog[]): Promise<void> {
  const database = await databasePromise;
  const transaction = database.transaction(["questions", "cards", "reviews", "pending"], "readwrite");
  await Promise.all([
    ...questions.map((question) => transaction.objectStore("questions").put(question)),
    ...cards.map((card) => transaction.objectStore("cards").put(card)),
    ...reviews.map((review) => transaction.objectStore("reviews").put(review)),
    ...queue(transaction, [
      ...questions.map((question): [PendingKind, string] => ["question", question.id]),
      ...cards.flatMap((card): Array<[PendingKind, string]> => [["card", card.id], ["progress", card.id]]),
      ...reviews.map((review): [PendingKind, string] => ["review", review.id]),
    ]),
    transaction.done,
  ]);
}

/**
 * Renames a topic across every question carrying it, or clears it when `to` is empty.
 *
 * A topic lives in two places: on the question, and copied onto each of its cards as a
 * tag beside the exam code. The copy is what shows under a question while you study, so
 * both are rewritten together or the change appears not to have worked.
 *
 * Only shared library content is queued. Ratings, which are private and per person, are
 * not touched by any of this: a question keeps its own label through a rename.
 */
export async function retopicQuestions(from: string, to: string, now = new Date()): Promise<{ questions: CapturedQuestion[]; cards: StudyCard[] }> {
  const database = await databasePromise;
  const transaction = database.transaction(["questions", "cards", "pending"], "readwrite");
  const questions = await transaction.objectStore("questions").getAll();
  const cards = await transaction.objectStore("cards").getAll();

  const changedQuestions = questions
    .filter((question) => sameTopic(question.topic, from))
    .map((question): CapturedQuestion => ({ ...question, topic: to }));
  const changedIds = new Set(changedQuestions.map((question) => question.id));
  const changedCards = cards
    .filter((card) => changedIds.has(card.questionId))
    .map((card): StudyCard => ({ ...card, tags: retagCardTopic(card.tags, from, to), updatedAt: now.toISOString() }));

  await Promise.all([
    ...changedQuestions.map((question) => transaction.objectStore("questions").put(question)),
    ...changedCards.map((card) => transaction.objectStore("cards").put(card)),
    ...queue(transaction, [
      ...changedQuestions.map((question): [PendingKind, string] => ["question", question.id]),
      ...changedCards.map((card): [PendingKind, string] => ["card", card.id]),
    ]),
    transaction.done,
  ]);

  const questionById = new Map(changedQuestions.map((question) => [question.id, question]));
  const cardById = new Map(changedCards.map((card) => [card.id, card]));
  return {
    questions: questions.map((question) => questionById.get(question.id) ?? question),
    cards: cards.map((card) => cardById.get(card.id) ?? card),
  };
}

export async function saveReview(card: StudyCard, review: ReviewLog): Promise<void> {
  await saveReviews([{ card, review }]);
}

export async function saveReviews(entries: Array<{ card: StudyCard; review: ReviewLog }>): Promise<void> {
  if (entries.length === 0) return;
  const database = await databasePromise;
  const transaction = database.transaction(["cards", "reviews", "pending"], "readwrite");
  await Promise.all([
    ...entries.map(({ card }) => transaction.objectStore("cards").put(card)),
    ...entries.map(({ review }) => transaction.objectStore("reviews").put(review)),
    ...queue(transaction, [
      ...entries.map(({ card }): [PendingKind, string] => ["progress", card.id]),
      ...entries.map(({ review }): [PendingKind, string] => ["review", review.id]),
    ]),
    transaction.done,
  ]);
}

export async function removeCards(cardsToRemove: Pick<StudyCard, "id" | "questionId">[]): Promise<void> {
  if (cardsToRemove.length === 0) return;

  const database = await databasePromise;
  const transaction = database.transaction(["questions", "cards", "reviews", "pending"], "readwrite");
  const cards = transaction.objectStore("cards");
  const questions = transaction.objectStore("questions");
  const reviews = transaction.objectStore("reviews");
  const cardIds = new Set(cardsToRemove.map((card) => card.id));
  const questionIds = new Set(cardsToRemove.map((card) => card.questionId));
  const storedCards = await cards.getAll();
  const retainedQuestionIds = new Set(
    storedCards
      .filter((card) => !cardIds.has(card.id))
      .map((card) => card.questionId),
  );
  const reviewKeyGroups = await Promise.all(
    cardsToRemove.map((card) => reviews.index("by-card").getAllKeys(card.id)),
  );
  const orphanedQuestionIds = [...questionIds].filter((questionId) => !retainedQuestionIds.has(questionId));

  await Promise.all([
    ...cardsToRemove.map((card) => cards.delete(card.id)),
    ...reviewKeyGroups.flatMap((keys) => keys.map((key) => reviews.delete(key))),
    ...orphanedQuestionIds.map((questionId) => questions.delete(questionId)),
    ...queue(transaction, [
      ...cardsToRemove.map((card): [PendingKind, string] => ["card-deleted", card.id]),
      ...orphanedQuestionIds.map((questionId): [PendingKind, string] => ["question-deleted", questionId]),
    ]),
  ]);
  await transaction.done;
}

/**
 * Writes pulled from the cloud. These deliberately do not queue anything: the rows
 * already exist upstream, and re-queueing them would make two devices ping-pong.
 */
export async function applyRemoteLibrary(questions: CapturedQuestion[], cards: StudyCard[], reviews: ReviewLog[]): Promise<void> {
  if (questions.length === 0 && cards.length === 0 && reviews.length === 0) return;
  const database = await databasePromise;
  const transaction = database.transaction(["questions", "cards", "reviews"], "readwrite");
  await Promise.all([
    ...questions.map((question) => transaction.objectStore("questions").put(question)),
    ...cards.map((card) => transaction.objectStore("cards").put(card)),
    ...reviews.map((review) => transaction.objectStore("reviews").put(review)),
    transaction.done,
  ]);
}

export async function applyRemoteDeletions(cardIds: string[], questionIds: string[]): Promise<void> {
  if (cardIds.length === 0 && questionIds.length === 0) return;
  const database = await databasePromise;
  const transaction = database.transaction(["questions", "cards", "reviews"], "readwrite");
  const reviews = transaction.objectStore("reviews");
  const reviewKeyGroups = await Promise.all(cardIds.map((cardId) => reviews.index("by-card").getAllKeys(cardId)));
  await Promise.all([
    ...cardIds.map((cardId) => transaction.objectStore("cards").delete(cardId)),
    ...questionIds.map((questionId) => transaction.objectStore("questions").delete(questionId)),
    ...reviewKeyGroups.flatMap((keys) => keys.map((key) => reviews.delete(key))),
  ]);
  await transaction.done;
}

export async function exportLibrary(): Promise<{ format: string; version: number; exportedAt: string; cards: StudyCard[]; questions: CapturedQuestion[]; reviews: ReviewLog[] }> {
  const database = await databasePromise;
  const [cards, questions, reviews] = await Promise.all([
    database.getAll("cards"),
    database.getAll("questions"),
    database.getAll("reviews"),
  ]);
  return {
    format: "crambot.library",
    version: 2,
    exportedAt: new Date().toISOString(),
    cards,
    questions,
    reviews,
  };
}
