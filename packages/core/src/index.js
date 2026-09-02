export const CAPTURE_FORMAT = "crambot.exam-capture";
export const CAPTURE_VERSION = 1;

export function normalizeWhitespace(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n+/g, "\n")
    .trim();
}

export function stableHash(value) {
  const text = String(value ?? "");
  let first = 0xdeadbeef ^ text.length;
  let second = 0x41c6ce57 ^ text.length;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }

  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return `${(second >>> 0).toString(16).padStart(8, "0")}${(first >>> 0).toString(16).padStart(8, "0")}`;
}

export function createQuestionId(question) {
  const choices = (question.choices ?? [])
    .map((choice) => `${choice.label}:${normalizeWhitespace(choice.text).toLowerCase()}`)
    .join("|");
  const images = (question.images ?? [])
    .map((image) => `${normalizeWhitespace(image.role)}:${normalizeWhitespace(image.src)}`)
    .join("|");
  const identity = [
    normalizeWhitespace(question.examCode).toUpperCase(),
    normalizeWhitespace(question.prompt).toLowerCase(),
    choices,
    images,
  ].join("|");
  return `q_${stableHash(identity)}`;
}

function uniqueLabels(values) {
  return [...new Set((values ?? []).map((value) => normalizeWhitespace(value).toUpperCase()).filter((value) => /^[A-Z]$/.test(value)))];
}

function sanitizeDiscussion(input) {
  if (!input || typeof input !== "object") return null;

  const comments = (Array.isArray(input.comments) ? input.comments : [])
    .map((comment) => {
      if (!comment || typeof comment !== "object") return null;
      const content = normalizeWhitespace(comment.content);
      const author = normalizeWhitespace(comment.author);
      const postedAt = normalizeWhitespace(comment.postedAt);
      const id = normalizeWhitespace(comment.id)
        || `comment_${stableHash([author, postedAt, content].join("|"))}`;
      if (!content) return null;
      return {
        id,
        parentId: normalizeWhitespace(comment.parentId) || null,
        author,
        authorUrl: normalizeWhitespace(comment.authorUrl),
        postedAt,
        relativeTime: normalizeWhitespace(comment.relativeTime),
        selectedAnswers: uniqueLabels(comment.selectedAnswers),
        content,
        links: (Array.isArray(comment.links) ? comment.links : [])
          .map((link) => ({
            text: normalizeWhitespace(link?.text),
            url: normalizeWhitespace(link?.url),
          }))
          .filter((link) => link.url),
        upvotes: Number.isInteger(Number(comment.upvotes)) && Number(comment.upvotes) >= 0
          ? Number(comment.upvotes)
          : 0,
        badges: [...new Set((Array.isArray(comment.badges) ? comment.badges : [])
          .map(normalizeWhitespace)
          .filter(Boolean))],
      };
    })
    .filter(Boolean);
  const commentIds = new Set(comments.map((comment) => comment.id));
  for (const comment of comments) {
    if (comment.parentId === comment.id || !commentIds.has(comment.parentId)) comment.parentId = null;
  }

  return {
    id: normalizeWhitespace(input.id),
    title: normalizeWhitespace(input.title),
    sourceUrl: normalizeWhitespace(input.sourceUrl),
    isComplete: input.isComplete === true,
    comments,
  };
}

export function sanitizeQuestion(input, fallback = {}) {
  if (!input || typeof input !== "object") {
    throw new TypeError("Question must be an object.");
  }

  const choices = [];
  const seenLabels = new Set();
  for (const rawChoice of Array.isArray(input.choices) ? input.choices : []) {
    const label = normalizeWhitespace(rawChoice?.label).replace(/[.)]+$/, "").toUpperCase();
    const text = normalizeWhitespace(rawChoice?.text);
    if (!/^[A-Z]$/.test(label) || !text || seenLabels.has(label)) continue;
    seenLabels.add(label);
    choices.push({ label, text });
  }

  const prompt = normalizeWhitespace(input.prompt);
  const images = (Array.isArray(input.images) ? input.images : [])
    .map((image) => ({
      src: normalizeWhitespace(image?.src),
      alt: normalizeWhitespace(image?.alt),
      role: image?.role === "answer" ? "answer" : "question",
      dataUrl: /^data:image\/[a-z0-9.+-]+;base64,/i.test(image?.dataUrl || "") ? String(image.dataUrl) : "",
    }))
    .filter((image) => image.src);
  if (!prompt) throw new TypeError("Question prompt is required.");
  if (choices.length < 2 && images.length === 0) throw new TypeError("At least two answer choices or one question image are required.");

  const question = {
    id: normalizeWhitespace(input.id),
    examCode: normalizeWhitespace(input.examCode || fallback.examCode || "UNSPECIFIED").toUpperCase(),
    sourceUrl: normalizeWhitespace(input.sourceUrl || fallback.sourceUrl),
    topic: normalizeWhitespace(input.topic),
    number: normalizeWhitespace(input.number),
    prompt,
    choices,
    correctAnswers: uniqueLabels(input.correctAnswers),
    mostVotedAnswers: uniqueLabels(input.mostVotedAnswers),
    voteDistribution: (Array.isArray(input.voteDistribution) ? input.voteDistribution : [])
      .map((vote) => ({
        label: normalizeWhitespace(vote?.label).toUpperCase(),
        percent: Number(vote?.percent),
      }))
      .filter((vote) => /^[A-Z]$/.test(vote.label) && Number.isFinite(vote.percent) && vote.percent >= 0 && vote.percent <= 100),
    explanation: normalizeWhitespace(input.explanation),
    discussionCount: input.discussionCount !== null
      && input.discussionCount !== ""
      && Number.isInteger(Number(input.discussionCount))
      ? Number(input.discussionCount)
      : null,
    discussion: sanitizeDiscussion(input.discussion),
    images,
    capturedAt: normalizeWhitespace(input.capturedAt || fallback.capturedAt || new Date().toISOString()),
  };

  question.id = question.id || createQuestionId(question);
  return question;
}

