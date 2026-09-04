import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { applyRemoteLibrary, clearPending, listPending, saveImport, saveReview } from "./db";
import { chunkBySize, describeSyncError, joinCard, resolvePendingIntents, splitCard, type ProgressRow } from "./sync";
import type { PendingEntry, PendingKind } from "./db";
import { MasteryRating, type CapturedQuestion, type ReviewLog, type StudyCard } from "./types";

function question(id: string): CapturedQuestion {
  return {
    id,
    examCode: "EXAM-101",
    sourceUrl: `https://example.test/${id}`,
    topic: "Test",
    number: "1",
    prompt: "Test question",
    choices: [{ label: "A", text: "One" }],
    correctAnswers: ["A"],
    mostVotedAnswers: [],
    voteDistribution: [],
    explanation: "",
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
    front: "Test question",
    back: "A",
    explanation: "",
    questionImages: [],
    answerImages: [],
    tags: ["EXAM-101"],
    confidence: "source-answer",
    sourceUrl: `https://example.test/${questionId}`,
    createdAt: "2026-08-28T12:00:00.000Z",
    masteryRating: MasteryRating.KeepFresh,
    ratingUpdatedAt: "2026-08-28T12:00:00.000Z",
    updatedAt: "2026-08-28T12:00:00.000Z",
    notes: "my private mnemonic",
    feedbackFlags: ["unclear"],
  };
}

describe("shared and private split", () => {
  it("keeps mastery progress, notes, and flags out of shared card content", () => {
    const { content, progress } = splitCard(card("card-1", "question-1"));

    expect(content).not.toHaveProperty("masteryRating");
    expect(content).not.toHaveProperty("ratingUpdatedAt");
    expect(content).not.toHaveProperty("notes");
    expect(content).not.toHaveProperty("feedbackFlags");
    expect(content).not.toHaveProperty("updatedAt");
    expect(content.front).toBe("Test question");
    expect(progress).toEqual({
      card_id: "card-1",
      mastery_rating: MasteryRating.KeepFresh,
      rating_updated_at: "2026-08-28T12:00:00.000Z",
      notes: "my private mnemonic",
      feedback_flags: ["unclear"],
    });
  });

  it("rebuilds the original card from shared content plus private progress", () => {
    const original = card("card-1", "question-1");
    const { content, progress } = splitCard(original);
    const row: ProgressRow = { ...progress, updated_at: original.updatedAt };
    expect(joinCard(content, row, undefined)).toEqual(original);
  });

  it("gives a card contributed by someone else Unrated private progress", () => {
    const { content } = splitCard(card("card-1", "question-1"));
    const joined = joinCard(content, undefined, undefined);

    expect(joined.masteryRating).toBeNull();
    expect(joined.ratingUpdatedAt).toBeNull();
    expect(joined.notes).toBeUndefined();
    expect(joined.feedbackFlags).toBeUndefined();
  });

  it("allows an incoming explicit reset to overwrite a local Easy label", () => {
    const local = card("card-1", "question-1");
    const reset: ProgressRow = {
      card_id: "card-1",
      mastery_rating: null,
      rating_updated_at: null,
      notes: null,
      feedback_flags: null,
      updated_at: "2026-08-29T12:00:00.000Z",
    };

    const joined = joinCard(local, reset, local);
    expect(joined.masteryRating).toBeNull();
    expect(joined.ratingUpdatedAt).toBeNull();
    expect(joined.notes).toBeUndefined();
    expect(joined.feedbackFlags).toBeUndefined();
    expect(joined.updatedAt).toBe("2026-08-29T12:00:00.000Z");
  });

  it("prefers incoming ratings over progress already stored on the device", () => {
    const local = card("card-1", "question-1");
    const { content } = splitCard(local);
    const incoming: ProgressRow = {
      card_id: "card-1",
      mastery_rating: MasteryRating.Hard,
      rating_updated_at: "2026-08-29T12:00:00.000Z",
      notes: null,
      feedback_flags: null,
      updated_at: "2026-08-29T12:00:00.000Z",
    };

    const joined = joinCard(content, incoming, local);
    expect(joined.masteryRating).toBe(MasteryRating.Hard);
    expect(joined.ratingUpdatedAt).toBe("2026-08-29T12:00:00.000Z");
  });
});

