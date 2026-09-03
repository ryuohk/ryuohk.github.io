/**
 * Reading questions aloud with the browser's built-in speech synthesis.
 *
 * The whole feature hinges on one quirk: Chrome silently truncates a single
 * utterance after roughly fifteen seconds, which at a normal reading pace is about
 * 200 characters. It fails with no error and no `end` event, so a question simply
 * stops mid-sentence. Since the median question here runs to seventy words, nearly
 * every one would be cut off if spoken as a single utterance.
 *
 * The fix is to split the text at sentence boundaries and chain the pieces on each
 * other's `end` event. The alternative doing the rounds, calling `resume()` on a
 * timer, works on desktop Chrome but breaks on Android, which is the platform that
 * matters here.
 */

/** Comfortably under Chrome's truncation point, and close to a natural breath. */
const MAX_CHUNK_CHARS = 180;

export const SPEECH_RATE_MIN = 0.5;
export const SPEECH_RATE_MAX = 2;
export const DEFAULT_SPEECH_RATE = 1.1;

export const SPEECH_VOLUME_MIN = 0;
export const SPEECH_VOLUME_MAX = 1;
export const DEFAULT_SPEECH_VOLUME = 1;

export interface SpeechOptions {
  rate?: number;
  pitch?: number;
  volume?: number;
  voiceURI?: string | null;
}

/**
 * Either fixed options, or a getter read once per chunk.
 *
 * A speaking utterance cannot be changed once started, so live adjustment works by
 * applying the newest settings to the next chunk. Passing a getter lets a speed or
 * volume change take effect within a sentence or two instead of forcing a restart.
 */
export type SpeechOptionsSource = SpeechOptions | (() => SpeechOptions);

