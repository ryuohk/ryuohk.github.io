// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { prepareImport } from "../../web/src/importer";
import {
  capturePage,
  embedQuestionImages,
  fetchQuestionDiscussions,
  findQuestionCards,
  parseDiscussionDocument,
  parseQuestionCard,
  revealQuestionCards,
} from "../src/parser.js";

function fixture({ revealed = false } = {}) {
  document.title = "DP-203 Exam Questions";
  document.body.innerHTML = `
    <article class="card exam-question-card">
      <header class="card-header">Question #7 <span>Topic 2</span></header>
      <div class="card-body question-body">
        <div class="card-text">A system requires private connectivity. What should you recommend?</div>
        <div class="question-choices-container">
          <div class="question-choices-row">A. Public endpoint</div>
          <div class="question-choices-row">B. Private endpoint ${revealed ? "<b>Most Voted</b>" : ""}</div>
        </div>
        ${revealed ? `<button>Hide Solution</button><div class="question-answer">Correct Answer: B <span>B (100%)</span></div>` : `<button id="reveal">Reveal Solution</button>`}
        <button>Discussion 12</button>
      </div>
    </article>`;
  return document.querySelector(".exam-question-card");
}

describe("question page parser", () => {
  it("finds a known question card", () => {
    fixture();
    expect(findQuestionCards(document)).toHaveLength(1);
  });

  it("keeps line breaks from paragraphs, breaks and lists in the prompt", () => {
    // textContent alone runs these together into one unreadable paragraph, which is
    // what turned captured case studies into a wall of text.
    document.title = "AZ-305 Exam Questions";
    document.body.innerHTML = `
      <article class="card exam-question-card">
        <header class="card-header">Question #1 <span>Topic 1</span></header>
        <div class="card-body question-body">
          <p>Overview -</p>
          <p>Contoso operates two datacenters.</p>
          <div>Line one<br>Line two</div>
          <ul><li>First requirement</li><li>Second requirement</li></ul>
          <div class="question-choices-container">
            <div class="question-choices-row">A. Alpha</div>
            <div class="question-choices-row">B. Beta</div>
          </div>
        </div>
      </article>`;
    const card = document.querySelector(".exam-question-card");
    const question = parseQuestionCard(card, "https://questions.example/exams/microsoft/az-305/view/1/");

    expect(question.prompt).toContain("Overview -\nContoso operates two datacenters.");
    expect(question.prompt).toContain("Line one\nLine two");
    expect(question.prompt).toContain("First requirement\nSecond requirement");
    // Choices still stripped out of the prompt despite the new line breaks.
    expect(question.prompt).not.toContain("Alpha");
    expect(question.choices).toEqual([
      { label: "A", text: "Alpha" },
      { label: "B", text: "Beta" },
    ]);
  });

  it("parses a revealed card", () => {
    const card = fixture({ revealed: true });
    const question = parseQuestionCard(card, "https://questions.example/exams/microsoft/dp-203/view/1/");
    expect(question.examCode).toBe("DP-203");
    expect(question.number).toBe("7");
    expect(question.topic).toBe("Topic 2");
    expect(question.choices).toEqual([
      { label: "A", text: "Public endpoint" },
      { label: "B", text: "Private endpoint" },
    ]);
    expect(question.correctAnswers).toEqual(["B"]);
    expect(question.mostVotedAnswers).toEqual(["B"]);
    expect(question.voteDistribution).toContainEqual({ label: "B", percent: 100 });
    expect(question.discussionCount).toBe(12);
  });

  it("preserves discussion authorship, votes, links, and reply threading", () => {
    document.body.innerHTML = `
      <div class="outer-discussion-container">
        <div class="new-comment-box" data-discussion-id="67502" data-title="Exam DP-203 topic 2 question 7 discussion"></div>
        <div class="comment-container" data-comment-id="100">
          <div class="media-body">
            <div class="comment-head">
              <a href="/user/Ada/"><span class="comment-username">Ada</span></a>
              <span class="badge">Highly Voted</span>
              <span class="comment-date" title="Sun 22 Sep 2024 10:20">1 year ago</span>
            </div>
            <div class="comment-body">
              <div class="comment-selected-answers">Selected Answer: <strong>AB</strong></div>
              <div class="comment-content">First line<br>Second line <a href="https://learn.example/doc">source</a></div>
              <div class="comment-control"><span class="upvote-count">22</span></div>
              <div class="comment-replies">
                <div class="comment-container" data-comment-id="101">
                  <div class="media-body">
                    <div class="comment-head"><span class="comment-username">Grace</span></div>
                    <div class="comment-body">
                      <div class="comment-content">Nested reply</div>
                      <div class="comment-control"><span class="upvote-count">3</span></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    const discussion = parseDiscussionDocument(document, "https://questions.example/exams/microsoft/dp-203/view/1/");
    expect(discussion).toMatchObject({
      id: "67502",
      title: "Exam DP-203 topic 2 question 7 discussion",
      isComplete: true,
    });
    expect(discussion.comments).toHaveLength(2);
    expect(discussion.comments[0]).toMatchObject({
      id: "100",
      parentId: null,
      author: "Ada",
      authorUrl: "https://questions.example/user/Ada/",
      postedAt: "Sun 22 Sep 2024 10:20",
      selectedAnswers: ["A", "B"],
      content: "First line\nSecond line source",
      upvotes: 22,
      badges: ["Highly Voted"],
    });
    expect(discussion.comments[0].links).toEqual([{ text: "source", url: "https://learn.example/doc" }]);
    expect(discussion.comments[1]).toMatchObject({ id: "101", parentId: "100", author: "Grace", upvotes: 3 });
  });

  it("loads the complete discussion when the site returns a truncated preview", async () => {
    document.body.innerHTML = `
      <article class="exam-question-card">
        <div class="question-body" data-id="804641">
          <a class="question-discussion-button">Discussion 33</a>
        </div>
      </article>`;
    const requests = [];
    const fetchDiscussion = async (url, init) => {
      requests.push({ url, init });
      const full = url.includes("load-complete");
      return new Response(`
        <div class="outer-discussion-container">
          <div class="new-comment-box" data-discussion-id="67502" data-title="Question discussion"></div>
          <div class="comment-container" data-comment-id="${full ? "2" : "1"}">
            <div class="media-body"><div class="comment-head"><span class="comment-username">User</span></div>
            <div class="comment-body"><div class="comment-content">${full ? "Complete" : "Preview"}</div></div></div>
          </div>
          ${full ? "" : `<div class="load-more-section"><a class="load-full-discussion-button">Load full discussion</a></div>`}
        </div>`, { status: 200, headers: { "content-type": "text/html" } });
    };

    const result = await fetchQuestionDiscussions(
      [document.querySelector(".exam-question-card")],
      "https://questions.example/exams/microsoft/dp-203/view/1/",
      fetchDiscussion,
    );
    expect(requests.map((request) => request.url)).toEqual([
      "https://questions.example/ajax/discussion/exam-question/804641/",
      "https://questions.example/ajax/discussion/load-complete/?discussion-id=67502",
    ]);
    expect(requests.every((request) => request.init.credentials === "include")).toBe(true);
    expect(result).toMatchObject({ requested: 1, fetched: 1, comments: 1, failures: [] });
    expect(result.discussions[0]).toMatchObject({ isComplete: true, comments: [{ id: "2", content: "Complete" }] });
  });

  it("reports each complete question and discussion pair before an interruption", async () => {
    document.title = "AZ-305 Exam Questions";
    document.body.innerHTML = [1, 2].map((number) => `
      <article class="exam-question-card">
        <header>Question #${number} Topic 1</header>
        <div class="question-body" data-id="${800000 + number}">
          <p class="question-text">Question prompt ${number}</p>
          <div class="question-choices-container">
            <div class="question-choices-row">A. First answer</div>
            <div class="question-choices-row">B. Second answer</div>
          </div>
          <div class="question-answer">Correct Answer: A</div>
          <a class="question-discussion-button">Discussion 1</a>
        </div>
      </article>`).join("");
    const fetchDiscussion = async (url, init) => {
      init.signal?.throwIfAborted();
      const questionId = url.match(/(\d+)\/$/)?.[1];
      return new Response(`
        <div class="outer-discussion-container">
          <div class="new-comment-box" data-discussion-id="discussion-${questionId}" data-title="Question discussion"></div>
          <div class="comment-container" data-comment-id="comment-${questionId}">
            <div class="media-body"><div class="comment-head"><span class="comment-username">User</span></div>
            <div class="comment-body"><div class="comment-content">Complete comment ${questionId}</div></div></div>
          </div>
        </div>`, { status: 200, headers: { "content-type": "text/html" } });
    };
    const controller = new AbortController();
    const completed = [];

    await expect(capturePage(
      document,
      "https://questions.example/exams/microsoft/az-305/view/",
      {
        embedImages: false,
        fetchDiscussion,
        signal: controller.signal,
        requireCompleteDiscussions: true,
        onQuestionCaptured: (question) => {
          completed.push(question);
          controller.abort(new DOMException("Stopped", "AbortError"));
        },
      },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(completed).toHaveLength(1);
    expect(completed[0].discussion).toMatchObject({
      isComplete: true,
      comments: [{ content: "Complete comment 800001" }],
    });
  });

  it("clicks reveal and waits for the answer mutation", async () => {
    const card = fixture();
    document.querySelector("#reveal").addEventListener("click", (event) => {
      event.currentTarget.textContent = "Hide Solution";
      card.insertAdjacentHTML("beforeend", `<div class="question-answer">Correct Answer: B</div>`);
    });
    const result = await revealQuestionCards([card], 100);
    expect(result).toEqual({ requested: 1, revealed: 1, timedOut: 0 });
  });

  it("reports a reveal timeout without inventing an answer", async () => {
    const card = fixture();
    const result = await revealQuestionCards([card], 5);
    expect(result.timedOut).toBe(1);
    expect(parseQuestionCard(card, "https://example.test").correctAnswers).toEqual([]);
  });

  it("does not treat a Hide Solution label as proof that the answer loaded", async () => {
    const card = fixture();
    document.querySelector("#reveal").addEventListener("click", (event) => {
      event.currentTarget.textContent = "Hide Solution";
    });
    const result = await revealQuestionCards([card], 5);
    expect(result.timedOut).toBe(1);
  });

  it("parses contiguous multi-answer labels", () => {
    const card = fixture({ revealed: true });
    card.querySelector(".question-answer").textContent = "Correct Answer: AB";
    expect(parseQuestionCard(card, "https://example.test").correctAnswers).toEqual(["A", "B"]);
  });

  it("does not parse Box headings as answer-choice labels for an image solution", () => {
    const card = fixture({ revealed: true });
    card.querySelector(".question-choices-container").innerHTML = "";
    card.querySelector(".question-answer").innerHTML = `Correct Answer: Box 1: Service <img src="/answer.png" alt="Completed answer area">`;

    expect(parseQuestionCard(card, "https://example.test").correctAnswers).toEqual([]);
  });

  it("preserves image-only choices and marks solution images", () => {
    const card = fixture({ revealed: true });
    card.querySelector(".question-choices-container").innerHTML = `
      <div class="question-choices-row">A. <img src="/a.png" alt="Architecture A"></div>
      <div class="question-choices-row">B. <img src="/b.png" alt="Architecture B"></div>`;
    card.querySelector(".question-answer").innerHTML = `Correct Answer: B <img src="/answer.png" alt="Solved architecture">`;
    const question = parseQuestionCard(card, "https://questions.example/example");
    expect(question.choices).toEqual([
      { label: "A", text: "Architecture A" },
      { label: "B", text: "Architecture B" },
    ]);
    expect(question.images.find((image) => image.src.endsWith("answer.png"))?.role).toBe("answer");
  });

  it("prefers a lazy-loaded image source over its placeholder", () => {
    const card = fixture({ revealed: true });
    card.querySelector(".question-body").insertAdjacentHTML(
      "afterbegin",
      `<img src="/placeholder.gif" data-src="/architecture.png" alt="Architecture">`,
    );

    const question = parseQuestionCard(card, "https://questions.example/example");
    expect(question.images[0].src).toBe("https://questions.example/architecture.png");
  });

  it("embeds image bytes while retaining the stable source URL", async () => {
    const questions = [{ images: [{ src: "https://example.test/diagram.png", alt: "Diagram", role: "question" }] }];
    const fetchImage = async () => new Response(Uint8Array.from([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

    const result = await embedQuestionImages(questions, fetchImage);
    expect(result.embedded).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.questions[0].images[0].src).toBe("https://example.test/diagram.png");
    expect(result.questions[0].images[0].dataUrl).toBe("data:image/png;base64,iVBORw==");
  });

  it("records the provider as the page's own host rather than a hardcoded site", async () => {
    fixture({ revealed: true });
    const bundle = await capturePage(document, "https://www.questions.example/exams/microsoft/dp-203/view/1/", {
      embedImages: false,
    });

    expect(bundle.source.provider).toBe("questions.example");
  });

  it("keeps the remote URL and reports a warning when image embedding fails", async () => {
    const card = fixture({ revealed: true });
    card.querySelector(".question-body").insertAdjacentHTML("afterbegin", `<img src="/protected.png" alt="Protected diagram">`);
    const bundle = await capturePage(document, "https://questions.example/example", {
      fetchImage: async () => new Response("Forbidden", { status: 403 }),
    });

    expect(bundle.questions[0].images[0]).toMatchObject({ src: "https://questions.example/protected.png", dataUrl: "" });
    expect(bundle.capture.images).toEqual({ found: 1, embedded: 0, failed: 1 });
    expect(bundle.warnings).toContainEqual(expect.stringMatching(/Could not embed image.*403/));
  });

  it("rejects a successful response that is not actually an image", async () => {
    const questions = [{ images: [{ src: "https://example.test/login", role: "question" }] }];
    const result = await embedQuestionImages(questions, async () => new Response("Sign in", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    expect(result.embedded).toBe(0);
    expect(result.failures[0].error).toMatch(/text\/html/);
    expect(result.questions[0].images[0].dataUrl).toBeUndefined();
  });

  it("counts an existing image data URL as already embedded", async () => {
    const questions = [{ images: [{ src: "data:image/png;base64,iVBORw==", role: "question" }] }];
    const result = await embedQuestionImages(questions);
    expect(result.embedded).toBe(1);
    expect(result.questions[0].images[0].dataUrl).toBe(questions[0].images[0].src);
  });

  it("captures a page after revealing and emits a valid bundle", async () => {
    const card = fixture();
    document.querySelector("#reveal").addEventListener("click", (event) => {
      event.currentTarget.textContent = "Hide Solution";
      card.insertAdjacentHTML("beforeend", `<div class="question-answer">Correct Answer: B</div>`);
    });
    const bundle = await capturePage(document, "https://questions.example/example", { revealTimeoutMs: 100 });
    expect(bundle.questions).toHaveLength(1);
    expect(bundle.questions[0].correctAnswers).toEqual(["B"]);
  });

  it("hands extension output to the study app without reshaping", async () => {
    const card = fixture();
    document.querySelector("#reveal").addEventListener("click", (event) => {
      event.currentTarget.textContent = "Hide Solution";
      card.insertAdjacentHTML("beforeend", `<div class="question-answer">Correct Answer: B</div>`);
    });
    const bundle = await capturePage(document, "https://questions.example/example", { revealTimeoutMs: 100 });
    const imported = prepareImport(bundle, [], new Date("2026-08-28T12:00:00Z"));
    expect(imported.cards).toHaveLength(1);
    expect(imported.cards[0].back).toBe("B. Private endpoint");
    expect(imported.cards[0].masteryRating).toBeNull();
  });

  it("fails clearly when no cards exist", async () => {
    document.body.innerHTML = "<main>Not an exam page</main>";
    await expect(capturePage(document, "https://questions.example/example")).rejects.toThrow(/No question cards/);
  });
});
