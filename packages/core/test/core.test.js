import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_FORMAT,
  createQuestionId,
  generateCards,
  makeCaptureBundle,
  normalizeWhitespace,
  parseCaptureBundle,
} from "../src/index.js";

const sample = {
  examCode: "exam-101",
  prompt: "Which service should you recommend?",
  choices: [
    { label: "A.", text: "Service Alpha" },
    { label: "B", text: "Service Beta" },
  ],
  correctAnswers: ["a"],
  sourceUrl: "https://questions.example/example",
};

test("normalizes whitespace without flattening intentional lines", () => {
  assert.equal(normalizeWhitespace("  one\n\n  two\u00a0 "), "one\ntwo");
});

test("question identity is stable across superficial whitespace", () => {
  assert.equal(createQuestionId(sample), createQuestionId({ ...sample, prompt: " Which   service should you recommend? " }));
});

test("bundle deduplicates repeated questions", () => {
  const bundle = makeCaptureBundle([sample, sample]);
  assert.equal(bundle.format, CAPTURE_FORMAT);
  assert.equal(bundle.questions.length, 1);
  assert.equal(bundle.warnings.length, 1);
});

test("uses a neutral exam code when capture metadata omits it", () => {
  const bundle = makeCaptureBundle([{ ...sample, examCode: "" }]);
  assert.equal(bundle.source.examCode, "UNSPECIFIED");
  assert.equal(bundle.questions[0].examCode, "UNSPECIFIED");
});

test("bundle parser rejects malformed files", () => {
  assert.throws(() => parseCaptureBundle({ format: "other", version: 1, questions: [] }), /Unsupported import format/);
  assert.throws(() => parseCaptureBundle({ format: CAPTURE_FORMAT, version: 99, questions: [] }), /Unsupported capture version/);
});

test("bundle parser preserves complete threaded discussion data", () => {
  const bundle = makeCaptureBundle([{
    ...sample,
    discussionCount: 2,
    discussion: {
      id: "discussion-1",
      title: "Question discussion",
      sourceUrl: sample.sourceUrl,
      isComplete: true,
      comments: [
        {
          id: "comment-1",
          author: "Ada",
          postedAt: "Sun 22 Sep 2024 10:20",
          selectedAnswers: ["a"],
          content: "Root comment",
          upvotes: 4,
        },
        {
          id: "comment-2",
          parentId: "comment-1",
          author: "Grace",
          content: "Reply",
          links: [{ text: "Reference", url: "https://example.test/reference" }],
        },
      ],
    },
  }]);

  assert.equal(bundle.questions[0].discussion.isComplete, true);
  assert.equal(bundle.questions[0].discussion.comments[1].parentId, "comment-1");
  assert.deepEqual(bundle.questions[0].discussion.comments[0].selectedAnswers, ["A"]);
  assert.deepEqual(bundle.questions[0].discussion.comments[1].links, [
    { text: "Reference", url: "https://example.test/reference" },
  ]);
});

test("missing discussion counts stay null", () => {
  assert.equal(makeCaptureBundle([sample]).questions[0].discussionCount, null);
});

test("card generation uses source answer and preserves choices", () => {
  const [card] = generateCards(sample);
  assert.match(card.front, /A\. Service Alpha/);
  assert.equal(card.back, "A. Service Alpha");
  assert.equal(card.confidence, "source-answer");
});

test("card generation marks an unrevealed answer", () => {
  const [card] = generateCards({ ...sample, correctAnswers: [] });
  assert.equal(card.confidence, "missing-answer");
  assert.match(card.back, /reveal the solution/i);
});

test("image questions remain importable without text choices", () => {
  const [card] = generateCards({
    examCode: "EXAM-101",
    prompt: "Complete the architecture shown.",
    choices: [],
    images: [
      { src: "https://example.test/question.png", role: "question" },
      { src: "https://example.test/answer.png", role: "answer" },
    ],
  });
  assert.equal(card.type, "image-question");
  assert.equal(card.questionImages.length, 1);
  assert.equal(card.answerImages.length, 1);
  assert.equal(card.confidence, "source-answer");
  assert.match(card.back, /answer image/i);
});

