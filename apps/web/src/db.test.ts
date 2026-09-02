import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { exportLibrary, removeCards, resetMasteryRatings, restoreLibrary } from "./db";
import { MasteryRating, type CapturedQuestion, type ReviewLog, type StudyCard } from "./types";

function question(id: string): CapturedQuestion {
  return {
    id,
    examCode: "EXAM-101",
    sourceUrl: `https://example.test/${id}`,
    topic: "Test",
    number: "1",
    prompt: "Test question",
    choices: [{ label: "A", text: "One" }, { label: "B", text: "Two" }],
    correctAnswers: ["A"],
    mostVotedAnswers: [],
    voteDistribution: [],
    explanation: "Test explanation",
    discussionCount: null,
    discussion: null,
    images: [],
    capturedAt: "2026-08-28T12:00:00.000Z",
  };
}

function card(id: string, questionId: string): StudyCard {
  return {
    id,
    questionId,
    type: "exam-question",
    front: "Test question\n\nA. One\nB. Two",
    back: "A",
    explanation: "Test explanation",
    questionImages: [],
    answerImages: [],
    tags: ["EXAM-101"],
    confidence: "source-answer",
    sourceUrl: `https://example.test/${questionId}`,
    createdAt: "2026-08-28T12:00:00.000Z",
    masteryRating: MasteryRating.Good,
    ratingUpdatedAt: "2026-08-28T12:05:00.000Z",
    updatedAt: "2026-08-28T12:05:00.000Z",
  };
}

function review(id: string, cardId: string): ReviewLog {
  return {
    id,
    cardId,
    rating: MasteryRating.Good,
    reviewedAt: "2026-08-28T12:05:00.000Z",
  };
}

describe("removeCards", () => {
  it("removes the selected card and its reviews but preserves a shared source question", async () => {
    const sharedQuestion = question("remove-test-question");
    const removedCard = card("remove-test-card", sharedQuestion.id);
    const retainedCard = card("retain-test-card", sharedQuestion.id);
    const removedReview = review("remove-test-review", removedCard.id);
    const retainedReview = review("retain-test-review", retainedCard.id);

    await restoreLibrary([sharedQuestion], [removedCard, retainedCard], [removedReview, retainedReview]);
    await removeCards([removedCard]);

    let library = await exportLibrary();
    expect(library.cards.some(({ id }) => id === removedCard.id)).toBe(false);
    expect(library.reviews.some(({ id }) => id === removedReview.id)).toBe(false);
    expect(library.cards.some(({ id }) => id === retainedCard.id)).toBe(true);
    expect(library.reviews.some(({ id }) => id === retainedReview.id)).toBe(true);
    expect(library.questions.some(({ id }) => id === sharedQuestion.id)).toBe(true);

    await removeCards([retainedCard]);
    library = await exportLibrary();
    expect(library.questions.some(({ id }) => id === sharedQuestion.id)).toBe(false);
  });

  it("removes multiple cards, their reviews, and every orphaned source question", async () => {
    const firstQuestion = question("bulk-remove-first-question");
    const secondQuestion = question("bulk-remove-second-question");
    const firstCard = card("bulk-remove-first-card", firstQuestion.id);
    const secondCard = card("bulk-remove-second-card", secondQuestion.id);
    const firstReview = review("bulk-remove-first-review", firstCard.id);
    const secondReview = review("bulk-remove-second-review", secondCard.id);

    await restoreLibrary(
      [firstQuestion, secondQuestion],
      [firstCard, secondCard],
      [firstReview, secondReview],
    );
    await removeCards([firstCard, secondCard]);

    const library = await exportLibrary();
    expect(library.cards.some(({ id }) => id === firstCard.id || id === secondCard.id)).toBe(false);
    expect(library.reviews.some(({ id }) => id === firstReview.id || id === secondReview.id)).toBe(false);
    expect(library.questions.some(({ id }) => id === firstQuestion.id || id === secondQuestion.id)).toBe(false);
  });
});

describe("resetMasteryRatings", () => {
  it("resets every current label without deleting questions or review history", async () => {
    const storedQuestion = question("reset-test-question");
    const storedCard = card("reset-test-card", storedQuestion.id);
    const storedReview = review("reset-test-review", storedCard.id);
    await restoreLibrary([storedQuestion], [storedCard], [storedReview]);

    const updated = await resetMasteryRatings([storedCard.id], new Date("2026-08-29T12:00:00.000Z"));
    const resetCard = updated.find(({ id }) => id === storedCard.id);
    const library = await exportLibrary();

    expect(resetCard).toMatchObject({ masteryRating: null, ratingUpdatedAt: null, updatedAt: "2026-08-29T12:00:00.000Z" });
    expect(library.questions.some(({ id }) => id === storedQuestion.id)).toBe(true);
    expect(library.reviews.some(({ id }) => id === storedReview.id)).toBe(true);
  });

  it("resets labels only for the selected exam cards", async () => {
    const firstQuestion = question("exam-one-question");
    const secondQuestion = { ...question("exam-two-question"), examCode: "EXAM-202" };
    const firstCard = card("exam-one-card", firstQuestion.id);
    const secondCard = { ...card("exam-two-card", secondQuestion.id), tags: ["EXAM-202"] };
    await restoreLibrary([firstQuestion, secondQuestion], [firstCard, secondCard], []);

    const updated = await resetMasteryRatings([firstCard.id], new Date("2026-08-30T12:00:00.000Z"));

    expect(updated.find(({ id }) => id === firstCard.id)).toMatchObject({ masteryRating: null, ratingUpdatedAt: null });
    expect(updated.find(({ id }) => id === secondCard.id)).toMatchObject({
      masteryRating: MasteryRating.Good,
      ratingUpdatedAt: "2026-08-28T12:05:00.000Z",
    });
  });
});
