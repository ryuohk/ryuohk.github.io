import {
  AUTO_STATE_KEY,
  clearStoredAutoPages,
  createAutoCaptureState,
  mergeStoredAutoPages,
} from "./automation.js";
import { requestPageCapture, startAutomaticCapture, stopAutomaticCapture } from "./messaging.js";
import {
  DOWNLOAD_SUBFOLDER,
  getCaptureDirectoryStatus,
  pickCaptureDirectory,
  restoreCaptureDirectoryAccess,
  writeCaptureBundle,
} from "./output-directory.js";

const captureButton = document.querySelector("#capture");
const autoButton = document.querySelector("#capture-all");
const stopButton = document.querySelector("#stop");
const chooseFolderButton = document.querySelector("#choose-folder");
const savePartialButton = document.querySelector("#save-partial");
const folderStatus = document.querySelector("#folder-status");
const status = document.querySelector("#status");

function setStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
}

async function activeExamTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://www.examtopics.com/")) {
    throw new Error("Open a supported question page in the active tab first.");
  }
  return tab;
}

/**
 * The popup can always fall back to a browser download, so a lapsed folder grant is
 * no longer a reason to refuse. Only a folder that was never chosen is, and even then
 * only to keep the intended destination obvious rather than silently using Downloads.
 */
async function requireOutputDirectory() {
  const directory = await getCaptureDirectoryStatus();
  if (!directory.selected) throw new Error("Choose an output folder before capturing.");
  return directory;
}

function describeDestination(filename) {
  if (!filename) return "an unknown location";
  return filename.startsWith(`${DOWNLOAD_SUBFOLDER}/`)
    ? `your Downloads folder, under ${filename}, because access to the chosen folder had expired`
    : filename;
}

function setRunning(running) {
  captureButton.disabled = running;
  chooseFolderButton.disabled = running;
  autoButton.hidden = running;
  stopButton.hidden = !running;
}

async function refreshFolderStatus() {
  try {
    const directory = await getCaptureDirectoryStatus();
    if (!directory.selected) {
      chooseFolderButton.textContent = "Choose output folder";
      folderStatus.textContent = "No output folder selected.";
      folderStatus.dataset.kind = "warning";
    } else if (directory.permission === "prompt") {
      chooseFolderButton.textContent = `Restore ${directory.name}`;
      folderStatus.textContent = `Saved output folder: ${directory.name}. Access has lapsed, so captures will go to your Downloads folder. Select Restore ${directory.name} first to save there instead.`;
      folderStatus.dataset.kind = "warning";
    } else if (directory.permission !== "granted") {
      chooseFolderButton.textContent = "Choose another output folder";
      folderStatus.textContent = `Saved output folder ${directory.name} is no longer available.`;
      folderStatus.dataset.kind = "warning";
    } else {
      chooseFolderButton.textContent = "Change output folder";
      folderStatus.textContent = `Saved output folder: ${directory.name}`;
      folderStatus.dataset.kind = "success";
    }
  } catch (error) {
    folderStatus.textContent = error instanceof Error ? error.message : String(error);
    folderStatus.dataset.kind = "error";
  }
}

