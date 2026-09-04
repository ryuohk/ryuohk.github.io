import { describe, expect, it } from "vitest";
import {
  addCardsToGroup,
  addCardsToMasterySession,
  advanceStudySession,
  cardLabel,
  cleanCardGroups,
  cleanMasteryCardIds,
  countCardsByLabel,
  createStudySession,
  deleteGroup,
  evaluateAnswer,
  filterCardsByGroup,
  filterCardsByLabel,
  filterEasyReviewPool,
  filterMasteryPool,
  filterUngroupedCards,
  findGroupName,
  groupsForCard,
  listGroupNames,
  normalizeGroupName,
  planEasyReview,
  planMasteryAdditions,
  removeCardsFromGroup,
  renameGroup,
  reviseStudyResult,
  selectMasteryAdditions,
  summarizeStudySession,
  updateMasteryCardIds,
  type StudySettings,
} from "./study-session";
import { MasteryRating, type MasteryRating as MasteryRatingValue, type StudyCard } from "./types";

const settings: StudySettings = {
  masterySetSize: 2,
  shuffleChoices: false,
  masteryPool: "all-not-easy",
  // The size tests below are about what a part contains, so they opt into parts.
  // Coverage of the default, which takes the whole pool, is its own test.
  easyReviewScope: "batch",
  easyReviewSize: 2,
  masteryCardIds: [],
  cardGroups: {},
  speakQuestions: false,
  speechRate: 1.1,
  speechVolume: 1,
};

function card(id: string, masteryRating: MasteryRatingValue | null = null, ratingUpdatedAt: string | null = null): StudyCard {
  return {
    id,
    questionId: id,
    type: "question",
    front: `Question ${id}\n\nA. One\nB. Two`,
    back: "A",
    explanation: "",
    questionImages: [],
    answerImages: [],
    tags: ["EXAM-101"],
    confidence: "source-answer",
    sourceUrl: "https://example.test",
    createdAt: "2026-08-28T00:00:00.000Z",
    masteryRating,
    ratingUpdatedAt,
    updatedAt: "2026-08-28T00:00:00.000Z",
  };
}

