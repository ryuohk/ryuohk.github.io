import { makeCaptureBundle, normalizeWhitespace } from "@crambot/core";

const CARD_SELECTORS = [
  ".exam-question-card",
  "[data-question-id]",
  ".question-card",
  "article.question",
];

const CHOICE_SELECTORS = [
  ".question-choices-row",
  ".question-choice",
  "[data-choice]",
  ".choices .choice",
];

const REVEAL_PATTERN = /^reveal\s+solution$/i;

function text(element) {
  return normalizeWhitespace(element?.textContent);
}

function uniqueElements(elements) {
  return [...new Set(elements)].filter((candidate) => !elements.some((other) => other !== candidate && other.contains(candidate)));
}

export function findQuestionCards(documentRoot = document) {
  const direct = CARD_SELECTORS.flatMap((selector) => [...documentRoot.querySelectorAll(selector)]);
  if (direct.length) return uniqueElements(direct);

  const headers = [...documentRoot.querySelectorAll("h1, h2, h3, h4, header, .card-header, [class*='header']")]
    .filter((element) => /question\s*#?\s*\d+/i.test(text(element)));

  const cards = headers
    .map((header) => header.closest("article, .card, section, [class*='question']") || header.parentElement)
    .filter(Boolean);
  return uniqueElements(cards);
}

function findRevealControls(card) {
  return [...card.querySelectorAll("button, a, [role='button']")].filter((element) => REVEAL_PATTERN.test(text(element)));
}

function hasRevealedAnswer(card) {
  const answerArea = card.querySelector(".question-answer, .correct-answer, [data-correct-answer], .solution, .answer-area");
  return /correct\s+answer\s*:/i.test(text(card)) || Boolean(answerArea?.querySelector("img"));
}

function waitForReveal(card, timeoutMs, signal) {
  if (hasRevealedAnswer(card)) return Promise.resolve(true);
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const observer = new MutationObserver(() => {
      if (hasRevealedAnswer(card)) finish(true);
    });
    const cleanup = () => {
      observer.disconnect();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };
    observer.observe(card, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(hasRevealedAnswer(card)), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function revealQuestionCards(cards, timeoutMs = 4000, options = {}) {
  const pending = [];
  for (const card of cards) {
    const controls = findRevealControls(card);
    if (!controls.length) continue;
    pending.push(waitForReveal(card, timeoutMs, options.signal));
    controls[0].click();
  }
  const results = await Promise.all(pending);
  return {
    requested: pending.length,
    revealed: results.filter(Boolean).length,
    timedOut: results.filter((result) => !result).length,
  };
}

function parseChoiceElement(element) {
  const raw = text(element);
  const explicitLabel = normalizeWhitespace(element.getAttribute("data-choice") || element.querySelector("[data-choice-label]")?.getAttribute("data-choice-label"));
  const match = raw.match(/^\s*([A-Z])\s*[.)]\s*(.+)$/is);
  const labelOnlyMatch = raw.match(/^\s*([A-Z])\s*[.)]?\s*$/i);
  const label = (explicitLabel || match?.[1] || labelOnlyMatch?.[1] || "").replace(/[.)]/g, "").toUpperCase();
  let choiceText = match?.[2] || (labelOnlyMatch ? element.querySelector("img")?.alt || "Image answer choice" : raw);
  choiceText = choiceText.replace(/\bMost Voted\b/gi, "").trim();
  return /^[A-Z]$/.test(label) && choiceText ? { label, text: choiceText } : null;
}

function parseChoices(card) {
  let elements = CHOICE_SELECTORS.flatMap((selector) => [...card.querySelectorAll(selector)]);
  if (!elements.length) {
    elements = [...card.querySelectorAll("li, p, div")].filter((element) => /^\s*[A-Z]\s*[.)]\s+\S/.test(text(element)));
  }

  const choices = new Map();
  for (const element of elements) {
    const choice = parseChoiceElement(element);
    if (choice && !choices.has(choice.label)) choices.set(choice.label, choice);
  }
  return [...choices.values()];
}

