import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { generateCards, sanitizeQuestion, questionContentKey } from "@crambot/core";
import { areLibraryDuplicates, libraryDuplicateGroups } from "./library-duplicates";
import { consolidateLibrary } from "./deduplication";
import { listCards, listQuestions, removeCards, restoreLibrary } from "./db";
import { createStudySession, type StudySettings } from "./study-session";
import type { CapturedQuestion, StudyCard } from "./types";

function question(id: string, overrides = {}): CapturedQuestion {
  return sanitizeQuestion({ id, examCode: "SYNTHETIC", prompt: "Choose an answer.", choices: [{ label: "A", text: "One" }, { label: "B", text: "Two" }], correctAnswers: ["A"], capturedAt: "2026-09-01", ...overrides });
}
function card(q: CapturedQuestion): StudyCard {
  return { ...generateCards(q)[0], masteryRating: null, ratingUpdatedAt: null, updatedAt: "2026-09-01" } as StudyCard;
}
function groups(questions: CapturedQuestion[]) {
  return libraryDuplicateGroups(questions.map(card), new Map(questions.map((q) => [q.id, q])));
}
const image = { src: "one.png", role: "question", alt: "Diagram" };

describe("manual library duplicate predicate", () => {
  it("returns all and only members of groups of two or more, including separate groups", () => {
    const qs = [question("a"), question("b"), question("single", { prompt: "Unique" }), question("c", { prompt: "Other" }), question("d", { prompt: "Other" }), question("e", { prompt: "Other" })];
    const index = groups(qs);
    expect([...index.keys()].sort()).toEqual(qs.filter((q) => q.id !== "single").map((q) => card(q).id).sort());
    expect(index.get(card(qs[0]).id)?.size).toBe(2);
    expect(index.get(card(qs[3]).id)?.size).toBe(3);
    expect(groups([]).size).toBe(0);
    expect(groups([qs[0], qs[2], qs[3]]).size).toBe(0);
    expect(libraryDuplicateGroups([card(qs[0])], new Map()).size).toBe(0);
    expect(libraryDuplicateGroups([card(qs[0])], new Map([[qs[0].id, { id: qs[0].id } as CapturedQuestion]])).size).toBe(0);
  });

  it.each([
    { prompt: "Different question" },
    { choices: [{ label: "A", text: "Changed" }, { label: "B", text: "Two" }] },
    { correctAnswers: ["B"] },
    { images: [image] },
  ])("excludes differences in a defining field: %j", (change) => {
    expect(areLibraryDuplicates(question("a"), question("b", change))).toBe(false);
    expect(groups([question("a"), question("b", change)]).size).toBe(0);
  });

  it("ignores explanation, discussion, source, community votes and rating history independently of automatic identity", () => {
    const a = question("a");
    for (const change of [
      { explanation: "Another explanation" },
      { discussion: { title: "Discussion", comments: [{ id: "comment", content: "Different reasoning" }] } },
      { sourceUrl: "another-source", examCode: "OTHER", topic: "Other", mostVotedAnswers: ["B"] },
    ]) {
      const b = question("b", change);
      expect(areLibraryDuplicates(a, b)).toBe(true);
      expect(questionContentKey(a)).not.toBe(questionContentKey(b));
      expect(consolidateLibrary([a, b], [card(a), card(b)]).cards).toHaveLength(2);
      expect(groups([a, b]).size).toBe(2);
    }
    const b = question("b", { explanation: "Other" });
    expect(libraryDuplicateGroups([card(a), { ...card(b), masteryRating: 5, notes: "keep my notes" }], new Map([[a.id, a], [b.id, b]])).size).toBe(2);
  });

  it("matches existing whitespace rules without folding quotes, case or Unicode", () => {
    expect(areLibraryDuplicates(question("a"), question("b", { prompt: "  Choose\u00a0 an\tanswer. " }))).toBe(true);
    expect(areLibraryDuplicates(question("a", { prompt: "Say ‘yes’" }), question("b", { prompt: "Say 'yes'" }))).toBe(false);
    expect(areLibraryDuplicates(question("a", { correctAnswers: ["A", "B"] }), question("b", { correctAnswers: ["B", "A"] }))).toBe(true);
  });

  it("compares exact embedded data or stored URLs, preserving roles and order", () => {
    const a = question("a", { images: [image] });
    expect(groups([a, question("b", { images: [{ ...image, alt: "Other description" }] })]).size).toBe(2);
    for (const images of [[{ ...image, src: "two.png" }], [{ ...image, role: "answer" }], [image, image]]) {
      expect(groups([a, question("b", { images })]).size).toBe(0);
    }
    const embedded = { ...image, dataUrl: "data:image/png;base64,AAAA" };
    const q = question("embedded", { images: [embedded] });
    expect(groups([q, question("same", { images: [{ ...embedded, src: "mirror.png" }] })]).size).toBe(2);
    expect(groups([q, a]).size).toBe(0);
    expect(groups([q, question("different", { images: [{ ...embedded, dataUrl: "data:image/png;base64,BBBB" }] })]).size).toBe(0);
    expect(areLibraryDuplicates(question("x", { images: [image, embedded] }), question("y", { images: [embedded, image] }))).toBe(false);
  });

  it("deletes a selected filtered copy through existing storage deletion and keeps the survivor in study", async () => {
    const a = question("keep"), b = question("delete", { explanation: "Different explanation" });
    const originals = [card(a), card(b)];
    await restoreLibrary([a, b], originals, []);
    const view = consolidateLibrary(await listQuestions(), await listCards());
    const index = libraryDuplicateGroups(view.cards, new Map(view.questions.map((q) => [q.id, q])));
    const filtered = view.cards.filter((c) => index.has(c.id));
    expect(filtered).toHaveLength(2);
    const selectedIds = new Set([originals[1].id]);
    // Same alias expansion and existing removeCards path used by handleRemove.
    await removeCards(originals.filter((c) => selectedIds.has(view.aliases.get(c.id) ?? c.id)));
    const remaining = consolidateLibrary(await listQuestions(), await listCards());
    expect(remaining.cards.map((c) => c.id)).toEqual([originals[0].id]);
    expect(groups(remaining.questions).size).toBe(0);
    const settings: StudySettings = { masterySetSize: 20, shuffleChoices: false, masteryPool: "all-not-easy", easyReviewScope: "all", easyReviewSize: 20, reviewIncludesGotIt: false, masteryCardIds: [originals[0].id], cardGroups: {}, speakQuestions: false, speechRate: 1, speechVolume: 1 };
    expect(createStudySession(remaining.cards, settings, "mastery").queue).toEqual([originals[0].id]);
  });
});
