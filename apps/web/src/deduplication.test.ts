import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { generateCards, sanitizeQuestion, makeCaptureBundle } from "@crambot/core";
import { consolidateLibrary, remapSession, remapSettings } from "./deduplication";
import { prepareBatchImport, prepareLibraryRestore } from "./importer";
import { applyRemoteLibrary, exportLibrary, listCards, listQuestions, restoreLibrary, saveImport, saveReview, resetMasteryRatings } from "./db";
import { createStudySession, type StudySettings } from "./study-session";
import { MasteryRating, type CapturedQuestion, type StudyCard } from "./types";

const at = "2026-09-01T00:00:00.000Z";
function question(id: string, overrides = {}): CapturedQuestion {
  return sanitizeQuestion({ id, examCode: "SYNTHETIC", prompt: "Choose an answer.", choices: [{ label: "A", text: "One" }, { label: "B", text: "Two" }], correctAnswers: ["A"], capturedAt: at, ...overrides });
}
function card(q: CapturedQuestion, overrides = {}): StudyCard {
  return { ...generateCards(q)[0], masteryRating: null, ratingUpdatedAt: null, updatedAt: at, notes: "", feedbackFlags: [], ...overrides } as StudyCard;
}
const settings: StudySettings = { masterySetSize: 20, shuffleChoices: false, masteryPool: "all-not-easy", easyReviewScope: "all", easyReviewSize: 20, reviewIncludesGotIt: false, masteryCardIds: [], cardGroups: {}, speakQuestions: false, speechRate: 1, speechVolume: 1 };

