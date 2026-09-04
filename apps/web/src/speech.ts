/**
 * Reading questions aloud with the browser's built-in speech synthesis.
 *
 * The whole feature hinges on one quirk: Chrome silently truncates a single
 * utterance after roughly fifteen seconds. It fails with no error and no `end` event,
 * so a question simply stops mid-sentence. Since the median question here runs to
 * seventy words, nearly every one would be cut off if spoken as a single utterance.
 *
 * The fix is to split the text at sentence boundaries and chain the pieces on each
 * other's `end` event. The alternative doing the rounds, calling `resume()` on a
 * timer, works on desktop Chrome but breaks on Android, which is the platform that
 * matters here.
 *
 * Splitting is a cost as well as a fix, because every seam is an audible gap, so the
 * pieces are as long as that ceiling allows and are cut only where a break sounds
 * deliberate: the end of a sentence, a colon, a line break, or a list marker.
 */

/**
 * Hard ceiling. Past roughly this length Chrome cuts the utterance off silently.
 *
 * Not a documented number. The truncation is time-based, around fifteen seconds, so
 * the safe character count moves with the speaking rate: at 2x this is comfortable and
 * at 0.5x it is not. Set from listening rather than derived, and the failure it guards
 * against is loud and obvious, a question stopping dead mid-sentence, so if that starts
 * happening at a slow rate this is the number to bring back down.
 */
const MAX_CHUNK_CHARS = 360;

/**
 * Preferred length, just under the ceiling.
 *
 * Every boundary between pieces is an audible gap. The engine needs a moment to start
 * an utterance, and no amount of queueing ahead removes that entirely, so the only real
 * control over how choppy a question sounds is how few pieces it is cut into. On a
 * typical question 300 gives two or three seams where 170 gave five.
 *
 * This was once set to 90 for a different reason: a restart replays the piece in
 * flight, so a shorter piece meant a shorter rewind on pause or a speed change. Reading
 * the engine's boundary events made that argument mostly moot, because a restart now
 * resumes at the word rather than the top of the piece. Fewer, longer pieces win.
 */
const TARGET_CHUNK_CHARS = 300;

/**
 * How many pieces are handed to the engine ahead of the one playing.
 *
 * Waiting for an `end` event before asking for the next piece puts a JavaScript round
 * trip in the middle of every sentence, and that is the gap you hear. It is worst on a
 * phone, where a voice may be synthesized over the network and the request only starts
 * once the previous piece has already gone quiet. Queueing ahead lets the engine move
 * from one piece to the next itself and gives it something to prepare in the meantime.
 *
 * There is no way to go further and render the audio in advance: the Web Speech API
 * hands synthesized speech straight to the output and exposes no buffer to hold.
 *
 * The cost of a deeper queue is that a piece already handed over was built with the
 * settings of a moment ago, so a speed change made now is not heard until the queue
 * drains to it. That is why releasing a slider restarts from the current word instead
 * of waiting.
 */
const SPEECH_LOOKAHEAD = 2;

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

/**
 * Bullets, turned into the line breaks they already are.
 *
 * A bullet marks the start of an item, which is the same boundary a newline marks, and
 * captured prompts carry requirement lists written both ways. Replacing the marker
 * rather than splitting around it also keeps the glyph out of the speech: engines vary
 * between saying nothing for "•" and announcing it, and neither belongs in the middle
 * of a requirement.
 *
 * Only a dash or asterisk that opens a line counts. Mid-sentence they are punctuation
 * and a hyphenated word would otherwise be read as two list items.
 */
function normalizeListMarkers(text: string): string {
  return text
    .replace(/[•‣▪▫●○◦⁃∙]+[ \t]*/g, "\n")
    .replace(/^[ \t]*[-*–—][ \t]+/gm, "\n");
}

/**
 * Boundaries to break on: a full stop, a colon, a line break, or a list marker.
 *
 * Colons earn their place because captured prompts are full of "Requirements:" and
 * "You need to:" headings, and running one into the list it introduces sounds wrong.
 * Commas and semicolons are deliberately not here. They are frequent enough that
 * honouring them would cut a question into far more pieces than the length calls for,
 * which is what made reading sound choppy. They survive as a fallback in
 * `chunkForSpeech`, used only when a single sentence overruns on its own.
 *
 * The negative lookbehind skips the stop after a choice label. "A." is not the end of
 * a sentence, and treating it as one strands the letter on the end of the previous
 * piece: you hear "Choices. A." and then, after the seam, the text of choice A with
 * "B." tacked on.
 */