test("image answers ignore unmatched Box or Step heading letters", () => {
  const [card] = generateCards({
    examCode: "EXAM-101",
    prompt: "Complete the answer area.",
    choices: [],
    correctAnswers: ["B", "O", "X"],
    images: [{ src: "https://example.test/answer.png", role: "answer" }],
  });

  assert.equal(card.back, "See the captured answer image below.");
  assert.doesNotMatch(card.back, /B\nO\nX/);
});

test("embedded image data survives card generation and is distinct from unverified URL-only images", () => {
  const imageQuestion = {
    ...sample,
    images: [{
      src: "https://example.test/question.png",
      dataUrl: "data:image/png;base64,iVBORw==",
      role: "question",
    }],
  };
  const idWithoutEmbeddedBytes = createQuestionId({ ...imageQuestion, images: [{ src: imageQuestion.images[0].src, role: "question" }] });
  const [card] = generateCards(imageQuestion);

  assert.notEqual(createQuestionId(imageQuestion), idWithoutEmbeddedBytes);
  assert.equal(card.questionImages[0].dataUrl, imageQuestion.images[0].dataUrl);
});

test("non-image embedded payloads are discarded while the source URL remains", () => {
  const [card] = generateCards({
    ...sample,
    images: [{
      src: "https://example.test/question.png",
      dataUrl: "data:text/html;base64,PHNjcmlwdD4=",
      role: "question",
    }],
  });

  assert.equal(card.questionImages[0].dataUrl, "");
  assert.equal(card.questionImages[0].src, "https://example.test/question.png");
});


test("content dedup ignores supplied IDs but retains every answer variant", () => {
  const bundle = makeCaptureBundle([
    { ...sample, id: "one" }, { ...sample, id: "two", number: "99", sourceUrl: "elsewhere" },
    { ...sample, id: "one", correctAnswers: ["B"] },
    { ...sample, choices: [{ label: "A", text: "Different" }, sample.choices[1]] },
  ]);
  assert.equal(bundle.questions.length, 3);
  assert.equal(new Set(bundle.questions.map((q) => q.id)).size, 3);
  assert.equal(parseCaptureBundle(bundle).questions.length, 3);
});

test("case, choice order, explanations and discussion changes are content", () => {
  const variants = [
    sample, { ...sample, prompt: sample.prompt.toLowerCase() },
    { ...sample, choices: [...sample.choices].reverse() },
    { ...sample, explanation: "Extra explanation" },
    { ...sample, discussion: { comments: [{ id: "c", content: "Extra discussion" }] } },
    { ...sample, examCode: "OTHER" },
  ];
  assert.equal(makeCaptureBundle(variants).questions.length, variants.length);
});

test("images compare bytes when embedded and exact URLs otherwise, including role and alt", () => {
  const image = { src: "https://example.test/1", dataUrl: "data:image/png;base64,AA==", role: "question", alt: "diagram" };
  const withImage = (overrides) => ({ ...sample, images: [{ ...image, ...overrides }] });
  assert.equal(makeCaptureBundle([withImage({}), withImage({ src: "https://example.test/2" })]).questions.length, 1);
  for (const change of [{ dataUrl: "data:image/png;base64,BB==" }, { role: "answer" }, { alt: "different" }, { dataUrl: "" }]) {
    assert.equal(makeCaptureBundle([withImage({}), withImage(change)]).questions.length, 2);
  }
  assert.equal(makeCaptureBundle([withImage({ dataUrl: "" }), withImage({ dataUrl: "", src: "https://example.test/2" })]).questions.length, 2);
});

test("answer labels are sets and serialized fields cannot collide through delimiters", () => {
  assert.equal(createQuestionId({ ...sample, correctAnswers: ["A", "B"] }), createQuestionId({ ...sample, correctAnswers: ["B", "A"] }));
  assert.notEqual(createQuestionId({ ...sample, prompt: "x|y", examCode: "z" }), createQuestionId({ ...sample, prompt: "y", examCode: "z|x" }));
});
