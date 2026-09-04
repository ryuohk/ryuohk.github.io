import type { CapturedQuestion, StudyCard } from "./types";

/**
 * Topics, as scraped and as shown.
 *
 * A topic arrives with the capture rather than being something you chose, and it lands
 * in two places: on the question, and copied onto every card built from it as a tag
 * beside the exam code. That copy is what renders under a question while you study, so
 * changing a topic means changing both or the change does not show.
 *
 * Renaming one is safe. A question's identity is a hash of its exam code, prompt,
 * choices and images, and the topic is not among them, so no rename can split a
 * question from the copy already in the shared library or strand anyone's ratings.
 */

export const ALL_TOPICS = "all";
export const UNTOPICED = "untopiced";
/** Prefixed, so a topic actually named "all" cannot be read as the option above it. */
export const TOPIC_PREFIX = "topic:";

export function selectedTopicName(filter: string): string | null {
  return filter.startsWith(TOPIC_PREFIX) ? filter.slice(TOPIC_PREFIX.length) : null;
}

export function normalizeTopicName(name: string): string {
  return String(name ?? "").replace(/\s+/g, " ").trim();
}

/** Case-insensitive: "Topic 3" and "TOPIC 3" are the same topic written twice. */
export function sameTopic(left: string, right: string): boolean {
  return normalizeTopicName(left).toLowerCase() === normalizeTopicName(right).toLowerCase();
}

export function listTopicNames(questions: readonly CapturedQuestion[]): string[] {
  const byLowercase = new Map<string, string>();
  for (const question of questions) {
    const topic = normalizeTopicName(question.topic);
    // First spelling seen wins, so a stray "topic 3" does not become a second entry.
    if (topic && !byLowercase.has(topic.toLowerCase())) byLowercase.set(topic.toLowerCase(), topic);
  }
  return [...byLowercase.values()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

export function findTopicName(questions: readonly CapturedQuestion[], name: string): string | null {
  return listTopicNames(questions).find((topic) => sameTopic(topic, name)) ?? null;
}

export function cardTopic(card: StudyCard, questionById: ReadonlyMap<string, CapturedQuestion>): string {
  return normalizeTopicName(questionById.get(card.questionId)?.topic ?? "");
}

export function filterCardsByTopic(
  cards: readonly StudyCard[],
  questionById: ReadonlyMap<string, CapturedQuestion>,
  topic: string,
): StudyCard[] {
  return cards.filter((card) => sameTopic(cardTopic(card, questionById), topic));
}

export function filterUntopicedCards(
  cards: readonly StudyCard[],
  questionById: ReadonlyMap<string, CapturedQuestion>,
): StudyCard[] {
  return cards.filter((card) => !cardTopic(card, questionById));
}

/**
 * Rewrites the topic copied onto a card's tags, leaving the exam code alone.
 *
 * An empty `to` clears it, which is what deleting a topic does: the questions keep
 * everything else and simply stop carrying it. A card whose question held the topic but
 * whose tags somehow never did still gains the new one, so the two cannot drift apart.
 */
export function retagCardTopic(tags: readonly string[], from: string, to: string): string[] {
  const next: string[] = [];
  let matched = false;
  for (const tag of tags) {
    if (!sameTopic(tag, from)) {
      next.push(tag);
      continue;
    }
    matched = true;
    if (to) next.push(to);
  }
  if (!matched && to) next.push(to);
  return [...new Set(next.map((tag) => String(tag ?? "").trim()).filter(Boolean))];
}