describe("contradictory queue entries", () => {
  const entry = (kind: PendingKind, entityId: string, queuedAt: string): PendingEntry =>
    ({ key: `${kind}:${entityId}`, kind, entityId, queuedAt });

  it("keeps a card that was re-imported after it was deleted", () => {
    // Clear the library, then re-import the same capture. Deletions push last, so
    // without this the upload would tombstone the cards it had just sent.
    const resolved = resolvePendingIntents([
      entry("card-deleted", "c1", "2026-08-30T10:00:00.000Z"),
      entry("card", "c1", "2026-08-30T11:00:00.000Z"),
      entry("progress", "c1", "2026-08-30T11:00:00.000Z"),
    ]);

    expect(resolved.deletedCardIds).toEqual([]);
    expect([...resolved.cardIds]).toEqual(["c1"]);
    expect([...resolved.progressIds]).toEqual(["c1"]);
    expect(resolved.superseded).toEqual(["card-deleted:c1"]);
  });

  it("honours a deletion that came after the import", () => {
    const resolved = resolvePendingIntents([
      entry("card", "c1", "2026-08-30T10:00:00.000Z"),
      entry("progress", "c1", "2026-08-30T10:00:00.000Z"),
      entry("card-deleted", "c1", "2026-08-30T11:00:00.000Z"),
    ]);

    expect(resolved.deletedCardIds).toEqual(["c1"]);
    expect([...resolved.cardIds]).toEqual([]);
    expect([...resolved.progressIds]).toEqual([]);
    expect(resolved.superseded).toEqual(["card:c1", "progress:c1"]);
  });

  it("applies the same rule to questions", () => {
    const resolved = resolvePendingIntents([
      entry("question-deleted", "q1", "2026-08-30T10:00:00.000Z"),
      entry("question", "q1", "2026-08-30T11:00:00.000Z"),
    ]);

    expect(resolved.deletedQuestionIds).toEqual([]);
    expect([...resolved.questionIds]).toEqual(["q1"]);
  });

  it("leaves uncontested entries alone", () => {
    const resolved = resolvePendingIntents([
      entry("card", "c1", "2026-08-30T10:00:00.000Z"),
      entry("card-deleted", "c2", "2026-08-30T10:00:00.000Z"),
      entry("review", "r1", "2026-08-30T10:00:00.000Z"),
    ]);

    expect([...resolved.cardIds]).toEqual(["c1"]);
    expect(resolved.deletedCardIds).toEqual(["c2"]);
    expect([...resolved.reviewIds]).toEqual(["r1"]);
    expect(resolved.superseded).toEqual([]);
  });

  it("resolves each id independently across a mixed queue", () => {
    const resolved = resolvePendingIntents([
      entry("card-deleted", "keep", "2026-08-30T10:00:00.000Z"),
      entry("card", "keep", "2026-08-30T11:00:00.000Z"),
      entry("card", "drop", "2026-08-30T10:00:00.000Z"),
      entry("card-deleted", "drop", "2026-08-30T11:00:00.000Z"),
    ]);

    expect([...resolved.cardIds]).toEqual(["keep"]);
    expect(resolved.deletedCardIds).toEqual(["drop"]);
  });
});

describe("upload batching", () => {
  it("splits on the byte budget before the row limit", () => {
    const heavy = Array.from({ length: 6 }, (_, index) => ({ id: index, blob: "x".repeat(900) }));
    const pages = chunkBySize(heavy, 25, 2_000);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flat()).toHaveLength(6);
    for (const page of pages) expect(JSON.stringify(page).length).toBeLessThan(3_000);
  });

  it("still honours the row limit when rows are small", () => {
    const light = Array.from({ length: 7 }, (_, index) => ({ id: index }));
    expect(chunkBySize(light, 3, 10_000_000).map((page) => page.length)).toEqual([3, 3, 1]);
  });

  it("sends a single oversized row on its own rather than dropping it", () => {
    const pages = chunkBySize([{ blob: "x".repeat(5_000) }], 25, 1_000);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toHaveLength(1);
  });
});

describe("pending change queue", () => {
  it("queues shared and private work for every imported card", async () => {
    await clearPending((await listPending()).map((entry) => entry.key));
    await saveImport([question("q-1")], [card("c-1", "q-1")]);

    const keys = (await listPending()).map((entry) => entry.key).sort();
    expect(keys).toEqual(["card:c-1", "progress:c-1", "question:q-1"]);
  });

  it("queues progress and the review, but not shared content, when a card is rated", async () => {
    await clearPending((await listPending()).map((entry) => entry.key));
    const rated = card("c-2", "q-1");
    const review: ReviewLog = {
      id: "r-1",
      cardId: "c-2",
      rating: MasteryRating.Good,
      reviewedAt: "2026-08-28T13:00:00.000Z",
    };
    await saveReview(rated, review);

    const keys = (await listPending()).map((entry) => entry.key).sort();
    expect(keys).toEqual(["progress:c-2", "review:r-1"]);
  });

  it("does not re-queue rows that were just pulled from the cloud", async () => {
    await clearPending((await listPending()).map((entry) => entry.key));
    await applyRemoteLibrary([question("q-9")], [card("c-9", "q-9")], []);
    expect(await listPending()).toEqual([]);
  });
});

describe("describeSyncError", () => {
  it("keeps every detail a Supabase rejection carries", () => {
    expect(describeSyncError({
      message: "value too long for type character varying",
      details: "Row 3 of the payload",
      hint: "Shorten the value",
      code: "22001",
    })).toBe("value too long for type character varying · Row 3 of the payload · Shorten the value (22001)");
  });

  it("reports a code-only rejection rather than rendering an object", () => {
    expect(describeSyncError({ code: "PGRST301" })).toBe("The sync service rejected the request with code PGRST301.");
  });

  it("never returns the useless [object Object] rendering", () => {
    expect(describeSyncError({})).toBe("The sync service returned an error with no message.");
    expect(describeSyncError(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });
});
