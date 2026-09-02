import type { CapturedQuestion, StudyCard } from "./types";

export const ALL_EXAMS = "all";

export function cardExamCode(card: StudyCard, questionById: ReadonlyMap<string, CapturedQuestion>): string {
  const questionCode = questionById.get(card.questionId)?.examCode.trim().toUpperCase();
  if (questionCode) return questionCode;
  return card.tags[0]?.trim().toUpperCase() || "UNSPECIFIED";
}

export function listExamCodes(cards: readonly StudyCard[], questionById: ReadonlyMap<string, CapturedQuestion>): string[] {
  return [...new Set(cards.map((card) => cardExamCode(card, questionById)))].sort((left, right) => left.localeCompare(right));
}

export function filterCardsByExam(
  cards: readonly StudyCard[],
  examCode: string,
  questionById: ReadonlyMap<string, CapturedQuestion>,
): StudyCard[] {
  if (examCode === ALL_EXAMS) return [...cards];
  return cards.filter((card) => cardExamCode(card, questionById) === examCode);
}