function splitSentences(text: string): string[] {
  return normalizeListMarkers(text)
    .split(/(?<=[.!?:])(?<!(?:^|\s)[A-Za-z][.:])\s+|\n+/)
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
 *
 * Two limits, doing different jobs. Pieces are packed up to `targetChars`, which keeps
 * the usual piece short so a pause or a speed change rewinds only a few seconds. A
 * single sentence or clause longer than that is still kept whole up to `maxChars`,
 * because a break at punctuation sounds deliberate and one mid-clause does not.
 */
export function chunkForSpeech(text: string, maxChars = MAX_CHUNK_CHARS, targetChars = TARGET_CHUNK_CHARS): string[] {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  const target = Math.max(1, Math.min(targetChars, maxChars));

  const chunks: string[] = [];
  let current = "";

  const push = (piece: string) => {
    if (!piece) return;
    if (current && `${current} ${piece}`.length > target) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  };

  for (const sentence of splitSentences(trimmed)) {
    if (sentence.length <= target) {
      push(sentence);
      continue;
    }
    // Longer than we would like: look for clause punctuation to break on instead.
    const clauses = sentence.split(/(?<=[,;])\s+/).map((part) => part.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (clause.length <= maxChars) push(clause);
      else for (const run of splitLongRun(clause, target)) push(run);
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
  // Choices usually arrive with no closing punctuation, and several of them commonly
  // end up in one utterance. Without a full stop the engine runs "the secondary region"
  // straight into "B", so the pause between choices has to be put there deliberately.
  const spokenChoices = choices
    .map((choice) => String(choice ?? "").trim())
    .filter(Boolean)
    .map((choice) => (/[.!?:;,]$/.test(choice) ? choice : `${choice}.`));
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
  /** The next piece to hand to the engine, which may be ahead of the one playing. */
  nextIndex: number;
  /** Pieces given to the engine that have not reported finishing. */
  pending: number;
  options: SpeechOptionsSource;
  /**
   * How far into the speaking chunk the engine has reached, from its `boundary`
   * events. Stays at zero on engines that do not fire them, some Android voices
   * among them, and the chunk then simply restarts from its beginning.
   */
  spokenChars: number;
}

/** Snaps back to the start of the word at `index`, so nothing resumes mid-word. */
function wordStartBefore(text: string, index: number): number {
  if (!Number.isFinite(index) || index <= 0 || index >= text.length) return 0;
  let start = Math.floor(index);
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  return start;
}

/**
 * The run's chunks with the sentence in flight trimmed to the word being spoken.
 *
 * An utterance cannot be altered once started, so resuming and changing the speed both
 * mean speaking that sentence again. Boundary events let it start again at the word you
 * were on rather than the top of the sentence, which is the difference between losing a
 * word and losing five seconds. Where the engine reports nothing, this returns the
 * chunks untouched and the sentence repeats, as before.
 */
function chunksFromSpokenPoint(run: ActiveRun): string[] {
  const chunk = run.chunks[run.speakingIndex] ?? "";
  const offset = wordStartBefore(chunk, run.spokenChars);
  if (offset <= 0) return run.chunks;
  const remainder = chunk.slice(offset).trim();
  if (!remainder) return run.chunks;
  const chunks = [...run.chunks];
  chunks[run.speakingIndex] = remainder;
  return chunks;
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
  const run: ActiveRun = { chunks, speakingIndex: startIndex, nextIndex: startIndex, pending: 0, options, spokenChars: 0 };
  activeRun = run;

  const handOver = (index: number) => {
    const current = resolveSpeechOptions(options);
    const voice = current.voiceURI
      ? listSpeechVoices().find((candidate) => candidate.voiceURI === current.voiceURI)
      : undefined;
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    utterance.rate = clampRate(current.rate);
    utterance.pitch = current.pitch ?? 1;
    utterance.volume = clampVolume(current.volume);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }

    // Which piece is actually playing, rather than which was queued last. With more
    // than one waiting these are not the same, and pausing needs the playing one.
    utterance.onstart = () => {
      if (token !== speechToken) return;
      run.speakingIndex = index;
      run.spokenChars = 0;
    };
    // Progress within the sentence, so a pause or a speed change can pick up near
    // where it stopped. Ignored unless this is the piece currently playing.
    utterance.onboundary = (event) => {
      if (token !== speechToken || run.speakingIndex !== index) return;
      const at = event.charIndex;
      if (typeof at === "number" && at > run.spokenChars) run.spokenChars = at;
    };

    const finished = () => {
      // A newer question, or a cancel, invalidates everything still queued here.
      if (token !== speechToken) return;
      run.pending -= 1;
      fill();
      if (run.pending <= 0 && run.nextIndex >= chunks.length) activeRun = null;
    };
    utterance.onend = finished;
    // One piece the engine chokes on should cost that piece, not the rest of the
    // question. A cancel also arrives here, and the token check has already caught it.
    utterance.onerror = finished;

    run.pending += 1;
    try {
      // Chrome can be left paused by a previous cancel, which silently swallows speech.
      synthesis.resume();
      synthesis.speak(utterance);
    } catch {
      run.pending -= 1;
    }
  };

  /** Tops the engine's queue back up to the lookahead depth. */
  const fill = () => {
    while (token === speechToken && run.pending <= SPEECH_LOOKAHEAD && run.nextIndex < chunks.length) {
      const index = run.nextIndex;
      run.nextIndex += 1;
      handOver(index);
    }
  };
  fill();
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
  const chunks = chunksFromSpokenPoint(run);
  startSpeaking(chunks, run.speakingIndex, run.options);
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
  const snapshot: ActiveRun = { ...run, chunks: chunksFromSpokenPoint(run), spokenChars: 0 };
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
