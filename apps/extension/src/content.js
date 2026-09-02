import { capturePage } from "./parser.js";
import {
  AUTO_STATE_KEY,
  autoPageKey,
  findNextPageUrl,
  waitForPageReady,
} from "./automation.js";

const listenerFlag = "__crambotCaptureListenerInstalled";
let autoRunning = false;
let cancelRequested = false;
let finalizing = false;
let autoAbortController = null;

async function fetchCaptureImage(url, init) {
  init?.signal?.throwIfAborted?.();
  if (new URL(url).hostname !== "img.examtopics.com") return fetch(url, init);
  const response = await chrome.runtime.sendMessage({ type: "CRAMBOT_FETCH_IMAGE", url });
  init?.signal?.throwIfAborted?.();
  if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "The extension could not retrieve the image.");
  return fetch(response.dataUrl, { signal: init?.signal });
}

function countDiscussionComments(question) {
  return question.discussion?.comments.length || 0;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

function progressivePageBundle(pageUrl, questions) {
  const first = questions[0];
  return {
    source: {
      provider: new URL(pageUrl).hostname.replace(/^www\./i, ""),
      examCode: first?.examCode || "UNSPECIFIED",
      pageUrl,
    },
    questions,
    warnings: [],
  };
}

async function getAutoState() {
  return (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY] || null;
}

async function patchAutoState(patch, expectedRunId = "") {
  const current = await getAutoState();
  if (!current || (expectedRunId && current.runId !== expectedRunId)) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [AUTO_STATE_KEY]: next });
  return next;
}

async function finalizeAutoCapture(outcome, error = "", expectedRunId = "") {
  if (finalizing) return;
  finalizing = true;
  try {
    const state = await getAutoState();
    if (!state || (expectedRunId && state.runId !== expectedRunId)) return;
    const saved = await chrome.runtime.sendMessage({
      type: "CRAMBOT_SAVE_AUTO_CAPTURE",
      runId: state.runId,
      outcome,
      error,
    });
    if (!saved?.ok) {
      const saveError = saved?.error || "The captured JSON could not be written.";
      await patchAutoState({
        active: false,
        status: "error",
        error: `${saveError} Captured data is retained until it is saved or a new run starts.`,
        filename: "",
        finishedAt: new Date().toISOString(),
      }, state.runId);
      return;
    }
    await patchAutoState({
      active: false,
      status: outcome,
      error,
      filename: saved.filename,
      finishedAt: new Date().toISOString(),
    }, state.runId);
  } finally {
    autoRunning = false;
    finalizing = false;
  }
}

async function runAutoCapture() {
  if (autoRunning || finalizing) return;
  const state = await getAutoState();
  if (!state?.active) return;
  const tab = await chrome.runtime.sendMessage({ type: "CRAMBOT_GET_TAB_ID" });
  if (tab?.tabId !== state.tabId) return;

  const currentUrl = location.href;
  if (state.visitedUrls.includes(currentUrl)) {
    await finalizeAutoCapture("error", `Stopped before revisiting ${currentUrl}.`, state.runId);
    return;
  }

  autoRunning = true;
  cancelRequested = false;
  const controller = new AbortController();
  autoAbortController = controller;
  const completedOnPage = [];
  const pageKey = autoPageKey(state.runId, state.pagesCaptured);
  try {
    await patchAutoState({ status: "waiting", currentUrl }, state.runId);
    const readiness = await abortable(waitForPageReady(document), controller.signal);
    await patchAutoState({ status: "capturing", readiness }, state.runId);
    const bundle = await capturePage(document, currentUrl, {
      fetchImage: fetchCaptureImage,
      signal: controller.signal,
      requireCompleteDiscussions: true,
      onQuestionCaptured: async (question) => {
        completedOnPage.push(question);
        await chrome.storage.local.set({
          [pageKey]: progressivePageBundle(currentUrl, [...completedOnPage]),
        });
        const progress = await getAutoState();
        if (progress?.runId !== state.runId) throw new Error("The automatic capture run changed.");
        await patchAutoState({
          questionsCaptured: progress.questionsCaptured + 1,
          commentsCaptured: progress.commentsCaptured + countDiscussionComments(question),
        }, state.runId);
      },
    });
    const stateAfterCapture = await getAutoState();
    if (stateAfterCapture?.runId !== state.runId) return;
    await chrome.storage.local.set({ [pageKey]: bundle });

    const nextState = await patchAutoState({
      pagesCaptured: state.pagesCaptured + 1,
      visitedUrls: [...state.visitedUrls, currentUrl],
    }, state.runId);
    const latest = await getAutoState();
    if (!nextState || cancelRequested || !latest?.active || latest.runId !== state.runId) {
      await finalizeAutoCapture("stopped", "", state.runId);
      return;
    }

    const nextUrl = findNextPageUrl(document, currentUrl);
    if (!nextUrl) {
      await finalizeAutoCapture("completed", "", state.runId);
      return;
    }
    if (nextState.visitedUrls.includes(nextUrl)) {
      await finalizeAutoCapture("error", `The next-page link loops back to ${nextUrl}.`, state.runId);
      return;
    }

    await patchAutoState({ status: "navigating", currentUrl: nextUrl }, state.runId);
    const beforeNavigation = await getAutoState();
    if (cancelRequested || !beforeNavigation?.active || beforeNavigation.runId !== state.runId) {
      await finalizeAutoCapture("stopped", "", state.runId);
      return;
    }
    location.assign(nextUrl);
  } catch (error) {
    const interrupted = cancelRequested || error?.name === "AbortError";
    await finalizeAutoCapture(
      interrupted ? "stopped" : "error",
      interrupted ? "" : error instanceof Error ? error.message : String(error),
      state.runId,
    );
  } finally {
    if (autoAbortController === controller) autoAbortController = null;
    if (!finalizing) autoRunning = false;
  }
}

async function resumeAutoCapture() {
  const state = await getAutoState();
  if (!state?.active) return;
  const tab = await chrome.runtime.sendMessage({ type: "CRAMBOT_GET_TAB_ID" });
  if (tab?.tabId === state.tabId) await runAutoCapture();
}

if (!globalThis[listenerFlag]) {
  globalThis[listenerFlag] = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CRAMBOT_CAPTURE_PAGE") {
      if (autoRunning) {
        sendResponse({ ok: false, error: "Automatic capture is already running in this tab." });
        return false;
      }
      capturePage(document, location.href, { fetchImage: fetchCaptureImage, requireCompleteDiscussions: true })
        .then((bundle) => sendResponse({ ok: true, bundle }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (message?.type === "CRAMBOT_AUTO_START") {
      cancelRequested = false;
      void runAutoCapture();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "CRAMBOT_AUTO_STOP") {
      cancelRequested = true;
      autoAbortController?.abort(new DOMException("Capture was interrupted by the user.", "AbortError"));
      if (!autoRunning) void finalizeAutoCapture("stopped");
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
  void resumeAutoCapture();
}
