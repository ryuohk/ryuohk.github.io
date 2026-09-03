import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildQuestionSpeech,
  cancelSpeech,
  chunkForSpeech,
  clampRate,
  clampVolume,
  isPaused,
  isSpeaking,
  pauseSpeech,
  resolveSpeechOptions,
  resumeSpeech,
  speakText,
} from "./speech";

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

describe("live settings", () => {
  // Each chunk reads the settings again, so moving a slider applies to the next
  // sentence instead of cancelling and restarting the question.
  it("reads a getter every time rather than capturing once", () => {
    let rate = 1;
    const source = () => ({ rate });
    expect(resolveSpeechOptions(source).rate).toBe(1);
    rate = 1.8;
    expect(resolveSpeechOptions(source).rate).toBe(1.8);
  });

  it("still accepts a plain options object", () => {
    expect(resolveSpeechOptions({ rate: 1.4, volume: 0.5 })).toEqual({ rate: 1.4, volume: 0.5 });
  });

  it("falls back to defaults rather than going silent if the getter throws", () => {
    expect(resolveSpeechOptions(() => {
      throw new Error("state read failed");
    })).toEqual({});
    expect(resolveSpeechOptions(undefined)).toEqual({});
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

/**
 * Pause and resume against a fake engine.
 *
 * Real speech synthesis has no way to ask where it got to, so the module tracks the
 * sentence in flight itself. These tests drive that bookkeeping by completing
 * utterances by hand: nothing finishes until `finishCurrent` says so.
 */
describe("pause and resume", () => {
  class FakeUtterance {
    text: string;
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: unknown = null;
    lang = "";
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }

  const spoken: FakeUtterance[] = [];
  let queue: FakeUtterance[] = [];
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalUtterance = (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;

  function finishCurrent() {
    queue.shift()?.onend?.();
  }

  // Long enough that it has to be split, which is the only case pausing matters in.
  const sentence = (label: string) =>
    `${label} sentence in a question long enough that a browser would otherwise truncate it partway through.`;
  const question = [sentence("First"), sentence("Second"), sentence("Third"), sentence("Fourth")].join(" ");

  beforeEach(() => {
    spoken.length = 0;
    queue = [];
    (globalThis as Record<string, unknown>).window = {
      speechSynthesis: {
        speak(utterance: FakeUtterance) {
          spoken.push(utterance);
          queue.push(utterance);
        },
        cancel() {
          queue = [];
        },
        resume() {},
        pause() {},
        getVoices: () => [],
        addEventListener() {},
        removeEventListener() {},
      },
    };
    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = FakeUtterance;
  });

  afterEach(() => {
    cancelSpeech();
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = originalUtterance;
  });

  it("stops speaking and reports that it is paused", () => {
    speakText(question);
    expect(isSpeaking()).toBe(true);

    expect(pauseSpeech()).toBe(true);
    expect(isPaused()).toBe(true);
    expect(isSpeaking()).toBe(false);
  });

  it("picks up at the sentence that was interrupted", () => {
    speakText(question);
    finishCurrent();
    const interrupted = spoken[1].text;

    pauseSpeech();
    const countAtPause = spoken.length;
    expect(resumeSpeech()).toBe(true);
    expect(spoken[countAtPause].text).toBe(interrupted);
    expect(isPaused()).toBe(false);
  });

  it("ignores an end event that arrives after the pause", () => {
    speakText(question);
    pauseSpeech();
    const countAtPause = spoken.length;
    finishCurrent();

    expect(spoken).toHaveLength(countAtPause);
  });

  it("still reaches the end of the question after a pause", () => {
    speakText(question);
    pauseSpeech();
    resumeSpeech();
    for (let guard = 0; isSpeaking() && guard < 50; guard += 1) finishCurrent();

    const heard = spoken.map((utterance) => utterance.text);
    for (const chunk of chunkForSpeech(question)) expect(heard).toContain(chunk);
    expect(isSpeaking()).toBe(false);
  });

  it("discards the paused run on a cancel, so a new question wins", () => {
    speakText(question);
    pauseSpeech();
    cancelSpeech();

    expect(isPaused()).toBe(false);
    expect(resumeSpeech()).toBe(false);
  });

  it("reports failure rather than guessing when there is nothing to act on", () => {
    expect(pauseSpeech()).toBe(false);
    expect(resumeSpeech()).toBe(false);
  });
});
