import { describe, expect, it } from "vitest";
import { buildQuestionSpeech, chunkForSpeech, clampRate, clampVolume } from "./speech";

// Chrome truncates a single utterance at roughly 200 characters with no error, so
// every chunk staying under the limit is the whole point of this module.
const LIMIT = 180;

describe("chunkForSpeech", () => {
  it("returns nothing for empty or whitespace text", () => {
    expect(chunkForSpeech("")).toEqual([]);
    expect(chunkForSpeech("   \n  ")).toEqual([]);
  });

  it("keeps a short question as one utterance", () => {
    expect(chunkForSpeech("Which service should you recommend?")).toEqual(["Which service should you recommend?"]);
  });

  it("never exceeds the limit on a realistically long question", () => {
    const sentence = "You need to design a solution that meets the technical requirements for the contoso environment. ";
    const chunks = chunkForSpeech(sentence.repeat(12));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
  });

  it("breaks at sentence boundaries rather than mid-word", () => {
    const chunks = chunkForSpeech(`${"a".repeat(120)}. ${"b".repeat(120)}.`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${"a".repeat(120)}.`);
  });

  it("falls back to clause punctuation when a sentence is too long", () => {
    const clause = "the solution must minimize cost, ";
    const chunks = chunkForSpeech(`${clause.repeat(10)}and remain highly available.`);

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("splits on whitespace when a run has no punctuation at all", () => {
    const chunks = chunkForSpeech(Array.from({ length: 80 }, (_, index) => `word${index}`).join(" "));

    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
    // Nothing is dropped on the way through.
    expect(chunks.join(" ").split(/\s+/)).toHaveLength(80);
  });

  it("loses no words when splitting", () => {
    const text = "First sentence here. Second sentence follows. Third one closes it out.";
    expect(chunkForSpeech(text).join(" ")).toBe(text);
  });

  it("treats line breaks as boundaries, which captured prompts are full of", () => {
    const chunks = chunkForSpeech("Overview\nContoso operates two datacenters\nRequirements follow");
    expect(chunks.join(" ")).not.toContain("\n");
  });

  it("splits a single unbroken word longer than the limit", () => {
    const chunks = chunkForSpeech("x".repeat(400));
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("buildQuestionSpeech", () => {
  it("reads the prompt and then the choices", () => {
    const spoken = buildQuestionSpeech("Which service?", ["A. Private endpoint", "B. Public endpoint"]);
    expect(spoken).toContain("Which service?");
    expect(spoken).toContain("Choices.");
    expect(spoken.indexOf("Which service?")).toBeLessThan(spoken.indexOf("Choices."));
  });

  it("announces diagrams rather than leaving silence", () => {
    expect(buildQuestionSpeech("See the exhibit.", [], 1)).toContain("includes a diagram");
    expect(buildQuestionSpeech("See the exhibits.", [], 3)).toContain("includes 3 diagrams");
  });

  it("says nothing about diagrams when there are none", () => {
    expect(buildQuestionSpeech("Plain question.", ["A. One"])).not.toContain("diagram");
  });

  it("omits the choices section when a question has none", () => {
    expect(buildQuestionSpeech("Open question.", [])).not.toContain("Choices.");
  });

  it("survives empty and malformed input", () => {
    expect(buildQuestionSpeech("", [])).toBe("");
    expect(buildQuestionSpeech("Prompt.", ["", "   "])).not.toContain("Choices.");
  });
});

describe("rate and volume limits", () => {
  // An utterance with an out-of-range value is rejected by some engines, which
  // presents as silence rather than an error, so clamping is load-bearing.
  it("keeps volume within the range engines accept", () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(1)).toBe(1);
    expect(clampVolume(4)).toBe(1);
    expect(clampVolume(-2)).toBe(0);
  });

  it("falls back to the default for a missing or unusable volume", () => {
    expect(clampVolume(undefined)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
  });

  it("keeps rate within a range that stays intelligible", () => {
    expect(clampRate(1.5)).toBe(1.5);
    expect(clampRate(20)).toBe(2);
    expect(clampRate(0.01)).toBe(0.5);
    expect(clampRate(undefined)).toBe(1.1);
  });
});