function parsePrompt(card, choices) {
  const preferred = card.querySelector(".question-body, .question-text, [data-question-text], .card-body") || card;
  const clone = preferred.cloneNode(true);
  const removalSelectors = [
    ...CHOICE_SELECTORS,
    ".question-choices-container",
    ".question-answer",
    ".correct-answer",
    ".solution",
    ".answer-description",
    ".reveal-solution",
    ".hide-solution",
    ".question-discussion-button",
    ".vote-answer-button",
    "button",
    "[role='button']",
  ];
  for (const selector of removalSelectors) clone.querySelectorAll(selector).forEach((element) => element.remove());

  // Break-aware: plain textContent runs paragraphs together, turning a case study
  // into one unreadable wall of text. Block elements become line breaks instead.
  let prompt = textWithBreaks(clone);
  for (const choice of choices) {
    // Choice text is extracted without breaks, so match whitespace loosely; a choice
    // spanning a <br> would otherwise fail to strip and be duplicated in the prompt.
    const loose = escapeRegExp(choice.text).replace(/\s+/g, "\\s+");
    prompt = prompt.replace(new RegExp(`${choice.label}\\s*[.)]\\s*${loose}`, "i"), "");
  }
  prompt = prompt
    .replace(/question\s*#?\s*\d+/gi, "")
    .replace(/topic\s*\d+/gi, "")
    .replace(/discussion\s*\d*/gi, "")
    .replace(/hide\s+solution/gi, "")
    .replace(/reveal\s+solution/gi, "")
    .trim();
  return normalizeWhitespace(prompt);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseAnswerLabels(card, choices) {
  const answerArea = card.querySelector(".question-answer, .correct-answer, [data-correct-answer], .solution") || card;
  const match = text(answerArea).match(/correct\s+answer\s*:\s*([A-Z]{1,8}(?:\s*[,/&+]\s*[A-Z]{1,8})*)/i);
  const labels = match ? match[1].match(/[A-Z]/gi).map((label) => label.toUpperCase()) : [];
  if (answerArea.querySelector("img") && choices.length === 0) return [];
  if (choices.length) {
    const validLabels = new Set(choices.map((choice) => choice.label));
    return labels.filter((label) => validLabels.has(label));
  }
  return labels;
}

function parseMostVoted(card, choices) {
  const labels = [];
  for (const choice of choices) {
    const choiceElement = CHOICE_SELECTORS
      .flatMap((selector) => [...card.querySelectorAll(selector)])
      .find((element) => parseChoiceElement(element)?.label === choice.label);
    if (choiceElement && /most voted/i.test(text(choiceElement))) labels.push(choice.label);
  }
  return [...new Set(labels)];
}

function parseVotes(card) {
  const votes = [];
  const pattern = /\b([A-Z])\s*\(\s*(\d{1,3}(?:\.\d+)?)\s*%\s*\)/gi;
  for (const match of text(card).matchAll(pattern)) {
    const percent = Number(match[2]);
    if (percent <= 100) votes.push({ label: match[1].toUpperCase(), percent });
  }
  return votes;
}

function parseExplanation(card) {
  const element = card.querySelector(".answer-description, .solution-description, .answer-explanation, [data-explanation]");
  return textWithBreaks(element);
}

function textWithBreaks(element) {
  if (!element) return "";
  const clone = element.cloneNode(true);
  clone.querySelectorAll("br").forEach((breakElement) => breakElement.replaceWith("\n"));
  clone.querySelectorAll("p, div, li, pre, blockquote").forEach((block) => block.append("\n"));
  return normalizeWhitespace(clone.textContent);
}

function directCommentPart(comment, selector) {
  return comment.querySelector(`:scope > .media-body > ${selector}`);
}

function parseSelectedAnswers(element) {
  if (!element) return [];
  const emphasized = [...element.querySelectorAll("strong")]
    .flatMap((label) => text(label).toUpperCase().match(/[A-Z]/g) || []);
  if (emphasized.length) return [...new Set(emphasized)];

  const value = text(element).replace(/^.*?selected\s+answer\s*:\s*/i, "").toUpperCase();
  const labels = (value.match(/\b[A-Z]{1,8}\b/g) || [])
    .filter((token) => token !== "AND" && token !== "OR")
    .flatMap((token) => [...token]);
  return [...new Set(labels)];
}

export function parseDiscussionDocument(documentRoot, pageUrl) {
  const container = documentRoot.querySelector(".outer-discussion-container") || documentRoot;
  const metadata = container.querySelector(".new-comment-box[data-discussion-id]");
  const comments = [...container.querySelectorAll(".comment-container[data-comment-id]")].map((comment) => {
    const head = directCommentPart(comment, ".comment-head");
    const body = directCommentPart(comment, ".comment-body");
    const content = body?.querySelector(":scope > .comment-content");
    const selectedAnswers = parseSelectedAnswers(body?.querySelector(":scope > .comment-selected-answers"));
    const parent = comment.parentElement?.closest(".comment-container[data-comment-id]");
    const date = head?.querySelector(".comment-date");
    const authorLink = head?.querySelector(".comment-username")?.closest("a");
    return {
      id: comment.getAttribute("data-comment-id") || comment.id.replace(/^comment-/, ""),
      parentId: parent?.getAttribute("data-comment-id") || null,
      author: text(head?.querySelector(".comment-username")),
      authorUrl: authorLink?.getAttribute("href") ? absoluteUrl(authorLink.getAttribute("href"), pageUrl) : "",
      postedAt: normalizeWhitespace(date?.getAttribute("title")),
      relativeTime: text(date),
      selectedAnswers,
      content: textWithBreaks(content),
      links: [...(content?.querySelectorAll("a[href]") || [])].map((link) => ({
        text: text(link),
        url: absoluteUrl(link.getAttribute("href"), pageUrl),
      })),
      upvotes: Number(text(body?.querySelector(":scope > .comment-control .upvote-count"))) || 0,
      badges: [...(head?.querySelectorAll(".badge") || [])].map((badge) => text(badge)).filter(Boolean),
    };
  });

  return {
    id: normalizeWhitespace(metadata?.getAttribute("data-discussion-id")),
    title: normalizeWhitespace(metadata?.getAttribute("data-title")),
    sourceUrl: pageUrl,
    isComplete: !container.querySelector(".load-full-discussion-button"),
    comments,
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("Capture was interrupted.");
  error.name = "AbortError";
  throw error;
}

async function responseToDocument(response) {
  if (!response.ok) throw new Error(`Discussion request failed with status ${response.status}.`);
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (contentType && !contentType.includes("text/html")) {
    throw new Error(`Discussion request returned ${contentType}.`);
  }
  return new DOMParser().parseFromString(await response.text(), "text/html");
}

async function fetchQuestionDiscussion(card, pageUrl, fetchDiscussion, signal) {
  const questionId = card.querySelector(".question-body[data-id]")?.getAttribute("data-id")
    || card.getAttribute("data-question-id");
  const control = card.querySelector(".question-discussion-button");
  if (!questionId || !control) return null;

  const initialUrl = absoluteUrl(`/ajax/discussion/exam-question/${encodeURIComponent(questionId)}/`, pageUrl);
  const initialResponse = await fetchDiscussion(initialUrl, { credentials: "include", signal });
  let discussionDocument = await responseToDocument(initialResponse);
  let discussion = parseDiscussionDocument(discussionDocument, pageUrl);
  if (!discussion.isComplete && discussion.id) {
    const fullUrl = absoluteUrl(`/ajax/discussion/load-complete/?discussion-id=${encodeURIComponent(discussion.id)}`, pageUrl);
    const fullResponse = await fetchDiscussion(fullUrl, { credentials: "include", signal });
    discussionDocument = await responseToDocument(fullResponse);
    discussion = parseDiscussionDocument(discussionDocument, pageUrl);
  }
  return discussion;
}

export async function fetchQuestionDiscussions(cards, pageUrl, fetchDiscussion = fetch, options = {}) {
  const discussions = [];
  const failures = [];
  let requested = 0;
  let comments = 0;

  for (const card of cards) {
    throwIfAborted(options.signal);
    if (card.querySelector(".question-discussion-button")) requested += 1;
    try {
      const discussion = await fetchQuestionDiscussion(card, pageUrl, fetchDiscussion, options.signal);
      discussions.push(discussion);
      comments += discussion?.comments.length || 0;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      discussions.push(null);
      failures.push({
        questionId: card.querySelector(".question-body[data-id]")?.getAttribute("data-id") || "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    discussions,
    requested,
    fetched: discussions.filter(Boolean).length,
    comments,
    failures,
  };
}

function absoluteUrl(value, pageUrl) {
  try {
    return new URL(value, pageUrl).href;
  } catch {
    return value;
  }
}

function imageSource(image, pageUrl) {
  const lazySource = ["data-src", "data-original", "data-lazy-src"]
    .map((attribute) => image.getAttribute(attribute))
    .find(Boolean);
  const srcsetSource = image.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
  return absoluteUrl(lazySource || image.currentSrc || image.getAttribute("src") || srcsetSource || "", pageUrl);
}

function inferImageMime(source) {
  const pathname = source.split(/[?#]/)[0].toLowerCase();
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  return "image/png";
}

async function responseToDataUrl(response, source) {
  if (!response.ok) throw new Error(`Image request failed with status ${response.status}.`);
  const contentType = response.headers.get("content-type")?.split(";")[0].trim() || inferImageMime(source);
  if (!contentType.startsWith("image/")) throw new Error(`Image request returned ${contentType}.`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

export async function embedQuestionImages(questions, fetchImage = fetch, options = {}) {
  const cached = new Map();
  const failures = [];
  let embedded = 0;
  throwIfAborted(options.signal);

  const hydrated = await Promise.all(questions.map(async (question) => ({
    ...question,
    images: await Promise.all((question.images || []).map(async (image) => {
      if (image.src.startsWith("data:image/")) {
        embedded += 1;
        return { ...image, dataUrl: image.src };
      }
      if (!cached.has(image.src)) {
        cached.set(image.src, fetchImage(image.src, {
          credentials: "include",
          signal: options.signal,
        }).then((response) => responseToDataUrl(response, image.src)));
      }
      throwIfAborted(options.signal);
      try {
        const dataUrl = await cached.get(image.src);
        embedded += 1;
        return { ...image, dataUrl };
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        failures.push({ src: image.src, error: error instanceof Error ? error.message : String(error) });
        return image;
      }
    })),
  })));

  return { questions: hydrated, embedded, failures };
}

function inferProvider(pageUrl) {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./i, "") || "Unspecified";
  } catch {
    return "Unspecified";
  }
}

function inferExamCode(documentRoot, pageUrl) {
  const titleCode = documentRoot?.title?.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/i)?.[0];
  if (titleCode) return titleCode.toUpperCase();
  try {
    const pathCode = new URL(pageUrl).pathname.match(/\/exams\/[^/]+\/([^/]+)/i)?.[1];
    if (pathCode) return decodeURIComponent(pathCode).toUpperCase();
  } catch {
    // Invalid source URLs are handled by the capture validator.
  }
  return "UNSPECIFIED";
}

export function parseQuestionCard(card, pageUrl, capturedAt = new Date().toISOString(), discussion = null) {
  const fullText = text(card);
  const number = fullText.match(/question\s*#?\s*(\d+)/i)?.[1] || "";
  const topic = fullText.match(/topic\s*(\d+)/i)?.[1] || "";
  const choices = parseChoices(card);
  const prompt = parsePrompt(card, choices);
  const discussionMatch = fullText.match(/discussion\s*(\d+)/i);

  return {
    examCode: inferExamCode(card.ownerDocument, pageUrl),
    sourceUrl: pageUrl,
    topic: topic ? `Topic ${topic}` : "",
    number,
    prompt,
    choices,
    correctAnswers: parseAnswerLabels(card, choices),
    mostVotedAnswers: parseMostVoted(card, choices),
    voteDistribution: parseVotes(card),
    explanation: parseExplanation(card),
    discussionCount: discussionMatch ? Number(discussionMatch[1]) : null,
    discussion,
    images: [...card.querySelectorAll("img")]
      .map((image) => ({ image, src: imageSource(image, pageUrl) }))
      .filter(({ image, src }) => src && !/avatar|icon|logo/i.test(`${image.className} ${image.alt}`))
      .map(({ image, src }) => ({
        src,
        alt: image.alt || "",
        role: image.closest(".question-answer, .correct-answer, [data-correct-answer], .solution, .answer-area") ? "answer" : "question",
      })),
    capturedAt,
  };
}

export async function capturePage(documentRoot = document, pageUrl = location.href, options = {}) {
  const cards = findQuestionCards(documentRoot);
  if (!cards.length) throw new Error("No question cards were found on this page.");

  const reveal = await revealQuestionCards(cards, options.revealTimeoutMs ?? 4000, { signal: options.signal });
  const capturedAt = new Date().toISOString();
  const completedQuestions = [];
  const discussionCapture = { requested: 0, fetched: 0, comments: 0, failures: [] };
  const imageCapture = { embedded: 0, failures: [] };

  for (const [index, card] of cards.entries()) {
    throwIfAborted(options.signal);
    const cardDiscussions = options.scrapeDiscussions === false
      ? { discussions: [null], requested: 0, fetched: 0, comments: 0, failures: [] }
      : await fetchQuestionDiscussions([card], pageUrl, options.fetchDiscussion, { signal: options.signal });
    discussionCapture.requested += cardDiscussions.requested;
    discussionCapture.fetched += cardDiscussions.fetched;
    discussionCapture.comments += cardDiscussions.comments;
    discussionCapture.failures.push(...cardDiscussions.failures);

    const discussion = cardDiscussions.discussions[0];
    if (options.requireCompleteDiscussions && cardDiscussions.requested > 0) {
      if (cardDiscussions.failures.length || !discussion?.isComplete) {
        const detail = cardDiscussions.failures[0]?.error || "The complete discussion was not available.";
        throw new Error(`Question ${index + 1} discussion is incomplete: ${detail}`);
      }
    }

    const parsedQuestion = parseQuestionCard(card, pageUrl, capturedAt, discussion);
    const cardImages = options.embedImages === false
      ? { questions: [parsedQuestion], embedded: 0, failures: [] }
      : await embedQuestionImages([parsedQuestion], options.fetchImage, { signal: options.signal });
    imageCapture.embedded += cardImages.embedded;
    imageCapture.failures.push(...cardImages.failures);
    const completedQuestion = cardImages.questions[0];
    completedQuestions.push(completedQuestion);
    await options.onQuestionCaptured?.(completedQuestion, {
      index,
      completed: completedQuestions.length,
      total: cards.length,
    });
  }

  const bundle = makeCaptureBundle(completedQuestions, {
    provider: inferProvider(pageUrl),
    examCode: completedQuestions.find((question) => question.examCode)?.examCode || "UNSPECIFIED",
    sourceUrl: pageUrl,
    exportedAt: capturedAt,
  });

  bundle.capture = {
    cardsFound: cards.length,
    reveal,
    images: {
      found: completedQuestions.reduce((count, question) => count + question.images.length, 0),
      embedded: imageCapture.embedded,
      failed: imageCapture.failures.length,
    },
    discussions: {
      requested: discussionCapture.requested,
      fetched: discussionCapture.fetched,
      comments: discussionCapture.comments,
      failed: discussionCapture.failures.length,
    },
  };
  for (const failure of imageCapture.failures) {
    bundle.warnings.push(`Could not embed image ${failure.src}: ${failure.error}`);
  }
  for (const failure of discussionCapture.failures) {
    bundle.warnings.push(`Could not capture discussion for question ${failure.questionId || "unknown"}: ${failure.error}`);
  }
  if (bundle.questions.length === 0) {
    throw new Error(`Found ${cards.length} question card(s), but none could be parsed. ${bundle.warnings.join(" ")}`);
  }
  return bundle;
}
