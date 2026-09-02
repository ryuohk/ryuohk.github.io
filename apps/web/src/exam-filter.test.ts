import { describe, expect, it } from "vitest";
import { ALL_EXAMS, filterCardsByExam, listExamCodes } from "./exam-filter";
import type { CapturedQuestion, StudyCard } from "./types";

function card(id: string, questionId: string, examTag: string): StudyCard {
  return {
    id,
    questionId,
    type: "multiple-choice",
    front: "Question",
    back: "Answer",
    explanation: "",
    questionImages: [],
    answerImages: [],
    tags: [examTag],
    confidence: "source-answer",
    sourceUrl: "https://example.test",
    createdAt: "2026-08-30T00:00:00.000Z",
    masteryRating: null,
    ratingUpdatedAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function question(id: string, examCode: string): CapturedQuestion {
  return {
    id,
    examCode,
    sourceUrl: "https://example.test",
    topic: "",
    number: "1",
    prompt: "Question",
    choices: [{ label: "A", text: "One" }, { label: "B", text: "Two" }],
    correctAnswers: ["A"],
    mostVotedAnswers: [],
    voteDistribution: [],
    explanation: "",
    discussionCount: null,
    discussion: null,
    images: [],
    capturedAt: "2026-08-30T00:00:00.000Z",
  };
}

describe("exam filtering", () => {
  it("lists every imported exam and filters cards without mixing them", () => {
    const cards = [card("one", "q-one", "STALE-TAG"), card("two", "q-two", "DP-203")];
    const questions = new Map([
      ["q-one", question("q-one", "az-305")],
      ["q-two", question("q-two", "DP-203")],
    ]);

    expect(listExamCodes(cards, questions)).toEqual(["AZ-305", "DP-203"]);
    expect(filterCardsByExam(cards, "AZ-305", questions).map(({ id }) => id)).toEqual(["one"]);
    expect(filterCardsByExam(cards, ALL_EXAMS, questions).map(({ id }) => id)).toEqual(["one", "two"]);
  });

  it("falls back to the card tag when its question row has not synced yet", () => {
    const cards = [card("tagged", "missing", "SC-300"), card("untagged", "also-missing", "")];
    const questions = new Map<string, CapturedQuestion>();

    expect(listExamCodes(cards, questions)).toEqual(["SC-300", "UNSPECIFIED"]);
    expect(filterCardsByExam(cards, "SC-300", questions).map(({ id }) => id)).toEqual(["tagged"]);
    expect(filterCardsByExam(cards, "UNSPECIFIED", questions).map(({ id }) => id)).toEqual(["untagged"]);
  });
});
