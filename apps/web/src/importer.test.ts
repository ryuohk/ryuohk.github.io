import { makeCaptureBundle } from "@crambot/core";
import { describe, expect, it } from "vitest";
import { prepareBatchImport, prepareImport, prepareImportSelection, prepareLibraryRestore } from "./importer";
import { MasteryRating } from "./types";

const question = {
  examCode: "EXAM-101",
  sourceUrl: "https://questions.example/example",
  topic: "Topic 1",
  number: "1",
  prompt: "Which option is appropriate?",
  choices: [
    { label: "A", text: "First" },
    { label: "B", text: "Second" },
  ],
  correctAnswers: ["B"],
};

describe("capture import", () => {
  it("creates an Unrated study card", () => {
    const result = prepareImport(makeCaptureBundle([question]), [], new Date("2026-08-28T12:00:00Z"));
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.cards[0]).toMatchObject({ back: "B. Second", masteryRating: null, ratingUpdatedAt: null });
  });

  it("preserves portable embedded images and legacy URL fallback", () => {
    const result = prepareImport(makeCaptureBundle([{
      ...question,
      images: [
        { src: "https://example.test/question.png", dataUrl: "data:image/png;base64,iVBORw==", role: "question" },
        { src: "https://example.test/answer.png", role: "answer" },
      ],
    }]), [], new Date("2026-08-28T12:00:00Z"));

    expect(result.cards[0].questionImages[0].dataUrl).toBe("data:image/png;base64,iVBORw==");
    expect(result.cards[0].answerImages[0].src).toBe("https://example.test/answer.png");
  });

  it("preserves the mastery label when refreshing a duplicate", () => {
    const first = prepareImport(makeCaptureBundle([question]), [], new Date("2026-08-28T12:00:00Z"));
    const reviewed = { ...first.cards[0], masteryRating: MasteryRating.Easy, ratingUpdatedAt: "2026-08-29T12:00:00.000Z" };
    const second = prepareImport(makeCaptureBundle([question]), [reviewed], new Date("2026-08-30T12:00:00Z"));

    expect(second.added).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.cards[0]).toMatchObject({ masteryRating: MasteryRating.Easy, ratingUpdatedAt: "2026-08-29T12:00:00.000Z" });
  });

  it("combines multiple captures and deduplicates repeated questions", () => {
    const richerQuestion = {
      ...question,
      images: [{ src: "https://example.test/diagram.png", dataUrl: "data:image/png;base64,iVBORw==", role: "question" }],
    };
    const secondQuestion = { ...question, number: "2", prompt: "Which second option is appropriate?" };
    const result = prepareBatchImport([
      makeCaptureBundle([{ ...richerQuestion, images: [{ src: "https://example.test/diagram.png", role: "question" }] }]),
      makeCaptureBundle([richerQuestion, secondQuestion]),
    ], [], new Date("2026-08-28T12:00:00Z"));

    expect(result.questions).toHaveLength(2);
    expect(result.cards).toHaveLength(2);
    expect(result.added).toBe(2);
    expect(result.questions.find((candidate) => candidate.number === "1")?.images[0].dataUrl).toBe("data:image/png;base64,iVBORw==");
  });

  it("counts a duplicated rated card once and preserves its label in a batch", () => {
    const first = prepareImport(makeCaptureBundle([question]), [], new Date("2026-08-28T12:00:00Z"));
    const reviewed = { ...first.cards[0], masteryRating: MasteryRating.Hard, ratingUpdatedAt: "2026-08-29T12:00:00.000Z" };
    const result = prepareBatchImport([
      makeCaptureBundle([question]),
      makeCaptureBundle([question]),
    ], [reviewed], new Date("2026-08-30T12:00:00Z"));

    expect(result.cards).toHaveLength(1);
    expect(result.added).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.cards[0].masteryRating).toBe(MasteryRating.Hard);
  });

  it("rejects unrelated JSON", () => {
    expect(() => prepareImport({ questions: [] })).toThrow(/Unsupported import format/);
  });

  it("derives current labels when restoring a version 1 backup", () => {
    const imported = prepareImport(makeCaptureBundle([question]), [], new Date("2026-08-28T12:00:00Z"));
    const legacyCard = { ...imported.cards[0] } as Record<string, unknown>;
    delete legacyCard.masteryRating;
    delete legacyCard.ratingUpdatedAt;
    const restored = prepareLibraryRestore({
      format: "crambot.library",
      version: 1,
      questions: imported.questions,
      cards: [legacyCard],
      reviews: [{ id: "review-1", cardId: imported.cards[0].id, rating: MasteryRating.Good, reviewedAt: "2026-08-28T12:01:00Z" }],
      studyHistory: [{ id: "session-1", results: [{ cardId: imported.cards[0].id, rating: MasteryRating.Hard, answeredAt: "2026-08-28T12:02:00Z" }] }],
      studySettings: { questionCount: 30 },
    });

    expect(restored.cards[0]).toMatchObject({ masteryRating: MasteryRating.Hard, ratingUpdatedAt: "2026-08-28T12:02:00Z" });
    expect(restored.reviews).toHaveLength(1);
    expect(restored.studyHistory).toHaveLength(1);
  });

  it("preserves an explicit reset in a version 2 backup", () => {
    const imported = prepareImport(makeCaptureBundle([question]), [], new Date("2026-08-28T12:00:00Z"));
    const restored = prepareLibraryRestore({
      format: "crambot.library",
      version: 2,
      questions: imported.questions,
      cards: imported.cards,
      reviews: [{ id: "old-review", cardId: imported.cards[0].id, rating: MasteryRating.Easy, reviewedAt: "2026-08-28T12:01:00Z" }],
    });

    expect(restored.cards[0]).toMatchObject({ masteryRating: null, ratingUpdatedAt: null });
  });

  it("requires a library backup to be selected by itself", () => {
    const imported = prepareImport(makeCaptureBundle([question]), [], new Date("2026-08-28T12:00:00Z"));
    const backup = {
      format: "crambot.library",
      version: 2,
      questions: imported.questions,
      cards: imported.cards,
      reviews: [],
    };

    expect(() => prepareImportSelection([backup, makeCaptureBundle([question])])).toThrow(/by itself/);
    expect(prepareImportSelection([backup]).kind).toBe("library");
  });

  it("rejects a malformed card in a backup", () => {
    expect(() => prepareLibraryRestore({
      format: "crambot.library",
      version: 2,
      questions: [],
      cards: [{ id: "card", questionId: "q", front: "front" }],
      reviews: [],
    })).toThrow(/malformed/i);
  });
});
