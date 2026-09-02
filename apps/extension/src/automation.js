import { makeCaptureBundle } from "@crambot/core";
import { findQuestionCards } from "./parser.js";

export const AUTO_STATE_KEY = "crambotAutoCaptureState";
export const AUTO_PAGE_PREFIX = "crambotAutoCapturePage:";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    delay(timeoutMs).then(() => false),
  ]);
}

async function waitForDocumentLoad(documentRoot, timeoutMs) {
  if (documentRoot.readyState === "complete") return true;
  return withTimeout(new Promise((resolve) => {
    documentRoot.defaultView?.addEventListener("load", () => resolve(true), { once: true });
  }), timeoutMs);
}

async function waitForQuestionCards(documentRoot, timeoutMs) {
  const existing = findQuestionCards(documentRoot);
  if (existing.length) return existing;

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const cards = findQuestionCards(documentRoot);
      if (!cards.length) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(cards);
    });
    observer.observe(documentRoot.documentElement, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timed out waiting for question cards to load."));
    }, timeoutMs);
  });
}

async function waitForDomQuiet(documentRoot, quietMs, timeoutMs) {
  return new Promise((resolve) => {
    let quietTimer;
    const finish = () => {
      observer.disconnect();
      clearTimeout(timeoutTimer);
      clearTimeout(quietTimer);
      resolve();
    };
    const scheduleQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    const observer = new MutationObserver(scheduleQuiet);
    observer.observe(documentRoot.documentElement, { childList: true, subtree: true, attributes: true });
    const timeoutTimer = setTimeout(finish, timeoutMs);
    scheduleQuiet();
  });
}

async function waitForImage(image, timeoutMs) {
  if (image.complete) return true;
  const loaded = new Promise((resolve) => {
    image.addEventListener("load", () => resolve(true), { once: true });
    image.addEventListener("error", () => resolve(false), { once: true });
  });
  return withTimeout(loaded, timeoutMs);
}

export async function waitForPageReady(documentRoot = document, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  const quietMs = options.quietMs ?? 700;
  await waitForDocumentLoad(documentRoot, timeoutMs);
  const cards = await waitForQuestionCards(documentRoot, timeoutMs);

  for (const card of cards) {
    card.scrollIntoView?.({ block: "center" });
    await delay(options.scrollDelayMs ?? 40);
  }
  documentRoot.defaultView?.scrollTo?.(0, 0);
  await waitForDomQuiet(documentRoot, quietMs, timeoutMs);

  const images = cards.flatMap((card) => [...card.querySelectorAll("img")]);
  const imageResults = await Promise.all(images.map((image) => waitForImage(image, options.imageTimeoutMs ?? 5000)));
  await documentRoot.fonts?.ready;
  return {
    cards: cards.length,
    images: images.length,
    incompleteImages: imageResults.filter((loaded) => !loaded).length,
  };
}

function examPageIdentity(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/exams\/([^/]+)\/([^/]+)\/view(?:\/(\d+))?\/?$/i);
    if (!match) return null;
    return {
      origin: url.origin,
      provider: match[1].toLowerCase(),
      exam: match[2].toLowerCase(),
      page: Number(match[3] || 1),
    };
  } catch {
    return null;
  }
}

export function findNextPageUrl(documentRoot = document, pageUrl = location.href) {
  const current = examPageIdentity(pageUrl);
  if (!current) return null;
  const candidates = [
    ...documentRoot.querySelectorAll("a[rel='next'], .nextBtn a, a.btn.btn-success.pull-right"),
    ...[...documentRoot.querySelectorAll("a[href]")].filter((link) => /next\s+questions/i.test(link.textContent || "")),
  ];

  for (const link of [...new Set(candidates)]) {
    if (link.matches("[aria-disabled='true'], .disabled") || link.closest(".disabled")) continue;
    const href = link.getAttribute("href");
    if (!href) continue;
    const nextUrl = new URL(href, pageUrl);
    const next = examPageIdentity(nextUrl.href);
    if (!next) continue;
    if (next.origin !== current.origin || next.provider !== current.provider || next.exam !== current.exam) continue;
    if (next.page <= current.page) continue;
    return nextUrl.href;
  }
  return null;
}

export function createAutoCaptureState(tabId, startUrl, now = new Date()) {
  return {
    runId: `${now.getTime()}-${crypto.randomUUID()}`,
    tabId,
    startUrl,
    currentUrl: startUrl,
    active: true,
    status: "starting",
    pagesCaptured: 0,
    questionsCaptured: 0,
    commentsCaptured: 0,
    visitedUrls: [],
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    error: "",
  };
}

export function autoPageKey(runId, pageIndex) {
  return `${AUTO_PAGE_PREFIX}${runId}:${String(pageIndex).padStart(6, "0")}`;
}

export async function clearStoredAutoPages(storageArea, runId) {
  const stored = await storageArea.get(null);
  const keys = Object.keys(stored).filter((key) => key.startsWith(`${AUTO_PAGE_PREFIX}${runId}:`));
  if (keys.length) await storageArea.remove(keys);
}

export async function mergeStoredAutoPages(storageArea, state) {
  const stored = await storageArea.get(null);
  const pageEntries = Object.entries(stored)
    .filter(([key]) => key.startsWith(`${AUTO_PAGE_PREFIX}${state.runId}:`))
    .sort(([left], [right]) => left.localeCompare(right));
  if (!pageEntries.length) return null;

  const pageBundles = pageEntries.map(([, bundle]) => bundle);
  const first = pageBundles[0];
  const bundle = makeCaptureBundle(pageBundles.flatMap((page) => page.questions), {
    provider: first.source?.provider,
    examCode: first.source?.examCode,
    sourceUrl: state.startUrl,
    exportedAt: new Date().toISOString(),
  });
  bundle.warnings.push(...pageBundles.flatMap((page) => page.warnings || []));
  bundle.capture = {
    automatic: true,
    pages: pageBundles.length,
    pageUrls: pageBundles.map((page) => page.source?.pageUrl).filter(Boolean),
    discussions: {
      comments: bundle.questions.reduce((count, question) => count + (question.discussion?.comments.length || 0), 0),
      incomplete: bundle.questions.filter((question) => question.discussion && !question.discussion.isComplete).length,
    },
  };
  return bundle;
}