describe("duplicate-safe library view", () => {
  it("consolidates old IDs, merges notes/flags, retains latest mastery, and does not mutate sources", () => {
    const a = question("a"), b = question("b", { number: "99", sourceUrl: "other", topic: "Other topic" });
    const first = card(a, { notes: "first note", feedbackFlags: ["unclear"] });
    const second = card(b, { notes: "second note", feedbackFlags: ["wrong-answer"], masteryRating: MasteryRating.GotIt, ratingUpdatedAt: "2026-09-02T00:00:00.000Z" });
    const before = JSON.stringify([a, b, first, second]);
    const view = consolidateLibrary([b, a], [second, first]);
    expect(view.questions).toHaveLength(1);
    expect(view.cards).toHaveLength(1);
    expect(view.cards[0]).toMatchObject({ id: first.id, masteryRating: MasteryRating.GotIt, feedbackFlags: ["unclear", "wrong-answer"] });
    expect(view.cards[0].notes).toContain("first note");
    expect(view.cards[0].notes).toContain("second note");
    expect(JSON.stringify([a, b, first, second])).toBe(before);
    expect(consolidateLibrary([a, b], [view.cards[0], second]).cards[0].notes).toBe(view.cards[0].notes);
    expect(consolidateLibrary([a, b], [card(a, { updatedAt: "2026-09-03T00:00:00.000Z" }), second]).cards[0].masteryRating).toBeNull();
  });

  it("preserves answer variants and uncertain legacy card content", () => {
    const questions = [question("a"), question("b", { correctAnswers: ["B"] }), question("c", { choices: [{ label: "A", text: "Changed" }, { label: "B", text: "Two" }] })];
    const cards = questions.map((q) => card(q));
    expect(consolidateLibrary(questions, cards).cards).toHaveLength(3);
    expect(consolidateLibrary([questions[0]], [cards[0], { ...cards[0], id: "edited", back: "Changed answer" }]).cards).toHaveLength(2);
    for (const change of [
      { explanation: "Different explanation" },
      { answerImages: [{ src: "different.png", alt: "", role: "answer" as const }] },
      { confidence: "missing-answer" as const },
    ]) {
      expect(consolidateLibrary([questions[0]], [cards[0], { ...cards[0], id: "modified", ...change }]).cards).toHaveLength(2);
    }
    expect(consolidateLibrary([], []).cards).toEqual([]);
    expect(consolidateLibrary([], cards).cards).toHaveLength(3);
    expect(consolidateLibrary([{ id: "broken" } as CapturedQuestion], [card(question("broken"))]).cards).toHaveLength(1);
  });

  it("remaps saved groups and sessions, retaining attempts/history without duplicate queue entries", () => {
    const a = question("a"), b = question("b");
    const original = [card(a), card(b)];
    const view = consolidateLibrary([a, b], original);
    const oldSettings = { ...settings, masteryCardIds: original.map((c) => c.id), cardGroups: { saved: [original[1].id] } };
    const oldSession = createStudySession(original, oldSettings, "mastery", () => 0.5);
    const mappedSettings = remapSettings(oldSettings, view.aliases);
    const mappedSession = remapSession(oldSession, view.aliases)!;
    expect(mappedSettings.masteryCardIds).toEqual([original[0].id]);
    expect(mappedSettings.cardGroups.saved).toEqual([original[0].id]);
    expect(mappedSession.queue).toEqual([original[0].id]);
    expect(mappedSession.total).toBe(1);
    const finished = { cardId: original[0].id, selectedAnswers: ["A"], correctAnswers: ["A"], correct: true, rating: MasteryRating.GotIt, answeredAt: at, elapsedSeconds: 2 };
    const partlyFinished = remapSession({ ...oldSession, queue: [original[1].id], results: [finished], attempts: 1, completed: 1 }, view.aliases)!;
    expect(partlyFinished.queue).toEqual([]);
    expect(partlyFinished.completed).toBe(1);
    expect(remapSession(mappedSession, view.aliases)).toBe(mappedSession);
    expect(createStudySession(view.cards, mappedSettings, "mastery").queue).toHaveLength(1);
    const result = { cardId: original[1].id, selectedAnswers: ["A"], correctAnswers: ["A"], correct: true, rating: MasteryRating.Again, answeredAt: at, elapsedSeconds: 2 };
    const history = remapSession({ ...oldSession, results: [result, result], attempts: 2 }, view.aliases)!;
    expect(history.results).toHaveLength(2);
    expect(history.attempts).toBe(2);
    expect(history.results.every((r) => r.cardId === original[0].id)).toBe(true);
  });

  it("covers persisted libraries, repeated imports, backup round trips, and remote duplicate pulls", async () => {
    const a = question("persist-a"), b = question("persist-b");
    const originals = [card(a, { notes: "alpha", masteryRating: MasteryRating.Again, ratingUpdatedAt: at }), card(b, { notes: "beta", masteryRating: MasteryRating.KeepFresh, ratingUpdatedAt: "2026-09-02T00:00:00.000Z" })];
    const reviews = originals.map((c, i) => ({ id: "dedup-review-" + i, cardId: c.id, rating: MasteryRating.Again, reviewedAt: at }));
    await restoreLibrary([a, b], originals, reviews);
    let view = consolidateLibrary(await listQuestions(), await listCards());
    expect(view.cards).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      const prepared = prepareBatchImport([makeCaptureBundle([{ ...a, id: "different-source" }, b])], view.cards, new Date("2026-09-03T00:00:00Z"), await listQuestions());
      expect(prepared.added).toBe(0);
      expect(prepared.cards[0].id).toBe(originals[0].id);
      await saveImport(prepared.questions, prepared.cards);
      view = consolidateLibrary(await listQuestions(), await listCards());
      expect(view.cards).toHaveLength(1);
      expect(view.cards[0].masteryRating).toBe(MasteryRating.KeepFresh);
    }
    const backup = await exportLibrary();
    expect(backup.cards).toHaveLength(2); // backing IDs deliberately retained
    expect(backup.reviews).toEqual(reviews);
    expect(backup.cards.map((c) => c.id)).toEqual(originals.map((c) => c.id));
    const restored = prepareLibraryRestore(backup);
    expect(consolidateLibrary(restored.questions, restored.cards).cards).toHaveLength(1);
    const remote = question("persist-remote");
    await applyRemoteLibrary([remote], [card(remote)], []);
    view = consolidateLibrary(await listQuestions(), await listCards());
    expect(view.cards).toHaveLength(1);
    const updated = { ...view.cards[0], masteryRating: MasteryRating.GotIt, ratingUpdatedAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" };
    await saveReview(updated, { id: "new-review", cardId: updated.id, rating: MasteryRating.GotIt, reviewedAt: updated.updatedAt });
    expect(consolidateLibrary(await listQuestions(), await listCards()).cards[0].masteryRating).toBe(MasteryRating.GotIt);
    await resetMasteryRatings([updated.id], new Date("2026-09-05T00:00:00Z"));
    expect(consolidateLibrary(await listQuestions(), await listCards()).cards[0].masteryRating).toBeNull();
    expect((await exportLibrary()).reviews).toHaveLength(3);
  });
});