async function refreshAutoStatus() {
  const state = (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  /**
   * Retained capture data is stored once per extension, not per tab, and the guard
   * that refuses to start a new run reads it that way too. Hiding the save button
   * whenever the run belonged to another tab therefore left the only way out of that
   * guard invisible, and tab ids do not survive closing a tab. Treat unsaved data as
   * belonging to the extension so it is always recoverable.
   */
  const strandedData = Boolean(state) && !state.active && !state.filename && state.questionsCaptured > 0;

  if (!state || (state.tabId !== tab?.id && !strandedData)) {
    setRunning(false);
    savePartialButton.hidden = true;
    return;
  }

  if (state.tabId !== tab?.id) {
    setRunning(false);
    savePartialButton.hidden = false;
    setStatus(
      `${state.questionsCaptured} question/discussion pair${state.questionsCaptured === 1 ? "" : "s"} from an earlier run are still unsaved. Save them below, or a new run cannot start.`,
      "warning",
    );
    return;
  }

  setRunning(state.active);
  savePartialButton.hidden = state.active || Boolean(state.filename) || state.questionsCaptured === 0;
  if (state.active) {
    const action = {
      starting: "Starting",
      waiting: "Waiting for page elements",
      capturing: "Capturing questions and discussions",
      navigating: "Moving to the next page",
      stopping: "Stopping and saving completed pairs",
    }[state.status] || "Working";
    setStatus(`${action}… ${state.pagesCaptured} complete page${state.pagesCaptured === 1 ? "" : "s"}, ${state.questionsCaptured} complete question/discussion pairs, ${state.commentsCaptured} comments.`);
  } else if (state.status === "completed") {
    setStatus(`Complete. Saved ${state.questionsCaptured} question/discussion pairs and ${state.commentsCaptured} comments to ${describeDestination(state.filename)}.`, "success");
  } else if (state.status === "stopped") {
    setStatus(`Stopped. Saved ${state.questionsCaptured} complete question/discussion pairs to ${describeDestination(state.filename)}.`, "warning");
  } else if (state.status === "error") {
    setStatus(`${state.error || "Automatic capture failed."}${state.filename ? ` Partial data was saved to ${describeDestination(state.filename)}.` : ""}`, "error");
  }
}

chooseFolderButton.addEventListener("click", async () => {
  chooseFolderButton.disabled = true;
  try {
    const current = await getCaptureDirectoryStatus();
    const directory = current.selected && current.permission === "prompt"
      ? await restoreCaptureDirectoryAccess()
      : await pickCaptureDirectory(window);
    chooseFolderButton.textContent = "Change output folder";
    folderStatus.textContent = `Saved output folder: ${directory.name}`;
    folderStatus.dataset.kind = "success";
    setStatus("Saved output folder is ready for future capture runs.", "success");
  } catch (error) {
    if (error?.name !== "AbortError") setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    chooseFolderButton.disabled = false;
  }
});

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  autoButton.disabled = true;
  setStatus("Revealing solutions and capturing questions and discussions…");

  try {
    await requireOutputDirectory();
    const tab = await activeExamTab();
    const response = await requestPageCapture(chrome, tab.id);
    if (!response?.ok) throw new Error(response?.error || "The page did not return capture data.");

    const filename = await writeCaptureBundle(response.bundle);
    const count = response.bundle.questions.length;
    const comments = response.bundle.capture?.discussions?.comments || 0;
    const timedOut = response.bundle.capture?.reveal?.timedOut || 0;
    setStatus(
      `Saved ${count} question${count === 1 ? "" : "s"} and ${comments} discussion comment${comments === 1 ? "" : "s"} to ${describeDestination(filename)}.${timedOut ? ` ${timedOut} solution reveal(s) timed out.` : ""}`,
      timedOut ? "warning" : "success",
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    captureButton.disabled = false;
    autoButton.disabled = false;
  }
});

autoButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  autoButton.disabled = true;
  let createdRunId = "";
  try {
    await requireOutputDirectory();
    const tab = await activeExamTab();
    const existing = (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
    if (existing?.questionsCaptured > 0 && !existing.filename) {
      throw new Error(
        `An earlier run left ${existing.questionsCaptured} unsaved question/discussion pair${existing.questionsCaptured === 1 ? "" : "s"}. Use "Save retained capture data" first, then start the new run.`,
      );
    }
    if (existing?.runId) await clearStoredAutoPages(chrome.storage.local, existing.runId);
    const state = createAutoCaptureState(tab.id, tab.url);
    createdRunId = state.runId;
    await chrome.storage.local.set({ [AUTO_STATE_KEY]: state });
    setRunning(true);
    setStatus("Starting automatic capture…");
    const response = await startAutomaticCapture(chrome, tab.id);
    if (!response?.ok) throw new Error(response?.error || "The page could not start automatic capture.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
    if (createdRunId && state?.runId === createdRunId) {
      await chrome.storage.local.set({
        [AUTO_STATE_KEY]: { ...state, active: false, status: "error", error: message, updatedAt: new Date().toISOString() },
      });
    }
    setRunning(false);
    setStatus(message, "error");
  } finally {
    autoButton.disabled = false;
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  try {
    const tab = await activeExamTab();
    const state = (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
    if (state) {
      await chrome.storage.local.set({
        [AUTO_STATE_KEY]: { ...state, active: false, status: "stopping", updatedAt: new Date().toISOString() },
      });
    }
    setStatus("Stopping now and saving every completed question/discussion pair…", "warning");
    await stopAutomaticCapture(chrome, tab.id);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    stopButton.disabled = false;
  }
});

savePartialButton.addEventListener("click", async () => {
  savePartialButton.disabled = true;
  try {
    const state = (await chrome.storage.local.get(AUTO_STATE_KEY))[AUTO_STATE_KEY];
    if (!state?.runId) throw new Error("No retained capture data is available.");

    // Saved here rather than in the background on purpose. Only a context with a
    // document can fall back to a download; the service worker has no
    // URL.createObjectURL, and a data URL will not carry a capture this large.
    const bundle = await mergeStoredAutoPages(chrome.storage.local, state);
    if (!bundle) throw new Error("No complete question and discussion pairs are available to save.");
    if (state.error) bundle.warnings.push(`Automatic capture stopped: ${state.error}`);
    const filename = await writeCaptureBundle(bundle, "partial");
    // Only discard the retained pages once the write has actually succeeded.
    await clearStoredAutoPages(chrome.storage.local, state.runId);
    await chrome.storage.local.set({
      [AUTO_STATE_KEY]: {
        ...state,
        active: false,
        status: "stopped",
        error: "",
        filename,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    await refreshAutoStatus();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    savePartialButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[AUTO_STATE_KEY]) void refreshAutoStatus();
});
void refreshFolderStatus();
void refreshAutoStatus();