export function resolveSpeechOptions(source: SpeechOptionsSource | undefined): SpeechOptions {
  if (typeof source === "function") {
    try {
      return source() ?? {};
    } catch {
      return {};
    }
  }
  return source ?? {};
}

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?:])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Last resort for a sentence with no internal punctuation: break on whitespace. */
function splitLongRun(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of sentence.split(/\s+/)) {
    // A single token longer than the budget, a long URL or an identifier, has no
    // whitespace to break on. Splitting it on character boundaries sounds worse than
    // it reads, but the alternative is Chrome truncating it and never firing the
    // `end` event that drives the rest of the question.
    if (word.length > maxChars) {
      if (current) {
        pieces.push(current);
        current = "";
      }
      for (let start = 0; start < word.length; start += maxChars) {
        pieces.push(word.slice(start, start + maxChars));
      }
      continue;
    }
    if (current && `${current} ${word}`.length > maxChars) {
      pieces.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Splits text into utterance-sized pieces, preferring sentence boundaries, then
 * clause punctuation, and only breaking mid-clause when a run has neither.
 */
export function chunkForSpeech(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];

  const chunks: string[] = [];
  let current = "";

  const push = (piece: string) => {
    if (!piece) return;
    if (current && `${current} ${piece}`.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  };

  for (const sentence of splitSentences(trimmed)) {
    if (sentence.length <= maxChars) {
      push(sentence);
      continue;
    }
    // Too long on its own: try clause punctuation before breaking on words.
    const clauses = sentence.split(/(?<=[,;])\s+/).map((part) => part.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (clause.length <= maxChars) push(clause);
      else for (const run of splitLongRun(clause, maxChars)) push(run);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Builds what should actually be said for a question.
 *
 * Choices are included because a multiple-choice question is not answerable without
 * them. A question that depends on a diagram is announced rather than skipped, so
 * silence is never mistaken for a fault.
 */
export function buildQuestionSpeech(prompt: string, choices: readonly string[], imageCount = 0): string {
  const parts: string[] = [];
  const spokenPrompt = String(prompt ?? "").trim();
  if (spokenPrompt) parts.push(spokenPrompt);
  if (imageCount > 0) {
    parts.push(imageCount === 1 ? "This question includes a diagram on screen." : `This question includes ${imageCount} diagrams on screen.`);
  }
  const spokenChoices = choices.map((choice) => String(choice ?? "").trim()).filter(Boolean);
  if (spokenChoices.length) parts.push("Choices.", ...spokenChoices);
  return parts.join("\n");
}

export function listSpeechVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSupported()) return [];
  try {
    return window.speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

/**
 * Voices load asynchronously and `getVoices()` is empty until then, so the first
 * question of a session would otherwise use the wrong voice or none at all.
 */
export function onVoicesReady(handler: () => void): () => void {
  if (!isSpeechSupported()) return () => undefined;
  const synthesis = window.speechSynthesis;
  synthesis.addEventListener?.("voiceschanged", handler);
  return () => synthesis.removeEventListener?.("voiceschanged", handler);
}

export function clampRate(rate: number | undefined): number {
  const value = Number.isFinite(rate) ? Number(rate) : DEFAULT_SPEECH_RATE;
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, value));
}

/** Out-of-range volume is rejected outright by some engines, silencing speech. */
export function clampVolume(volume: number | undefined): number {
  const value = Number.isFinite(volume) ? Number(volume) : DEFAULT_SPEECH_VOLUME;
  return Math.min(SPEECH_VOLUME_MAX, Math.max(SPEECH_VOLUME_MIN, value));
}

/**
 * Incremented on every cancel, so a chain still running for a previous question
 * stops queueing its remaining pieces instead of talking over the new one.
 */
let speechToken = 0;

interface ActiveRun {
  chunks: string[];
  /** The chunk currently being spoken, which is what a settings change restarts. */
  speakingIndex: number;
  nextIndex: number;
  options: SpeechOptionsSource;
}

let activeRun: ActiveRun | null = null;
/** Retained across a pause so playback can pick up where it stopped. */
let pausedRun: ActiveRun | null = null;

export function cancelSpeech(): void {
  speechToken += 1;
  activeRun = null;
  pausedRun = null;
  if (!isSpeechSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // A cancel on an already-idle engine is not worth surfacing.
  }
}

function startSpeaking(chunks: string[], startIndex: number, options: SpeechOptionsSource): void {
  cancelSpeech();
  if (!isSpeechSupported() || startIndex >= chunks.length) return;

  const token = speechToken;
  const synthesis = window.speechSynthesis;
  const run: ActiveRun = { chunks, speakingIndex: startIndex, nextIndex: startIndex, options };
  activeRun = run;

  const speakNext = () => {
    // A newer question, or a cancel, invalidates everything still queued here.
    if (token !== speechToken) return;
    if (run.nextIndex >= chunks.length) {
      activeRun = null;
      return;
    }
    run.speakingIndex = run.nextIndex;
    run.nextIndex += 1;

    // Read per chunk, so speed and volume changes apply without a restart.
    const current = resolveSpeechOptions(options);
    const voice = current.voiceURI
      ? listSpeechVoices().find((candidate) => candidate.voiceURI === current.voiceURI)
      : undefined;
    const utterance = new SpeechSynthesisUtterance(chunks[run.speakingIndex]);
    utterance.rate = clampRate(current.rate);
    utterance.pitch = current.pitch ?? 1;
    utterance.volume = clampVolume(current.volume);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.onend = speakNext;
    // Abandon the rest rather than stuttering through a broken engine.
    utterance.onerror = () => undefined;
    try {
      // Chrome can be left paused by a previous cancel, which silently swallows speech.
      synthesis.resume();
      synthesis.speak(utterance);
    } catch {
      // Nothing useful to do; the question stays readable on screen.
    }
  };
  speakNext();
}

export function speakText(text: string, options: SpeechOptionsSource = {}): void {
  if (!isSpeechSupported()) return;
  startSpeaking(chunkForSpeech(text), 0, options);
}

/**
 * Re-speaks the sentence in flight so a new rate or volume is audible at once.
 *
 * A speaking utterance cannot be altered, so the only way to make an adjustment
 * immediate is to say that sentence again with the new settings. Restarting just the
 * current chunk keeps your place in the question, unlike starting over. Intended for
 * a slider's release rather than every movement, which would stutter.
 */
export function applySpeechSettings(): void {
  const run = activeRun;
  if (!run || !isSpeechSupported()) return;
  // Captured before cancelSpeech clears activeRun.
  const { chunks, speakingIndex, options } = run;
  startSpeaking(chunks, speakingIndex, options);
}

/** True while a question is mid-reading, so callers can skip pointless restarts. */
export function isSpeaking(): boolean {
  return activeRun !== null;
}

/**
 * Stops speaking but remembers the place.
 *
 * Deliberately not `speechSynthesis.pause()`, which is unreliable on Android and in
 * some versions behaves like cancel, leaving no way to resume. Stopping and recording
 * the sentence in flight works the same everywhere, at the cost of repeating that one
 * sentence when playback resumes.
 */
export function pauseSpeech(): boolean {
  const run = activeRun;
  if (!run) return false;
  const snapshot: ActiveRun = { ...run };
  cancelSpeech();
  pausedRun = snapshot;
  return true;
}

/** Resumes from the sentence that was interrupted. False when nothing was paused. */
export function resumeSpeech(): boolean {
  const run = pausedRun;
  if (!run) return false;
  pausedRun = null;
  startSpeaking(run.chunks, run.speakingIndex, run.options);
  return true;
}

export function isPaused(): boolean {
  return pausedRun !== null;
}
