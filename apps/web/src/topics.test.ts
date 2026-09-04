import { describe, expect, it } from "vitest";
import {
  cardTopic,
  filterCardsByTopic,
  filterUntopicedCards,
  findTopicName,
  listTopicNames,
  normalizeTopicName,
  retagCardTopic,
  sameTopic,
  selectedTopicName,
  TOPIC_PREFIX,
} from "./topics";
import type { CapturedQuestion, StudyCard } from "./types";

function question(id: string, topic: string): CapturedQuestion {
  return {
    id, examCode: "AZ-305", sourceUrl: "", topic, number: "1", prompt: `Prompt ${id}`,
    choices: [], correctAnswers: [], mostVotedAnswers: [], voteDistribution: [],
    explanation: "", discussionCount: null, discussion: null, images: [], capturedAt: "",
  };
}

function card(id: string, questionId: string, tags: string[]): StudyCard {
  return {
    id, questionId, type: "question", front: "Q\n\nA. One", back: "A", explanation: "",
    questionImages: [], answerImages: [], tags, confidence: "source-answer", sourceUrl: "",
    createdAt: "", masteryRating: null, ratingUpdatedAt: null, updatedAt: "",
  };
}

describe("naming topics", () => {
  it("treats the same topic written differently as one topic", () => {
    expect(sameTopic("Topic 3", "TOPIC 3")).toBe(true);
    expect(sameTopic("  Topic  3 ", "Topic 3")).toBe(true);
    expect(sameTopic("Topic 3", "Topic 4")).toBe(false);
  });

  it("collapses the whitespace a capture leaves behind", () => {
    expect(normalizeTopicName("  Topic   3\n")).toBe("Topic 3");
    expect(normalizeTopicName(undefined as unknown as string)).toBe("");
  });

  it("lists each topic once, in the order a person would expect", () => {
    // Numeric ordering, so Topic 10 does not sort between Topic 1 and Topic 2.
    const topics = listTopicNames([
      question("a", "Topic 10"), question("b", "Topic 2"),
      question("c", "topic 2"), question("d", ""), question("e", "Topic 1"),
    ]);
    expect(topics).toEqual(["Topic 1", "Topic 2", "Topic 10"]);
  });

  it("finds a topic however it was typed, and reports the spelling in use", () => {
    const questions = [question("a", "Topic 3")];
    expect(findTopicName(questions, "topic 3")).toBe("Topic 3");
    expect(findTopicName(questions, "Topic 9")).toBeNull();
  });

  it("reads a prefixed filter, so a topic named all is still a topic", () => {
    expect(selectedTopicName(`${TOPIC_PREFIX}all`)).toBe("all");
    expect(selectedTopicName("all")).toBeNull();
  });
});

describe("filtering by topic", () => {
  const questions = [question("q1", "Topic 3"), question("q2", "Topic 4"), question("q3", "")];
  const byId = new Map(questions.map((item) => [item.id, item]));
  const cards = [card("c1", "q1", []), card("c2", "q2", []), card("c3", "q3", [])];

  it("reads a card's topic from its question", () => {
    expect(cardTopic(cards[0], byId)).toBe("Topic 3");
    expect(cardTopic(cards[2], byId)).toBe("");
  });

  it("gathers the questions carrying a topic", () => {
    expect(filterCardsByTopic(cards, byId, "topic 3").map(({ id }) => id)).toEqual(["c1"]);
  });

  it("gathers the ones carrying none", () => {
    expect(filterUntopicedCards(cards, byId).map(({ id }) => id)).toEqual(["c3"]);
  });

  it("treats a card whose question is missing as having no topic", () => {
    expect(cardTopic(card("c9", "gone", []), byId)).toBe("");
  });
});

describe("rewriting the topic copied onto a card", () => {
  it("renames the topic and leaves the exam code alone", () => {
    expect(retagCardTopic(["AZ-305", "Topic 3"], "Topic 3", "Networking")).toEqual(["AZ-305", "Networking"]);
  });

  it("clears the topic when the new name is empty", () => {
    expect(retagCardTopic(["AZ-305", "Topic 3"], "Topic 3", "")).toEqual(["AZ-305"]);
  });

  it("matches however the tag was capitalised", () => {
    expect(retagCardTopic(["AZ-305", "TOPIC 3"], "topic 3", "Networking")).toEqual(["AZ-305", "Networking"]);
  });

  it("adds the new topic to a card whose tags never carried the old one", () => {
    // The question held the topic, so the card should end up showing it either way.
    expect(retagCardTopic(["AZ-305"], "Topic 3", "Networking")).toEqual(["AZ-305", "Networking"]);
  });

  it("changes nothing when clearing a topic the card never had", () => {
    expect(retagCardTopic(["AZ-305"], "Topic 3", "")).toEqual(["AZ-305"]);
  });

  it("does not leave the same topic on a card twice", () => {
    expect(retagCardTopic(["AZ-305", "Topic 3", "Networking"], "Topic 3", "Networking")).toEqual(["AZ-305", "Networking"]);
  });

  it("keeps tags that are neither the exam code nor the topic", () => {
    expect(retagCardTopic(["AZ-305", "Topic 3", "Case study"], "Topic 3", "")).toEqual(["AZ-305", "Case study"]);
  });

  it("survives empty and malformed tags", () => {
    expect(retagCardTopic([], "Topic 3", "Networking")).toEqual(["Networking"]);
    expect(retagCardTopic(["", "  ", "AZ-305"], "Topic 3", "")).toEqual(["AZ-305"]);
  });
});
