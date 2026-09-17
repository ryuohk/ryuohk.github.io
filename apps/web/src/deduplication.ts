import { questionContentKey, normalizeWhitespace } from "@crambot/core";
import type { CapturedQuestion, StudyCard } from "./types";
import { leavesMasteryPool, type StudySession, type StudySettings } from "./study-session";

const NOTE_SEPARATOR = "\n\n---\n\n";

export function cardContentKey(card: Pick<StudyCard, "type" | "front" | "back" | "explanation" | "questionImages" | "answerImages" | "confidence">): string {
  const images = (items: StudyCard["questionImages"] | StudyCard["answerImages"]) => items.map((image) => [image.role, normalizeWhitespace(image.alt), image.dataUrl || image.src]);
  return JSON.stringify([card.type, normalizeWhitespace(card.front), normalizeWhitespace(card.back), normalizeWhitespace(card.explanation), images(card.questionImages), images(card.answerImages), card.confidence]);
}

/** A lossless view: original records remain available to backup and cloud sync. */
export function consolidateLibrary(questions: readonly CapturedQuestion[], cards: readonly StudyCard[]) {
  const questionKeys = new Map<string, string>();
  for (const question of questions) {
    try {
      questionKeys.set(question.id, questionContentKey(question));
    } catch {
      // Incomplete legacy backups must not cause unrelated cards to disappear.
      questionKeys.set(question.id, JSON.stringify(["invalid", question.id]));
    }
  }
  const groups = new Map<string, StudyCard[]>();
  for (const card of cards) {
    const key = JSON.stringify([questionKeys.get(card.questionId) ?? card.questionId, cardContentKey(card)]);
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  const aliases = new Map<string, string>();
  const merged = [...groups.values()].map((group) => {
    // Earliest stored card wins identity, independently of import/pull ordering.
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const first = group[0];
    for (const card of group) aliases.set(card.id, first.id);
    if (group.length === 1) return first;
    // updatedAt includes explicit resets, whose ratingUpdatedAt is null.
    const latest = [...group].sort((a, b) =>
      (b.ratingUpdatedAt ?? b.updatedAt).localeCompare(a.ratingUpdatedAt ?? a.updatedAt)
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0];
    return {
      ...first,
      masteryRating: latest.masteryRating,
      ratingUpdatedAt: latest.ratingUpdatedAt,
      updatedAt: latest.updatedAt,
      notes: [...new Set(group.flatMap((card) => (card.notes ?? "").split(NOTE_SEPARATOR)).filter(Boolean))].join(NOTE_SEPARATOR),
      feedbackFlags: [...new Set(group.flatMap((card) => card.feedbackFlags ?? []))],
      tags: [...new Set(group.flatMap((card) => card.tags))],
    };
  });
  const keptQuestions = new Set(merged.map((card) => card.questionId));
  return { cards: merged, questions: questions.filter((question) => keptQuestions.has(question.id)), aliases };
}

export function remapIds(ids: readonly string[], aliases: ReadonlyMap<string, string>): string[] {
  return [...new Set(ids.map((id) => aliases.get(id) ?? id))];
}

export function remapSettings(settings: StudySettings, aliases: ReadonlyMap<string, string>): StudySettings {
  const next = {
    ...settings,
    masteryCardIds: remapIds(settings.masteryCardIds, aliases),
    cardGroups: Object.fromEntries(Object.entries(settings.cardGroups).map(([name, ids]) => [name, remapIds(ids, aliases)])),
  };
  return JSON.stringify(next) === JSON.stringify(settings) ? settings : next;
}

export function remapSession(session: StudySession | null, aliases: ReadonlyMap<string, string>): StudySession | null {
  if (!session) return null;
  if (![...session.order, ...session.queue, ...session.results.map((result) => result.cardId), ...Object.keys(session.answers)].some((id) => aliases.has(id) && aliases.get(id) !== id)) return session;
  const order = remapIds(session.order, aliases);
  const latestResults = new Map(session.results.map((result) => [aliases.get(result.cardId) ?? result.cardId, result]));
  const queue = remapIds(session.queue, aliases).filter((id) => {
    const latest = latestResults.get(id);
    return !latest || (session.mode === "mastery" && !leavesMasteryPool(latest.rating));
  });
  const next = {
    ...session, order, queue,
    total: order.length,
    completed: order.filter((id) => !queue.includes(id)).length,
    results: session.results.map((result) => ({ ...result, cardId: aliases.get(result.cardId) ?? result.cardId })),
    answers: Object.fromEntries(Object.entries(session.answers).map(([id, answers]) => [aliases.get(id) ?? id, answers])),
  };
  return JSON.stringify(next) === JSON.stringify(session) ? session : next;
}