export function makeCaptureBundle(questions, metadata = {}) {
  const warnings = [];
  const unique = new Map();

  for (const input of questions ?? []) {
    try {
      const question = sanitizeQuestion(input, metadata);
      if (unique.has(question.id)) {
        warnings.push(`Skipped duplicate question ${question.id}.`);
      } else {
        unique.set(question.id, question);
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    exportedAt: normalizeWhitespace(metadata.exportedAt || new Date().toISOString()),
    source: {
      provider: normalizeWhitespace(metadata.provider || "Unspecified"),
      examCode: normalizeWhitespace(metadata.examCode || "UNSPECIFIED").toUpperCase(),
      pageUrl: normalizeWhitespace(metadata.sourceUrl || metadata.pageUrl),
    },
    questions: [...unique.values()],
    warnings,
  };
}

export function parseCaptureBundle(input) {
  if (!input || typeof input !== "object") throw new TypeError("Import must be a JSON object.");
  if (input.format !== CAPTURE_FORMAT) throw new TypeError(`Unsupported import format: ${String(input.format ?? "missing")}.`);
  if (input.version !== CAPTURE_VERSION) throw new TypeError(`Unsupported capture version: ${String(input.version ?? "missing")}.`);
  if (!Array.isArray(input.questions)) throw new TypeError("Import is missing its questions array.");

  const bundle = makeCaptureBundle(input.questions, {
    provider: input.source?.provider,
    examCode: input.source?.examCode,
    sourceUrl: input.source?.pageUrl,
    exportedAt: input.exportedAt,
  });
  bundle.warnings = [...(Array.isArray(input.warnings) ? input.warnings.map(normalizeWhitespace).filter(Boolean) : []), ...bundle.warnings];
  return bundle;
}

export function generateCards(question) {
  const clean = sanitizeQuestion(question);
  const answerLabels = clean.correctAnswers.length ? clean.correctAnswers : clean.mostVotedAnswers;
  const choiceText = clean.choices.map((choice) => `${choice.label}. ${choice.text}`).join("\n");
  const questionImages = clean.images.filter((image) => image.role === "question");
  const answerImages = clean.images.filter((image) => image.role === "answer");
  const answerText = answerLabels
    .map((label) => {
      const choice = clean.choices.find((candidate) => candidate.label === label);
      return choice ? `${label}. ${choice.text}` : answerImages.length ? "" : label;
    })
    .filter(Boolean)
    .join("\n");
  const confidence = clean.correctAnswers.length || answerImages.length
    ? "source-answer"
    : clean.mostVotedAnswers.length
      ? "community-only"
      : "missing-answer";
  const fallbackAnswer = answerImages.length
    ? "See the captured answer image below."
    : "Answer not captured — reveal the solution and capture this question again.";

  return [{
    id: `${clean.id}_mcq`,
    questionId: clean.id,
    type: clean.choices.length ? "multiple-choice" : "image-question",
    front: choiceText ? `${clean.prompt}\n\n${choiceText}` : clean.prompt,
    back: answerText || fallbackAnswer,
    questionImages,
    answerImages,
    explanation: clean.explanation,
    tags: [clean.examCode, clean.topic].filter(Boolean),
    confidence,
    sourceUrl: clean.sourceUrl,
    createdAt: clean.capturedAt,
  }];
}