describe("mastery study sessions", () => {
  it("offers every non-Easy question in the full pool", () => {
    const cards = [
      card("unrated"),
      card("again", MasteryRating.Again),
      card("hard", MasteryRating.Hard),
      card("good", MasteryRating.Good),
      card("easy", MasteryRating.Easy),
    ];

    expect(filterMasteryPool(cards, "all-not-easy").map(({ id }) => id)).toEqual(["unrated", "again", "hard", "good"]);
    expect(filterMasteryPool(cards, "again-hard").map(({ id }) => id)).toEqual(["again", "hard"]);
  });

  it("builds a Mastery session only from the persistent pool", () => {
    const pooled = { ...settings, masteryCardIds: ["one", "two"] };
    const session = createStudySession([card("one"), card("two"), card("outside")], pooled, "mastery", () => 0.99);

    expect(new Set(session.order)).toEqual(new Set(["one", "two"]));
    expect(session.order).not.toContain("outside");
  });

  it("prioritizes Again cards when adding a limited batch to the Mastery pool", () => {
    const oneQuestion = { ...settings, masterySetSize: 1 };
    const additions = selectMasteryAdditions([
      card("unrated"),
      card("forgotten", MasteryRating.Again),
      card("good", MasteryRating.Good),
    ], oneQuestion, () => 0.99);

    expect(additions).toEqual(["forgotten"]);
  });

  it("adds Review Easy failures to the pool once and removes them only at Easy", () => {
    const ignoredHard = updateMasteryCardIds([], "needs-work", "easy-review", MasteryRating.Hard);
    const added = updateMasteryCardIds([], "forgotten", "easy-review", MasteryRating.Again);
    const deduplicated = updateMasteryCardIds(added, "forgotten", "easy-review", MasteryRating.Again);
    const retained = updateMasteryCardIds(deduplicated, "forgotten", "mastery", MasteryRating.Good);
    const removed = updateMasteryCardIds(retained, "forgotten", "mastery", MasteryRating.Easy);

    expect(ignoredHard).toEqual([]);
    expect(added).toEqual(["forgotten"]);
    expect(deduplicated).toEqual(["forgotten"]);
    expect(retained).toEqual(["forgotten"]);
    expect(removed).toEqual([]);
  });

  it("appends unique questions to a running Mastery session", () => {
    const session = createStudySession([card("one")], { ...settings, masteryCardIds: ["one"] }, "mastery");
    const expanded = addCardsToMasterySession(session, ["two", "one", "two"]);

    expect(expanded.queue).toEqual(["one", "two"]);
    expect(expanded.order).toEqual(["one", "two"]);
    expect(expanded.total).toBe(2);
  });

  /**
   * Personal groups.
   *
   * A question can be in several at once, which is the point: one question can be
   * about both networking and cost, and being made to pick one would defeat grouping.
   */
  it("puts a question in several groups without moving it", () => {
    let groups = addCardsToGroup({}, "Networking", ["a", "b"]);
    groups = addCardsToGroup(groups, "Cost", ["b", "c"]);

    expect(listGroupNames(groups)).toEqual(["Cost", "Networking"]);
    expect(groupsForCard(groups, "b")).toEqual(["Cost", "Networking"]);
    expect(groupsForCard(groups, "a")).toEqual(["Networking"]);
  });

  // Two groups an hour apart that look identical in the filter is the failure here.
  it("treats a name typed in another case as the group that already exists", () => {
    const groups = addCardsToGroup(addCardsToGroup({}, "Networking", ["a"]), "  networking ", ["b"]);

    expect(listGroupNames(groups)).toEqual(["Networking"]);
    expect(groups.Networking).toEqual(["a", "b"]);
    expect(findGroupName(groups, "NETWORKING")).toBe("Networking");
    expect(findGroupName(groups, "Storage")).toBeNull();
  });

  it("refuses a name that is only whitespace rather than making one nobody can see", () => {
    expect(normalizeGroupName("   ")).toBe("");
    expect(addCardsToGroup({}, "   ", ["a"])).toEqual({});
    expect(normalizeGroupName("  Two   words  ")).toBe("Two words");
  });

  it("drops a group emptied of its last question", () => {
    const groups = addCardsToGroup({}, "Networking", ["a", "b"]);

    expect(removeCardsFromGroup(groups, "Networking", ["a"])).toEqual({ Networking: ["b"] });
    expect(removeCardsFromGroup(groups, "Networking", ["a", "b"])).toEqual({});
  });

  it("merges on a rename into a name that is taken, and keeps a recapitalization", () => {
    const groups = { Networking: ["a", "b"], Cost: ["b", "c"] };

    expect(renameGroup(groups, "Cost", "Networking")).toEqual({ Networking: ["a", "b", "c"] });
    // The same group, spelled differently: the ids stay, the capitalization changes.
    expect(renameGroup(groups, "Cost", "cost")).toEqual({ Networking: ["a", "b"], cost: ["b", "c"] });
  });

  /**
   * Deleting a question does not know what it was grouped under, so without this a
   * group fills with ids matching nothing and its count stops agreeing with the list.
   */
  it("prunes deleted questions from groups, and groups left empty by that", () => {
    const groups = { Networking: ["a", "gone"], Retired: ["gone"] };

    expect(cleanCardGroups(groups, [card("a"), card("b")])).toEqual({ Networking: ["a"] });
  });

  it("selects a group's questions and the ones in no group at all", () => {
    const cards = [card("a"), card("b"), card("c")];
    const groups = { Networking: ["a", "b"] };

    expect(filterCardsByGroup(cards, groups, "networking").map(({ id }) => id)).toEqual(["a", "b"]);
    expect(filterCardsByGroup(cards, groups, "Missing")).toEqual([]);
    expect(filterUngroupedCards(cards, groups).map(({ id }) => id)).toEqual(["c"]);
  });

  it("removes a group without touching the questions in it", () => {
    expect(deleteGroup({ Networking: ["a"], Cost: ["b"] }, "networking")).toEqual({ Cost: ["b"] });
  });

  /**
   * The library's label filter.
   *
   * Three labels, because three is what the library shows. The retired Hard and Good
   * ratings read as Not yet here, as they do everywhere else: they behave as in-pool,
   * and giving them a category of their own would file questions you can still be
   * asked somewhere nobody would look for them.
   */
  it("files every rating under one of the three labels the library shows", () => {
    expect(cardLabel(card("a"))).toBe("unrated");
    expect(cardLabel(card("b", MasteryRating.Again))).toBe("not-yet");
    expect(cardLabel(card("c", MasteryRating.Hard))).toBe("not-yet");
    expect(cardLabel(card("d", MasteryRating.Good))).toBe("not-yet");
    expect(cardLabel(card("e", MasteryRating.Easy))).toBe("got-it");
  });

  it("filters the library by label and counts every label at once", () => {
    const cards = [
      card("unlabelled"),
      card("again", MasteryRating.Again),
      card("hard", MasteryRating.Hard),
      card("easy", MasteryRating.Easy),
    ];

    expect(filterCardsByLabel(cards, "all")).toHaveLength(4);
    expect(filterCardsByLabel(cards, "not-yet").map(({ id }) => id)).toEqual(["again", "hard"]);
    expect(filterCardsByLabel(cards, "got-it").map(({ id }) => id)).toEqual(["easy"]);
    expect(filterCardsByLabel(cards, "unrated").map(({ id }) => id)).toEqual(["unlabelled"]);
    expect(countCardsByLabel(cards)).toEqual({ all: 4, "not-yet": 2, "got-it": 1, unrated: 1 });
  });

  it("counts an empty library without inventing a label", () => {
    expect(countCardsByLabel([])).toEqual({ all: 0, "not-yet": 0, "got-it": 0, unrated: 0 });
  });

  it("prunes missing, duplicate, and Easy cards from a saved Mastery pool", () => {
    expect(cleanMasteryCardIds(
      [card("active", MasteryRating.Hard), card("easy", MasteryRating.Easy)],
      ["active", "missing", "easy", "active"],
    )).toEqual(["active"]);
  });

  it("keeps a Mastery question in rotation until it is rated Easy", () => {
    const session = createStudySession([card("one"), card("two")], { ...settings, masteryCardIds: ["one", "two"] }, "mastery", () => 0.99);
    const repeated = advanceStudySession(session, "one", MasteryRating.Good, ["A. One"], ["A"]);
    const mastered = advanceStudySession(repeated, "two", MasteryRating.Easy);

    expect(repeated.queue).toEqual(["two", "one"]);
    expect(repeated.completed).toBe(0);
    expect(repeated.results[0]).toMatchObject({ cardId: "one", selectedAnswers: ["A"], correct: true });
    expect(repeated.answers.one).toEqual([]);
    expect(mastered.queue).toEqual(["one"]);
    expect(mastered.completed).toBe(1);
    expect(mastered.attempts).toBe(2);
  });

  it("reviews only Easy questions and chooses the least recently reviewed first", () => {
    const cards = [
      card("hard", MasteryRating.Hard, "2026-08-20T00:00:00.000Z"),
      card("newer", MasteryRating.Easy, "2026-08-28T00:00:00.000Z"),
      card("oldest", MasteryRating.Easy, "2026-08-01T00:00:00.000Z"),
      card("middle", MasteryRating.Easy, "2026-08-15T00:00:00.000Z"),
    ];

    expect(filterEasyReviewPool(cards).map(({ id }) => id)).toEqual(["oldest", "middle", "newer"]);
    // Which two are reviewed is decided by age; the order they arrive in is not.
    const session = createStudySession(cards, settings, "easy-review");
    expect(new Set(session.order)).toEqual(new Set(["oldest", "middle"]));
  });

  // The heading counts what is ready and the button sits under it, so pressing it has
  // to produce that many questions. A stored part size used to shrink this silently.
  it("reviews the whole ready pool by default", () => {
    const cards = ["a", "b", "c", "d", "e"].map((id, index) => card(id, MasteryRating.Easy, `2026-08-0${index + 1}T00:00:00.000Z`));
    const session = createStudySession(cards, { ...settings, easyReviewScope: "all" }, "easy-review");

    expect(session.total).toBe(5);
    expect(new Set(session.order)).toEqual(new Set(["a", "b", "c", "d", "e"]));
  });

  it("counts the parts a batched review takes to cover the pool", () => {
    const batched = { ...settings, easyReviewScope: "batch" as const, easyReviewSize: 20 };

    expect(planEasyReview(57, batched)).toEqual({ sessionSize: 20, parts: 3 });
    // A part larger than what is left is not a promise of questions that do not exist.
    expect(planEasyReview(8, batched)).toEqual({ sessionSize: 8, parts: 1 });
    expect(planEasyReview(57, { ...settings, easyReviewScope: "all" })).toEqual({ sessionSize: 57, parts: 1 });
    expect(planEasyReview(0, { ...settings, easyReviewScope: "all" })).toEqual({ sessionSize: 0, parts: 0 });
  });

  /**
   * Parts carry on rather than repeat, and nothing is stored to make that happen: a
   * reviewed question is stamped with the time it was rated, which drops it to the
   * back of an oldest-first pool. This is the behaviour the "In parts" control sells.
   */
  it("starts the next part where the previous one stopped", () => {
    const batched = { ...settings, easyReviewScope: "batch" as const, easyReviewSize: 2 };
    const cards = ["a", "b", "c", "d"].map((id, index) => card(id, MasteryRating.Easy, `2026-08-0${index + 1}T00:00:00.000Z`));
    const firstPart = createStudySession(cards, batched, "easy-review");
    expect(new Set(firstPart.order)).toEqual(new Set(["a", "b"]));

    const reviewed = cards.map((existing) => firstPart.order.includes(existing.id)
      ? { ...existing, ratingUpdatedAt: "2026-09-01T00:00:00.000Z" }
      : existing);

    expect(new Set(createStudySession(reviewed, batched, "easy-review").order)).toEqual(new Set(["c", "d"]));
  });

  // Selecting by age alone would replay the same sequence every time, which turns the
  // running order itself into a cue for the answer.
  it("plays the Easy review in a shuffled order", () => {
    const cards = ["a", "b", "c", "d"].map((id, index) => card(id, MasteryRating.Easy, `2026-08-0${index + 1}T00:00:00.000Z`));
    const byAge = filterEasyReviewPool(cards).map(({ id }) => id);
    const played = createStudySession(cards, { ...settings, easyReviewSize: 4 }, "easy-review", () => 0).order;

    expect(new Set(played)).toEqual(new Set(byAge));
    expect(played).not.toEqual(byAge);
  });

  it("shows each Easy Review question once even when it is relabeled Hard", () => {
    const session = createStudySession([card("one", MasteryRating.Easy), card("two", MasteryRating.Easy)], settings, "easy-review");
    // Named by position rather than by id, now that the running order is shuffled.
    const [asked, next] = session.queue;
    const answered = advanceStudySession(session, asked, MasteryRating.Hard, ["A. One"], ["A"]);

    expect(answered.queue).toEqual([next]);
    expect(answered.completed).toBe(1);
    expect(answered.results[0]).toMatchObject({ cardId: asked, rating: MasteryRating.Hard, correct: true });
  });

  it("checks normalized single and multiple-choice answers exactly", () => {
    expect(evaluateAnswer(["a. first"], ["A"])).toBe(true);
    expect(evaluateAnswer(["B. second", "A. first"], ["A", "B"])).toBe(true);
    expect(evaluateAnswer(["A. first"], ["A", "B"])).toBe(false);
    expect(evaluateAnswer([], [])).toBeNull();
  });

  it("summarizes elapsed time and average seconds per completed question", () => {
    const started = new Date("2026-08-28T12:00:00.000Z");
    const session = createStudySession([card("one", MasteryRating.Easy)], settings, "easy-review", Math.random, started);
    const completed = advanceStudySession(session, "one", MasteryRating.Easy, ["A"], ["A"], new Date("2026-08-28T12:00:08.000Z"));

    expect(summarizeStudySession(completed)).toMatchObject({ completed: 1, durationSeconds: 8, averageSeconds: 8, accuracy: 100 });
  });
});

