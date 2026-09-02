// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  AUTO_PAGE_PREFIX,
  findNextPageUrl,
  mergeStoredAutoPages,
  waitForPageReady,
} from "../src/automation.js";

function question(number, discussion = null) {
  return {
    examCode: "AZ-305",
    sourceUrl: `https://questions.example/exams/microsoft/az-305/view/${number}/`,
    number: String(number),
    prompt: `Question ${number}`,
    choices: [{ label: "A", text: "One" }, { label: "B", text: "Two" }],
    correctAnswers: ["A"],
    discussionCount: discussion?.comments.length ?? null,
    discussion,
  };
}

describe("automatic page capture", () => {
  it("moves from the unnumbered first exam page to page 2", () => {
    document.body.innerHTML = `
      <a class="btn btn-success pull-right" href="/exams/amazon/saa-c03/view/2/">Wrong exam</a>
      <div class="nextBtn"><a href="/exams/microsoft/az-305/view/2/">Next Questions</a></div>`;

    expect(findNextPageUrl(document, "https://questions.example/exams/microsoft/az-305/view/")).toBe(
      "https://questions.example/exams/microsoft/az-305/view/2/",
    );
  });

  it("stops when no forward next-page link exists", () => {
    document.body.innerHTML = `<a href="/exams/microsoft/az-305/view/1/">Previous Questions</a>`;
    expect(findNextPageUrl(document, "https://questions.example/exams/microsoft/az-305/view/2/")).toBeNull();
  });

  it("waits for a stable question page before capture", async () => {
    document.body.innerHTML = `<main></main>`;
    window.scrollTo = vi.fn();
    const ready = waitForPageReady(document, { timeoutMs: 100, quietMs: 1, scrollDelayMs: 0 });
    document.querySelector("main").insertAdjacentHTML("beforeend", `
      <article class="exam-question-card"><div class="question-body">Loaded question</div></article>`);

    await expect(ready).resolves.toMatchObject({ cards: 1, images: 0, incompleteImages: 0 });
  });

  it("merges stored pages without losing discussion threads", async () => {
    const discussion = {
      id: "42",
      title: "Question discussion",
      sourceUrl: "https://questions.example/exams/microsoft/az-305/view/1/",
      isComplete: true,
      comments: [{ id: "1", parentId: null, author: "Ada", content: "Root", upvotes: 2 }],
    };
    const values = {
      [`${AUTO_PAGE_PREFIX}run:000001`]: {
        source: { provider: "questions.example", examCode: "AZ-305", pageUrl: "https://questions.example/exams/microsoft/az-305/view/2/" },
        questions: [question(2)],
        warnings: [],
      },
      [`${AUTO_PAGE_PREFIX}run:000000`]: {
        source: { provider: "questions.example", examCode: "AZ-305", pageUrl: "https://questions.example/exams/microsoft/az-305/view/1/" },
        questions: [question(1, discussion)],
        warnings: ["page warning"],
      },
    };
    const storage = { get: vi.fn().mockResolvedValue(values) };
    const bundle = await mergeStoredAutoPages(storage, {
      runId: "run",
      startUrl: "https://questions.example/exams/microsoft/az-305/view/1/",
    });

    expect(bundle.questions).toHaveLength(2);
    expect(bundle.questions[0].discussion.comments[0]).toMatchObject({ id: "1", author: "Ada", upvotes: 2 });
    expect(bundle.capture).toMatchObject({ automatic: true, pages: 2, discussions: { comments: 1, incomplete: 0 } });
    expect(bundle.warnings).toContain("page warning");
  });
});
