import { describe, expect, it } from "vitest";
import {
  addCardsToMasterySession,
  advanceStudySession,
  cleanMasteryCardIds,
  createStudySession,
  evaluateAnswer,
  filterEasyReviewPool,
  filterMasteryPool,
  reviseStudyResult,
  selectMasteryAdditions,
  summarizeStudySession,
  updateMasteryCardIds,
  type StudySettings,
} from "./study-session";
import { MasteryRating, type MasteryRating as MasteryRatingValue, type StudyCard } from "./types";

const settings: StudySettings = {
  masterySetSize: 2,
  masteryPool: "all-not-easy",
  easyReviewSize: 2,
  masteryCardIds: [],
  speakQuestions: false,
  speechRate: 1.1,
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

  it("builds a Mastery session only from the persistent pool", () => {
    const pooled = { ...settings, masteryCardIds: ["one", "two"] };
    const session = createStudySession([card("one"), card("two"), card("outside")], pooled, "mastery", () => 0.99);

    expect(new Set(session.order)).toEqual(new Set(["one", "two"]));
    expect(session.order).not.toContain("outside");
  });

  it("prioritizes Again cards when adding a limited batch to the Mastery pool", () => {
    const oneQuestion = { ...settings, masterySetSize: 1 };
    const additions = selectMasteryAdditions([
      card("unrated"),
      card("forgotten", MasteryRating.Again),
      card("good", MasteryRating.Good),
    ], oneQuestion, () => 0.99);

    expect(additions).toEqual(["forgotten"]);
  });

  it("adds Review Easy failures to the pool once and removes them only at Easy", () => {
    const ignoredHard = updateMasteryCardIds([], "needs-work", "easy-review", MasteryRating.Hard);
    const added = updateMasteryCardIds([], "forgotten", "easy-review", MasteryRating.Again);
    const deduplicated = updateMasteryCardIds(added, "forgotten", "easy-review", MasteryRating.Again);
    const retained = updateMasteryCardIds(deduplicated, "forgotten", "mastery", MasteryRating.Good);
    const removed = updateMasteryCardIds(retained, "forgotten", "mastery", MasteryRating.Easy);

    expect(ignoredHard).toEqual([]);
    expect(added).toEqual(["forgotten"]);
    expect(deduplicated).toEqual(["forgotten"]);
    expect(retained).toEqual(["forgotten"]);
    expect(removed).toEqual([]);
  });

  it("appends unique questions to a running Mastery session", () => {
    const session = createStudySession([card("one")], { ...settings, masteryCardIds: ["one"] }, "mastery");
    const expanded = addCardsToMasterySession(session, ["two", "one", "two"]);

    expect(expanded.queue).toEqual(["one", "two"]);
    expect(expanded.order).toEqual(["one", "two"]);
    expect(expanded.total).toBe(2);
  });

  it("prunes missing, duplicate, and Easy cards from a saved Mastery pool", () => {
    expect(cleanMasteryCardIds(
      [card("active", MasteryRating.Hard), card("easy", MasteryRating.Easy)],
      ["active", "missing", "easy", "active"],
    )).toEqual(["active"]);
  });

  it("keeps a Mastery question in rotation until it is rated Easy", () => {
    const session = createStudySession([card("one"), card("two")], { ...settings, masteryCardIds: ["one", "two"] }, "mastery", () => 0.99);
    const repeated = advanceStudySession(session, "one", MasteryRating.Good, ["A. One"], ["A"]);
    const mastered = advanceStudySession(repeated, "two", MasteryRating.Easy);

    expect(repeated.queue).toEqual(["two", "one"]);
    expect(repeated.completed).toBe(0);
    expect(repeated.results[0]).toMatchObject({ cardId: "one", selectedAnswers: ["A"], correct: true });
    expect(repeated.answers.one).toEqual([]);
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

describe("revising an earlier answer", () => {
  const pooled = { ...settings, masteryCardIds: ["one", "two"] };

  it("brings a question back into the set when Easy is corrected downward", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const mastered = advanceStudySession(session, session.queue[0], MasteryRating.Easy, [], []);
    expect(mastered.completed).toBe(1);
    expect(mastered.queue).not.toContain(session.queue[0]);

    const corrected = reviseStudyResult(mastered, 0, MasteryRating.Again);
    expect(corrected.results[0].rating).toBe(MasteryRating.Again);
    expect(corrected.completed).toBe(0);
    expect(corrected.queue).toContain(session.queue[0]);
  });

  it("removes a question from the set when it is raised to Easy", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const first = session.queue[0];
    const again = advanceStudySession(session, first, MasteryRating.Again, [], []);
    expect(again.queue).toContain(first);

    const corrected = reviseStudyResult(again, 0, MasteryRating.Easy);
    expect(corrected.completed).toBe(1);
    expect(corrected.queue).not.toContain(first);
  });

  it("leaves the queue alone when both ratings are below Easy", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const again = advanceStudySession(session, session.queue[0], MasteryRating.Again, [], []);
    const corrected = reviseStudyResult(again, 0, MasteryRating.Hard);

    expect(corrected.queue).toEqual(again.queue);
    expect(corrected.completed).toBe(again.completed);
    expect(corrected.results[0].rating).toBe(MasteryRating.Hard);
  });

  it("never queues a duplicate when the question is already pending", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const first = session.queue[0];
    const again = advanceStudySession(session, first, MasteryRating.Again, [], []);
    // Force the odd case of a completed result whose card is still queued.
    const odd = { ...again, results: [{ ...again.results[0], rating: MasteryRating.Easy }], completed: 1 };

    const corrected = reviseStudyResult(odd, 0, MasteryRating.Again);
    expect(corrected.queue.filter((id) => id === first)).toHaveLength(1);
  });

  it("keeps queue membership unchanged in an Easy review, where every answer completes", () => {
    const session = createStudySession([card("one", MasteryRating.Easy), card("two", MasteryRating.Easy)], settings, "easy-review");
    const reviewed = advanceStudySession(session, session.queue[0], MasteryRating.Easy, [], []);
    const corrected = reviseStudyResult(reviewed, 0, MasteryRating.Again);

    expect(corrected.queue).toEqual(reviewed.queue);
    expect(corrected.completed).toBe(reviewed.completed);
    expect(corrected.results[0].rating).toBe(MasteryRating.Again);
  });

  it("ignores an unchanged rating and an index that does not exist", () => {
    const session = createStudySession([card("one")], { ...settings, masteryCardIds: ["one"] }, "mastery");
    const again = advanceStudySession(session, "one", MasteryRating.Again, [], []);

    expect(reviseStudyResult(again, 0, MasteryRating.Again)).toBe(again);
    expect(reviseStudyResult(again, 9, MasteryRating.Easy)).toBe(again);
  });

  it("preserves the original answer time so history keeps its order", () => {
    const session = createStudySession([card("one")], { ...settings, masteryCardIds: ["one"] }, "mastery");
    const again = advanceStudySession(session, "one", MasteryRating.Again, [], [], new Date("2026-08-28T12:00:05.000Z"));
    const corrected = reviseStudyResult(again, 0, MasteryRating.Good);

    expect(corrected.results[0].answeredAt).toBe(again.results[0].answeredAt);
  });
});
