import { beforeEach, describe, expect, it } from "vitest";
// vitest runs these in node, which has no localStorage. The module under test only
// needs get/set/remove/clear, so a Map-backed stand-in is enough and keeps the
// suite free of a jsdom dependency.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

import {
  EXAM_FILTER_KEY,
  SESSION_KEY,
  SETTINGS_KEY,
  lastServerStudyStateAt,
  markStudyStateSynced,
  readLocalStudyState,
  stableStringify,
  studyStateChanged,
  writeLocalStudyState,
  clearStudyStateMarkers,
} from "./study-state";

beforeEach(() => localStorage.clear());

describe("stableStringify", () => {
  it("ignores key order, which jsonb does not preserve", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    const left = { session: { queue: ["a", "b"], id: "s1", answers: { z: ["A"], y: [] } } };
    const right = { session: { answers: { y: [], z: ["A"] }, id: "s1", queue: ["a", "b"] } };
    expect(stableStringify(left)).toBe(stableStringify(right));
  });

  it("keeps array order, which is meaningful for the queue", () => {
    expect(stableStringify(["a", "b"])).not.toBe(stableStringify(["b", "a"]));
  });

  it("still separates genuinely different state", () => {
    expect(stableStringify({ completed: 1 })).not.toBe(stableStringify({ completed: 2 }));
  });
});

describe("echo suppression", () => {
  // pullChanges uses this same comparison to decide whether a row it just re-read
  // is genuinely new. Getting it wrong made every sync look like a remote change,
  // which reset the revealed answer under whoever was mid-question.
  const card = (masteryRating: number | null, notes?: string) => ({
    id: "c1",
    questionId: "q1",
    front: "Prompt",
    back: "A",
    tags: ["EXAM-101"],
    masteryRating,
    ratingUpdatedAt: masteryRating ? "2026-08-30T10:00:00.000Z" : null,
    updatedAt: "2026-08-30T10:00:00.000Z",
    ...(notes ? { notes } : {}),
  });

  it("treats a row round-tripped through the server as unchanged", () => {
    const local = card(3);
    const pulledBack = { ...card(3) };
    expect(stableStringify(local)).toBe(stableStringify(pulledBack));
  });

  it("still detects a rating changed on another device", () => {
    expect(stableStringify(card(3))).not.toBe(stableStringify(card(4)));
  });

  it("still detects a note added on another device", () => {
    expect(stableStringify(card(3))).not.toBe(stableStringify(card(3, "remember the VNet")));
  });

  it("treats an absent optional field and an undefined one as the same", () => {
    expect(stableStringify({ id: "c1", notes: undefined })).toBe(stableStringify({ id: "c1" }));
  });
});

describe("change detection", () => {
  it("treats untouched local state as unchanged after a sync", () => {
    const payload = { session: { id: "s1", queue: ["a"] }, settings: { masterySetSize: 20 }, examFilter: null };
    writeLocalStudyState(payload);
    markStudyStateSynced(readLocalStudyState(), "2026-08-30T10:00:00.000Z");

    expect(studyStateChanged()).toBe(false);
    expect(lastServerStudyStateAt()).toBe("2026-08-30T10:00:00.000Z");
  });

  it("does not report a change when the server returns the same state reordered", () => {
    writeLocalStudyState({ session: { id: "s1", queue: ["a"] }, settings: { masterySetSize: 20 }, examFilter: null });
    // Same content, keys in the order Postgres happened to hand back.
    markStudyStateSynced(
      { settings: { masterySetSize: 20 }, session: { queue: ["a"], id: "s1" }, examFilter: null },
      "2026-08-30T10:00:00.000Z",
    );

    // Without stable comparison this is the loop where two devices push forever.
    expect(studyStateChanged()).toBe(false);
  });

  it("reports a change once the set advances", () => {
    writeLocalStudyState({ session: { id: "s1", queue: ["a", "b"] }, settings: null, examFilter: null });
    markStudyStateSynced(readLocalStudyState(), "2026-08-30T10:00:00.000Z");

    writeLocalStudyState({ session: { id: "s1", queue: ["b"] }, settings: null, examFilter: null });
    expect(studyStateChanged()).toBe(true);
  });

  it("reports a change when a set is ended", () => {
    writeLocalStudyState({ session: { id: "s1", queue: ["a"] }, settings: null, examFilter: null });
    markStudyStateSynced(readLocalStudyState(), "2026-08-30T10:00:00.000Z");

    writeLocalStudyState({ session: null, settings: null, examFilter: null });
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(studyStateChanged()).toBe(true);
  });

  it("treats a fresh device as having nothing the server has seen", () => {
    writeLocalStudyState({ session: { id: "s1" }, settings: { masterySetSize: 20 }, examFilter: null });
    expect(studyStateChanged()).toBe(true);
    expect(lastServerStudyStateAt()).toBe("1970-01-01T00:00:00.000Z");
  });

  it("forgets the previous person's markers on sign out", () => {
    writeLocalStudyState({ session: { id: "s1" }, settings: null, examFilter: null });
    markStudyStateSynced(readLocalStudyState(), "2026-08-30T10:00:00.000Z");
    clearStudyStateMarkers();

    expect(lastServerStudyStateAt()).toBe("1970-01-01T00:00:00.000Z");
    expect(studyStateChanged()).toBe(true);
  });

  it("carries the selected exam and reports a change when it switches", () => {
    writeLocalStudyState({ session: null, settings: null, examFilter: "AZ-305" });
    markStudyStateSynced(readLocalStudyState(), "2026-08-30T10:00:00.000Z");
    expect(localStorage.getItem(EXAM_FILTER_KEY)).toBe("AZ-305");
    expect(readLocalStudyState().examFilter).toBe("AZ-305");
    expect(studyStateChanged()).toBe(false);

    writeLocalStudyState({ session: null, settings: null, examFilter: "DP-203" });
    expect(studyStateChanged()).toBe(true);
  });

  it("clears the stored exam when the incoming state has none", () => {
    writeLocalStudyState({ session: null, settings: null, examFilter: "AZ-305" });
    writeLocalStudyState({ session: null, settings: null, examFilter: null });
    expect(localStorage.getItem(EXAM_FILTER_KEY)).toBeNull();
  });

  it("round-trips settings through storage", () => {
    writeLocalStudyState({ session: null, settings: { masterySetSize: 40, masteryPool: "again-hard" }, examFilter: null });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null")).toEqual({
      masterySetSize: 40,
      masteryPool: "again-hard",
    });
    expect(readLocalStudyState().session).toBeNull();
  });
});
