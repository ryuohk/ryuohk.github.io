import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySpeechSettings,
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

// Chrome truncates a long utterance with no error, so every chunk staying under the
// limit is the whole point of this module.
const LIMIT = 360;
// Pieces are packed to this; a single sentence may run to LIMIT before it is broken.
const TARGET = 300;

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
    const chunks = chunkForSpeech(`${"a".repeat(220)}. ${"b".repeat(220)}.`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`${"a".repeat(220)}.`);
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

  // Every boundary between pieces is an audible gap, so a question should be cut into
  // as few as the truncation ceiling allows rather than into tidy short lines.
  it("packs short sentences together instead of speaking them separately", () => {
    expect(chunkForSpeech("One short line here. Another short line here. A third short line here.")).toHaveLength(1);
  });

  it("cuts a long question into a handful of pieces, not a dozen", () => {
    const sentence = "The platform must ingest telemetry from twelve thousand devices. ";
    const chunks = chunkForSpeech(sentence.repeat(12));

    // Four of these fit in a piece, so twelve sentences make three, not twelve.
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
  });

  // "A." is a label, not a sentence. Splitting there strands the letter on the end of
  // the previous piece, so you hear the letter and its choice on opposite sides of a gap.
  it("keeps a choice label attached to its choice", () => {
    const chunks = chunkForSpeech(buildQuestionSpeech("Which service?", [
      "A. Azure Data Explorer with a follower database in the secondary region",
      "B. Azure Synapse dedicated SQL pools replicated nightly",
    ]));

    expect(chunks.join(" ")).toContain("A. Azure Data Explorer");
    expect(chunks.join(" ")).toContain("B. Azure Synapse");
    // A piece ending on a bare label puts the letter and its choice either side of a gap.
    for (const chunk of chunks) expect(/(?:^|\s)[A-Z][.]$/.test(chunk)).toBe(false);
  });

  it("still ends a sentence on an ordinary word", () => {
    expect(chunkForSpeech("The design is done. Another sentence follows here.")).toHaveLength(1);
    expect(chunkForSpeech("Overview:\nContoso runs two datacenters.").length).toBeGreaterThan(0);
  });

  // A bullet marks the start of an item, which is the boundary a newline marks, and
  // captured requirement lists are written both ways.
  it("breaks on bullets the way it breaks on lines", () => {
    // Long enough that two items cannot share a piece, so a piece has to start at one.
    const item = (label: string) => `${label} ${"requirement text that runs on for a while ".repeat(7).trim()}`;
    const chunks = chunkForSpeech(`Requirements: • ${item("Alpha")} • ${item("Bravo")}`);

    expect(chunks.some((chunk) => chunk.startsWith("Alpha"))).toBe(true);
    expect(chunks.some((chunk) => chunk.startsWith("Bravo"))).toBe(true);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(LIMIT);
  });

  it("does not read the bullet glyph out", () => {
    const spoken = chunkForSpeech("Requirements:\n• Minimize cost.\n• Survive an outage.").join(" ");

    expect(spoken).not.toContain("•");
    expect(spoken).toContain("Minimize cost.");
    expect(spoken).toContain("Survive an outage.");
  });

  // A dash opening a line is a bullet; the one inside "multi-region" is not.
  it("tells a list dash from a hyphen", () => {
    expect(chunkForSpeech("- Minimize cost.\n- Survive an outage.").join(" ")).not.toMatch(/(?:^|\s)-\s/);
    expect(chunkForSpeech("Deploy a multi-region design.")).toEqual(["Deploy a multi-region design."]);
  });

  // Commas are frequent enough that honouring them cuts a question into far more
  // pieces than its length calls for, and every extra piece is an audible gap.
  it("does not break on a comma while the sentence still fits", () => {
    const text = "Contoso operates two datacenters, one in Seattle and one in Dallas, connected by a private link.";
    expect(chunkForSpeech(text)).toEqual([text]);
  });

  it("keeps a sentence with no clause punctuation whole up to the ceiling", () => {
    // Over the packing target but under the ceiling, and with nowhere good to break.
    const sentence = `${"word ".repeat(65).trim()}.`;
    expect(sentence.length).toBeGreaterThan(TARGET);
    expect(sentence.length).toBeLessThanOrEqual(LIMIT);
    expect(chunkForSpeech(sentence)).toEqual([sentence]);
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

  // Several choices commonly share one utterance, and without a full stop the engine
  // runs the end of one straight into the letter of the next.
  it("closes each choice so the engine pauses between them", () => {
    const spoken = buildQuestionSpeech("Which service?", ["A. Private endpoint", "B. Public endpoint."]);
    expect(spoken).toContain("A. Private endpoint.");
    expect(spoken).not.toContain("endpoint..");
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
 * A stand-in for the browser's speech engine.
 *
 * It models the one thing these tests are about: an engine with a queue. Pieces handed
 * to it wait their turn, the one at the head is playing and is the only one that
 * reports progress, and nothing finishes until a test says so.
 */
class FakeUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: unknown = null;
  lang = "";
  started = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onboundary: ((event: { charIndex: number }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

const spoken: FakeUtterance[] = [];
let queue: FakeUtterance[] = [];

/** Starts whatever has reached the head of the queue, as an engine would. */
function pump() {
  const head = queue[0];
  if (head && !head.started) {
    head.started = true;
    head.onstart?.();
  }
}

function installFakeEngine() {
  spoken.length = 0;
  queue = [];
  (globalThis as Record<string, unknown>).window = {
    speechSynthesis: {
      speak(utterance: FakeUtterance) {
        spoken.push(utterance);
        queue.push(utterance);
        pump();
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
}

const originalWindow = (globalThis as Record<string, unknown>).window;
const originalUtterance = (globalThis as Record<string, unknown>).SpeechSynthesisUtterance;

function restoreEngine() {
  cancelSpeech();
  (globalThis as Record<string, unknown>).window = originalWindow;
  (globalThis as Record<string, unknown>).SpeechSynthesisUtterance = originalUtterance;
}

/** Completes the piece that is playing and lets the next one start. */
function finishCurrent() {
  queue.shift()?.onend?.();
  pump();
}

/** Reports that the playing piece has reached `charIndex`, as a boundary event does. */
function reachChar(charIndex: number) {
  queue[0]?.onboundary?.({ charIndex });
}

const texts = () => spoken.map((utterance) => utterance.text);

// Long enough to be split, which is the only case any of this matters in.
const sentence = (label: string) =>
  `${label} sentence in a question long enough that a browser would otherwise truncate it partway through.`;
// Eight of them, because a piece now holds two: four sentences would be two pieces,
// which is too few for the queue-ahead depth to be visible in what the engine is given.
const question = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"]
  .map(sentence)
  .join(" ");

/**
 * Queueing ahead of the piece that is playing.
 *
 * Asking for the next piece only once the last one has reported finishing puts a
 * JavaScript round trip in the middle of every sentence, which is audible. Handing the
 * engine the next pieces in advance lets it make the transition itself.
 */
describe("queueing ahead", () => {
  beforeEach(installFakeEngine);
  afterEach(restoreEngine);

  it("hands over more than the piece that is playing", () => {
    speakText(question);
    expect(spoken.length).toBeGreaterThan(1);
    expect(texts()).toEqual(chunkForSpeech(question).slice(0, spoken.length));
  });

  it("tops the queue back up as pieces finish", () => {
    speakText(question);
    const queuedUpFront = spoken.length;
    finishCurrent();

    expect(spoken.length).toBe(queuedUpFront + 1);
  });

  it("never hands over more than the question has", () => {
    const short = "One short line.";
    speakText(short);
    expect(texts()).toEqual(chunkForSpeech(short));
  });

  it("plays every piece exactly once, in order", () => {
    speakText(question);
    for (let guard = 0; isSpeaking() && guard < 50; guard += 1) finishCurrent();

    expect(texts()).toEqual(chunkForSpeech(question));
    expect(isSpeaking()).toBe(false);
  });

  it("carries on past a piece the engine fails on", () => {
    speakText(question);
    queue.shift()?.onerror?.();
    pump();
    for (let guard = 0; isSpeaking() && guard < 50; guard += 1) finishCurrent();

    expect(texts()).toEqual(chunkForSpeech(question));
  });
});

/**
 * Pause and resume.
 *
 * Speech synthesis has no way to ask where it got to, so the module tracks the piece
 * being played itself. With pieces queued ahead, that is not the same as the piece
 * handed over most recently, which is what these tests pin down.
 */
describe("pause and resume", () => {
  beforeEach(installFakeEngine);
  afterEach(restoreEngine);

  it("stops speaking and reports that it is paused", () => {
    speakText(question);
    expect(isSpeaking()).toBe(true);

    expect(pauseSpeech()).toBe(true);
    expect(isPaused()).toBe(true);
    expect(isSpeaking()).toBe(false);
  });

  it("picks up at the piece playing, not the one queued furthest ahead", () => {
    speakText(question);
    finishCurrent();
    const playing = queue[0].text;
    expect(playing).toBe(chunkForSpeech(question)[1]);

    pauseSpeech();
    const before = spoken.length;
    expect(resumeSpeech()).toBe(true);
    expect(spoken[before].text).toBe(playing);
    expect(isPaused()).toBe(false);
  });

  it("ignores an end event that arrives after the pause", () => {
    speakText(question);
    pauseSpeech();
    const before = spoken.length;
    finishCurrent();

    expect(spoken).toHaveLength(before);
  });

  it("still reaches the end of the question after a pause", () => {
    speakText(question);
    finishCurrent();
    pauseSpeech();
    resumeSpeech();
    for (let guard = 0; isSpeaking() && guard < 50; guard += 1) finishCurrent();

    for (const chunk of chunkForSpeech(question)) expect(texts()).toContain(chunk);
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

/**
 * Resuming from the word being spoken rather than the top of the piece.
 *
 * `boundary` events are the only progress an engine reports. Where they arrive, a pause
 * or a speed change costs a word; where they do not, some Android voices among them,
 * the piece repeats and nothing is lost but a few seconds.
 */
describe("resuming from the reported position", () => {
  beforeEach(installFakeEngine);
  afterEach(restoreEngine);

  const line = "Contoso needs a resilient design across two regions with an automatic failover path.";

  it("picks up at the word the engine last reported", () => {
    speakText(line);
    const playing = spoken[0].text;
    const at = playing.indexOf("automatic");
    reachChar(at);

    pauseSpeech();
    const before = spoken.length;
    resumeSpeech();
    expect(spoken[before].text).toBe(playing.slice(at));
  });

  it("never resumes mid-word when the report lands inside one", () => {
    speakText(line);
    const at = spoken[0].text.indexOf("automatic") + 4;
    reachChar(at);

    pauseSpeech();
    const before = spoken.length;
    resumeSpeech();
    expect(spoken[before].text.startsWith("automatic")).toBe(true);
  });

  it("applies a speed change from the reported position too", () => {
    let rate = 1;
    speakText(line, () => ({ rate }));
    const playing = spoken[0].text;
    const at = playing.indexOf("resilient");
    reachChar(at);

    rate = 1.6;
    const before = spoken.length;
    applySpeechSettings();
    expect(spoken[before].text).toBe(playing.slice(at));
    expect(spoken[before].rate).toBe(1.6);
  });

  it("repeats the piece when the engine reports nothing", () => {
    speakText(line);
    const playing = spoken[0].text;

    pauseSpeech();
    const before = spoken.length;
    resumeSpeech();
    expect(spoken[before].text).toBe(playing);
  });

  it("ignores a report outside the piece rather than skipping content", () => {
    speakText(line);
    const playing = spoken[0].text;
    reachChar(playing.length + 50);

    pauseSpeech();
    const before = spoken.length;
    resumeSpeech();
    expect(spoken[before].text).toBe(playing);
  });

  it("ignores a report from a piece that is only queued, not playing", () => {
    speakText(question);
    const chunks = chunkForSpeech(question);
    // The second piece is waiting its turn; its progress must not move the first.
    queue[1].onboundary?.({ charIndex: 40 });

    pauseSpeech();
    const before = spoken.length;
    resumeSpeech();
    expect(spoken[before].text).toBe(chunks[0]);
  });

  it("starts each piece's progress from zero", () => {
    speakText(question);
    reachChar(40);
    finishCurrent();
    const playing = queue[0].text;

    pauseSpeech();
    const before = spoken.length;
    resumeSpeech();
    expect(spoken[before].text).toBe(playing);
  });
});
