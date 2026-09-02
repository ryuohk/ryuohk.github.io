import { describe, expect, it } from "vitest";
import {
  advanceStudySession,
  createStudySession,
  evaluateAnswer,
  filterEasyReviewPool,
  filterMasteryPool,
  summarizeStudySession,
  type StudySettings,
} from "./study-session";
import { MasteryRating, type MasteryRating as MasteryRatingValue, type StudyCard } from "./types";

const settings: StudySettings = {
  masterySetSize: 2,
  masteryPool: "all-not-easy",
  easyReviewSize: 2,
};

function card(id: string, masteryRating: MasteryRatingValue | null = null, ratingUpdatedAt: string | null = null): StudyCard {
  return {
    id,
    questionId: id,
    type: "question",
    front: `Question ${id}\n\nA. One\nB. Two`,
    back: "A",
    explanation: "",
    questionImages: [],
    answerImages: [],
    tags: ["EXAM-101"],
    confidence: "source-answer",
    sourceUrl: "https://example.test",
    createdAt: "2026-08-28T00:00:00.000Z",
    masteryRating,
    ratingUpdatedAt,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("mastery study sessions", () => {
  it("offers every non-Easy question in the full pool", () => {
    const cards = [
      card("unrated"),
      card("again", MasteryRating.Again),
      card("hard", MasteryRating.Hard),
      card("good", MasteryRating.Good),
      card("easy", MasteryRating.Easy),
    ];

    expect(filterMasteryPool(cards, "all-not-easy").map(({ id }) => id)).toEqual(["unrated", "again", "hard", "good"]);
    expect(filterMasteryPool(cards, "again-hard").map(({ id }) => id)).toEqual(["again", "hard"]);
  });

  it("limits a Mastery set to the configured number of unique questions", () => {
    const session = createStudySession([card("one"), card("two"), card("three")], settings, "mastery", () => 0.99);
    expect(session.order).toHaveLength(2);
    expect(new Set(session.order)).toHaveLength(2);
  });

  it("keeps a Mastery question in rotation until it is rated Easy", () => {
    const session = createStudySession([card("one"), card("two")], settings, "mastery", () => 0.99);
    const repeated = advanceStudySession(session, "one", MasteryRating.Good);
    const mastered = advanceStudySession(repeated, "two", MasteryRating.Easy);

    expect(repeated.queue).toEqual(["two", "one"]);
    expect(repeated.completed).toBe(0);
    expect(mastered.queue).toEqual(["one"]);
    expect(mastered.completed).toBe(1);
    expect(mastered.attempts).toBe(2);
  });

  it("reviews only Easy questions and chooses the least recently reviewed first", () => {
    const cards = [
      card("hard", MasteryRating.Hard, "2026-08-20T00:00:00.000Z"),
      card("newer", MasteryRating.Easy, "2026-08-28T00:00:00.000Z"),
      card("oldest", MasteryRating.Easy, "2026-08-01T00:00:00.000Z"),
      card("middle", MasteryRating.Easy, "2026-08-15T00:00:00.000Z"),
    ];

    expect(filterEasyReviewPool(cards).map(({ id }) => id)).toEqual(["oldest", "middle", "newer"]);
    const session = createStudySession(cards, settings, "easy-review");
    expect(session.order).toEqual(["oldest", "middle"]);
  });

  it("shows each Easy Review question once even when it is relabeled Hard", () => {
    const session = createStudySession([card("one", MasteryRating.Easy), card("two", MasteryRating.Easy)], settings, "easy-review");
    const next = advanceStudySession(session, "one", MasteryRating.Hard, ["A. One"], ["A"]);

    expect(next.queue).toEqual(["two"]);
    expect(next.completed).toBe(1);
    expect(next.results[0]).toMatchObject({ cardId: "one", rating: MasteryRating.Hard, correct: true });
  });

  it("checks normalized single and multiple-choice answers exactly", () => {
    expect(evaluateAnswer(["a. first"], ["A"])).toBe(true);
    expect(evaluateAnswer(["B. second", "A. first"], ["A", "B"])).toBe(true);
    expect(evaluateAnswer(["A. first"], ["A", "B"])).toBe(false);
    expect(evaluateAnswer([], [])).toBeNull();
  });

  it("summarizes elapsed time and average seconds per completed question", () => {
    const started = new Date("2026-08-28T12:00:00.000Z");
    const session = createStudySession([card("one", MasteryRating.Easy)], settings, "easy-review", Math.random, started);
    const completed = advanceStudySession(session, "one", MasteryRating.Easy, ["A"], ["A"], new Date("2026-08-28T12:00:08.000Z"));

    expect(summarizeStudySession(completed)).toMatchObject({ completed: 1, durationSeconds: 8, averageSeconds: 8, accuracy: 100 });
  });
});
