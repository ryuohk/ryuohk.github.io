import { normalizeWhitespace } from "@crambot/core";
import type { CapturedQuestion, StudyCard } from "./types";

// Manual cleanup identity is deliberately independent of questionContentKey.
// Share only the whitespace primitive, never automatic deduplication's field policy.
export function libraryDuplicateKey(question: CapturedQuestion): string {
  return JSON.stringify({
    prompt: normalizeWhitespace(question.prompt),
    choices: question.choices.map(({ label, text }) => ({
      label: normalizeWhitespace(label).replace(/[.)]+$/, "").toUpperCase(),
      text: normalizeWhitespace(text),
    })),
    correctAnswers: [...new Set(question.correctAnswers.map((label) => normalizeWhitespace(label).toUpperCase()))].sort(),
    images: question.images.map((image) => ({
      role: image.role,
      content: image.dataUrl || normalizeWhitespace(image.src),
    })),
  });
}

export function areLibraryDuplicates(left: CapturedQuestion, right: CapturedQuestion): boolean {
  return libraryDuplicateKey(left) === libraryDuplicateKey(right);
}

export interface DuplicateGroup {
  number: number;
  size: number;
  referenceId: string;
}

/** Index the current library view, not hidden backing records consolidated on load. */
export function libraryDuplicateGroups(cards: StudyCard[], questions: ReadonlyMap<string, CapturedQuestion>): Map<string, DuplicateGroup> {
  const groups = new Map<string, StudyCard[]>();
  for (const card of cards) {
    const question = questions.get(card.questionId);
    if (!question || typeof question.prompt !== "string" || !Array.isArray(question.choices)
      || !Array.isArray(question.correctAnswers) || !Array.isArray(question.images)) continue;
    // Incomplete legacy records cannot establish equality.
    const key = libraryDuplicateKey(question);
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  const result = new Map<string, DuplicateGroup>();
  let number = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const info = { number: ++number, size: group.length, referenceId: group[0].id };
    for (const card of group) result.set(card.id, info);
  }
  return result;
}