describe("revising an earlier answer", () => {
  const pooled = { ...settings, masteryCardIds: ["one", "two"] };

  it("brings a question back into the set when Easy is corrected downward", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const mastered = advanceStudySession(session, session.queue[0], MasteryRating.Easy, [], []);
    expect(mastered.completed).toBe(1);
    expect(mastered.queue).not.toContain(session.queue[0]);

    const corrected = reviseStudyResult(mastered, 0, MasteryRating.Again);
    expect(corrected.results[0].rating).toBe(MasteryRating.Again);
    expect(corrected.completed).toBe(0);
    expect(corrected.queue).toContain(session.queue[0]);
  });

  it("removes a question from the set when it is raised to Easy", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const first = session.queue[0];
    const again = advanceStudySession(session, first, MasteryRating.Again, [], []);
    expect(again.queue).toContain(first);

    const corrected = reviseStudyResult(again, 0, MasteryRating.Easy);
    expect(corrected.completed).toBe(1);
    expect(corrected.queue).not.toContain(first);
  });

  it("leaves the queue alone when both ratings are below Easy", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const again = advanceStudySession(session, session.queue[0], MasteryRating.Again, [], []);
    const corrected = reviseStudyResult(again, 0, MasteryRating.Hard);

    expect(corrected.queue).toEqual(again.queue);
    expect(corrected.completed).toBe(again.completed);
    expect(corrected.results[0].rating).toBe(MasteryRating.Hard);
  });

  it("never queues a duplicate when the question is already pending", () => {
    const session = createStudySession([card("one"), card("two")], pooled, "mastery", () => 0.99);
    const first = session.queue[0];
    const again = advanceStudySession(session, first, MasteryRating.Again, [], []);
    // Force the odd case of a completed result whose card is still queued.
    const odd = { ...again, results: [{ ...again.results[0], rating: MasteryRating.Easy }], completed: 1 };

    const corrected = reviseStudyResult(odd, 0, MasteryRating.Again);
    expect(corrected.queue.filter((id) => id === first)).toHaveLength(1);
  });

  it("keeps queue membership unchanged in an Easy review, where every answer completes", () => {
    const session = createStudySession([card("one", MasteryRating.Easy), card("two", MasteryRating.Easy)], settings, "easy-review");
    const reviewed = advanceStudySession(session, session.queue[0], MasteryRating.Easy, [], []);
    const corrected = reviseStudyResult(reviewed, 0, MasteryRating.Again);

    expect(corrected.queue).toEqual(reviewed.queue);
    expect(corrected.completed).toBe(reviewed.completed);
    expect(corrected.results[0].rating).toBe(MasteryRating.Again);
  });

  it("ignores an unchanged rating and an index that does not exist", () => {
    const session = createStudySession([card("one")], { ...settings, masteryCardIds: ["one"] }, "mastery");
    const again = advanceStudySession(session, "one", MasteryRating.Again, [], []);

    expect(reviseStudyResult(again, 0, MasteryRating.Again)).toBe(again);
    expect(reviseStudyResult(again, 9, MasteryRating.Easy)).toBe(again);
  });

  it("preserves the original answer time so history keeps its order", () => {
    const session = createStudySession([card("one")], { ...settings, masteryCardIds: ["one"] }, "mastery");
    const again = advanceStudySession(session, "one", MasteryRating.Again, [], [], new Date("2026-08-28T12:00:05.000Z"));
    const corrected = reviseStudyResult(again, 0, MasteryRating.Good);

    expect(corrected.results[0].answeredAt).toBe(again.results[0].answeredAt);
  });
});

