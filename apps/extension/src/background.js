import { fetchQuestionImage } from "./image-fetch.js";
import {
  AUTO_STATE_KEY,
  clearStoredAutoPages,
  mergeStoredAutoPages,
} from "./automation.js";
import { writeCaptureBundle } from "./output-directory.js";

async function saveAutomaticCapture(message) {
  const state = (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
  if (!state || state.runId !== message.runId) throw new Error("The automatic capture run is no longer available.");
  const bundle = await mergeStoredAutoPages(chrome.storage.local, state);
  if (!bundle) throw new Error("No complete question and discussion pairs are available to save.");
  if (message.error) bundle.warnings.push(`Automatic capture stopped: ${message.error}`);
  const filename = await writeCaptureBundle(bundle, message.outcome === "completed" ? "" : "partial");
  await clearStoredAutoPages(chrome.storage.local, state.runId);
  return filename;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "CRAMBOT_GET_TAB_ID") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }
  if (message?.type === "CRAMBOT_FETCH_IMAGE") {
    fetchQuestionImage(message.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "CRAMBOT_SAVE_AUTO_CAPTURE") {
    saveAutomaticCapture(message)
      .then((filename) => sendResponse({ ok: true, filename }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});
