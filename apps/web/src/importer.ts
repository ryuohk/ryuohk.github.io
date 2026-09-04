import { generateCards, parseCaptureBundle } from "@crambot/core";
import type { StudySession, StudySettings } from "./study-session";
import { MasteryRating, type CapturedQuestion, type ReviewLog, type StudyCard } from "./types";

export interface PreparedImport {
  questions: CapturedQuestion[];
  cards: StudyCard[];
  added: number;
  updated: number;
  warnings: string[];
}

export interface PreparedLibraryRestore {
  questions: CapturedQuestion[];
  cards: StudyCard[];
  reviews: ReviewLog[];
  studyHistory: StudySession[];
  studySettings: Partial<StudySettings> | null;
}

function questionQuality(question: CapturedQuestion): number {
  const embeddedImages = question.images.filter((image) => image.dataUrl?.startsWith("data:image/")).length;
  return embeddedImages * 100
    + question.correctAnswers.length * 10
    + question.mostVotedAnswers.length * 5
    + (question.explanation ? 1 : 0)
    + (question.discussion?.comments.length || 0);
}

export function prepareBatchImport(inputs: unknown[], existingCards: StudyCard[] = [], now = new Date()): PreparedImport {
  if (!inputs.length) throw new TypeError("Choose at least one capture file.");
  const bundles = inputs.map((input) => parseCaptureBundle(input));
  const questionsById = new Map<string, CapturedQuestion>();
  for (const bundle of bundles) {
    for (const question of bundle.questions as CapturedQuestion[]) {
      const existing = questionsById.get(question.id);
      if (!existing || questionQuality(question) > questionQuality(existing)) questionsById.set(question.id, question);
    }
  }

  const existingById = new Map(existingCards.map((card) => [card.id, card]));
  const cards: StudyCard[] = [];
  let added = 0;
  let updated = 0;

  for (const question of questionsById.values()) {
    for (const generated of generateCards(question) as StudyCard[]) {
      const existing = existingById.get(generated.id);
      cards.push({
        ...generated,
        masteryRating: existing?.masteryRating ?? null,
        ratingUpdatedAt: existing?.ratingUpdatedAt ?? null,
        updatedAt: now.toISOString(),
        notes: existing?.notes ?? "",
        feedbackFlags: existing?.feedbackFlags ?? [],
      });
      if (existing) updated += 1;
      else added += 1;
    }
  }

  return {
    questions: [...questionsById.values()],
    cards,
    added,
    updated,
    warnings: bundles.flatMap((bundle) => bundle.warnings),
  };
}

export function prepareImport(input: unknown, existingCards: StudyCard[] = [], now = new Date()): PreparedImport {
  return prepareBatchImport([input], existingCards, now);
}

export function prepareImportSelection(inputs: unknown[], existingCards: StudyCard[] = [], now = new Date()) {
  if (!inputs.length) throw new TypeError("Choose at least one JSON file.");
  const libraryInputs = inputs.filter((input) => input && typeof input === "object" && (input as Record<string, unknown>).format === "crambot.library");
  if (libraryInputs.length) {
    if (inputs.length !== 1) throw new TypeError("Import a library backup by itself, not together with capture files.");
    return { kind: "library" as const, library: prepareLibraryRestore(libraryInputs[0]) };
  }
  return { kind: "captures" as const, prepared: prepareBatchImport(inputs, existingCards, now) };
}

export function prepareLibraryRestore(input: unknown): PreparedLibraryRestore {
  if (!input || typeof input !== "object") throw new TypeError("Library backup must be a JSON object.");
  const candidate = input as Record<string, unknown>;
  if (candidate.format !== "crambot.library") throw new TypeError(`Unsupported library format: ${String(candidate.format ?? "missing")}.`);
  if (candidate.version !== 1 && candidate.version !== 2) throw new TypeError(`Unsupported library version: ${String(candidate.version ?? "missing")}.`);
  if (!Array.isArray(candidate.cards) || !Array.isArray(candidate.questions) || !Array.isArray(candidate.reviews)) {
    throw new TypeError("Library backup is missing cards, questions, or reviews.");
  }

  const rawReviews = candidate.reviews.filter((value) => value && typeof value === "object" && "id" in value && "cardId" in value) as ReviewLog[];
  const latestRatings = new Map<string, ReviewLog>();
  for (const review of rawReviews) {
    if (![MasteryRating.Again, MasteryRating.Hard, MasteryRating.Good, MasteryRating.KeepFresh, MasteryRating.GotIt].includes(review.rating)) continue;
    const current = latestRatings.get(review.cardId);
    if (!current || current.reviewedAt < review.reviewedAt) latestRatings.set(review.cardId, review);
  }
  const studyHistory = Array.isArray(candidate.studyHistory)
    ? candidate.studyHistory.filter((value) => value && typeof value === "object" && "id" in value && "results" in value) as StudySession[]
    : [];
  if (candidate.version === 1) {
    for (const session of studyHistory) {
      for (const result of session.results) {
        if (![MasteryRating.Again, MasteryRating.Hard, MasteryRating.Good, MasteryRating.KeepFresh, MasteryRating.GotIt].includes(result.rating)) continue;
        const current = latestRatings.get(result.cardId);
        if (!current || current.reviewedAt < result.answeredAt) {
          latestRatings.set(result.cardId, {
            id: `${session.id}:${result.cardId}`,
            cardId: result.cardId,
            rating: result.rating,
            reviewedAt: result.answeredAt,
          });
        }
      }
    }
  }
  const cards = candidate.cards.map((value, index) => {
    const card = value as Partial<StudyCard>;
    if (!card || typeof card !== "object" || !card.id || !card.questionId || !card.front || !card.back) {
      throw new TypeError(`Library card ${index + 1} is malformed.`);
    }
    const latest = latestRatings.get(card.id);
    const { schedule: _schedule, suspended: _suspended, ...content } = card as Partial<StudyCard> & { schedule?: unknown; suspended?: boolean };
    return {
      ...content,
      tags: Array.isArray(card.tags) ? card.tags.map(String) : [],
      questionImages: Array.isArray(card.questionImages) ? card.questionImages : [],
      answerImages: Array.isArray(card.answerImages) ? card.answerImages : [],
      masteryRating: candidate.version === 2 && Object.hasOwn(card, "masteryRating") ? card.masteryRating ?? null : latest?.rating ?? null,
      ratingUpdatedAt: candidate.version === 2 && Object.hasOwn(card, "ratingUpdatedAt") ? card.ratingUpdatedAt ?? null : latest?.reviewedAt ?? null,
      notes: typeof card.notes === "string" ? card.notes : "",
      feedbackFlags: Array.isArray(card.feedbackFlags)
        ? card.feedbackFlags.filter((flag) => flag === "unclear" || flag === "wrong-answer" || flag === "outdated")
        : [],
      updatedAt: card.updatedAt || new Date().toISOString(),
    } as StudyCard;
  });

  const questions = candidate.questions.filter((value) => value && typeof value === "object" && "id" in value) as CapturedQuestion[];
  const reviews = rawReviews;
  const studySettings = candidate.studySettings && typeof candidate.studySettings === "object"
    ? candidate.studySettings as Partial<StudySettings>
    : null;
  return { questions, cards, reviews, studyHistory, studySettings };
}