/**
 * Hand-picking library questions into the Mastery pool.
 *
 * The pool holds what you have not got yet, and every sync strips Got it questions out
 * of it, so one cannot simply be put back. Its label has to be cleared first or the
 * question would appear to be added and then vanish on the next sync.
 */
describe("planning additions from the library", () => {
  it("adds questions that are not in the pool yet", () => {
    const plan = planMasteryAdditions([card("one"), card("two")], []);

    expect(plan.add).toEqual(["one", "two"]);
    expect(plan.alreadyPooled).toEqual([]);
    expect(plan.unretire).toEqual([]);
  });

  it("counts a question already in the pool rather than adding it twice", () => {
    const plan = planMasteryAdditions([card("pooled"), card("fresh")], ["pooled"]);

    expect(plan.add).toEqual(["fresh"]);
    expect(plan.alreadyPooled).toEqual(["pooled"]);
  });

  it("marks a Got it question for un-retiring, or the pool would shed it again", () => {
    const plan = planMasteryAdditions([card("known", MasteryRating.Easy), card("shaky", MasteryRating.Again)], []);

    expect(plan.add).toEqual(["known", "shaky"]);
    expect(plan.unretire).toEqual(["known"]);
  });

  it("un-retires a Got it question that is somehow already pooled", () => {
    // A pool clean would drop it on the next sync, so the label still has to go.
    const plan = planMasteryAdditions([card("known", MasteryRating.Easy)], ["known"]);

    expect(plan.add).toEqual([]);
    expect(plan.alreadyPooled).toEqual(["known"]);
    expect(plan.unretire).toEqual(["known"]);
  });

  it("leaves every other label alone", () => {
    const plan = planMasteryAdditions([card("unrated"), card("notYet", MasteryRating.Again), card("oldGood", MasteryRating.Good)], []);
    expect(plan.unretire).toEqual([]);
  });

  it("does nothing with an empty selection", () => {
    expect(planMasteryAdditions([], ["pooled"])).toEqual({ add: [], alreadyPooled: [], unretire: [] });
  });

  it("survives the plan then a pool clean, which is where the label matters", () => {
    const known = card("known", MasteryRating.Easy);
    const plan = planMasteryAdditions([known], []);
    // Without clearing the label the clean drops it straight back out.
    expect(cleanMasteryCardIds([known], plan.add)).toEqual([]);
    const cleared = { ...known, masteryRating: null };
    expect(cleanMasteryCardIds([cleared], plan.add)).toEqual(["known"]);
  });
});
