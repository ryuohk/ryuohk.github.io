const DATABASE_NAME = "crambot-extension";
const DATABASE_VERSION = 1;
const STORE_NAME = "settings";
const DIRECTORY_KEY = "capture-directory";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("Could not open extension storage.")), { once: true });
  });
}

async function readSetting(key) {
  const database = await openDatabase();
  try {
    return await requestResult(database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key));
  } finally {
    database.close();
  }
}

async function writeSetting(key, value) {
  const database = await openDatabase();
  try {
    await requestResult(database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(value, key));
  } finally {
    database.close();
  }
}

export async function ensureDirectoryHandlePermission(handle, request = false) {
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted" && request) {
    permission = await handle.requestPermission({ mode: "readwrite" });
  }
  return permission;
}

export async function pickCaptureDirectory(windowRoot = window) {
  if (typeof windowRoot.showDirectoryPicker !== "function") {
    throw new Error("Folder selection requires a current Chrome or Edge release.");
  }
  const handle = await windowRoot.showDirectoryPicker({ id: "crambot-captures", mode: "readwrite" });
  const permission = await ensureDirectoryHandlePermission(handle, true);
  if (permission !== "granted") throw new Error("Write access to the selected folder was not granted.");
  await writeSetting(DIRECTORY_KEY, handle);
  return { name: handle.name, permission: "granted" };
}

/**
 * Whether the chosen folder can be written to right now. Query only, never request.
 *
 * requestPermission() must not be called from a handler that has work left to do.
 * The prompt takes focus, which closes the extension popup, which destroys its
 * document and abandons the pending async work: the capture silently does nothing.
 * Re-granting therefore belongs to the Restore button alone, where the request is
 * the entire job and losing the popup afterwards costs nothing.
 */
export async function hasCaptureDirectoryAccess() {
  const handle = await readSetting(DIRECTORY_KEY);
  if (!handle) return false;
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** True when a capture can be saved somewhere, folder or downloads. */
export async function canSaveCaptures() {
  if (typeof URL.createObjectURL === "function") return true;
  const handle = await readSetting(DIRECTORY_KEY);
  if (!handle) return false;
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

export async function getCaptureDirectoryStatus() {
  const handle = await readSetting(DIRECTORY_KEY);
  if (!handle) return { selected: false, name: "", permission: "prompt" };
  const permission = await handle.queryPermission({ mode: "readwrite" });
  return { selected: true, name: handle.name, permission };
}

export async function restoreCaptureDirectoryAccess() {
  const handle = await readSetting(DIRECTORY_KEY);
  if (!handle) throw new Error("No saved output folder is available.");
  const permission = await ensureDirectoryHandlePermission(handle, true);
  if (permission !== "granted") throw new Error(`Write access to ${handle.name} was not granted.`);
  return { selected: true, name: handle.name, permission };
}

export function captureBundleFilename(bundle, suffix = "", now = new Date()) {
  const exam = bundle.source?.examCode || "exam";
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const qualifier = suffix ? `-${suffix}` : "";
  return `crambot-${exam.toLowerCase()}-${timestamp}${qualifier}.crambot.json`;
}

export async function writeCaptureBundleToHandle(handle, bundle, suffix = "", now = new Date()) {
  const permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error("Output folder access expired. Choose the folder again, then save the captured data.");

  const filename = captureBundleFilename(bundle, suffix, now);
  const fileHandle = await handle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(JSON.stringify(bundle, null, 2));
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
  return filename;
}

/** Where the browser's download fallback puts files, relative to Downloads. */
export const DOWNLOAD_SUBFOLDER = "CramBot";

/**
 * Saves through the browser's own download machinery instead of the chosen folder.
 *
 * Only callable from a context with a document. MV3 service workers have no
 * URL.createObjectURL, and a data URL is not a safe substitute for captures that
 * routinely run to tens of megabytes.
 */
export async function downloadCaptureBundle(bundle, suffix = "", now = new Date()) {
  if (typeof URL.createObjectURL !== "function") {
    throw new Error("This context cannot start a download.");
  }
  const filename = `${DOWNLOAD_SUBFOLDER}/${captureBundleFilename(bundle, suffix, now)}`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
  try {
    await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    return filename;
  } finally {
    // Chrome has read the blob by the time the promise settles.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * Writes to the chosen folder, falling back to a download when that folder's
 * permission has lapsed.
 *
 * The File System Access grant only survives while some context of this extension is
 * alive, and a popup dies the moment it closes, so a long run can find itself unable
 * to write through no fault of the user. Falling back means captured work is never
 * lost to an expired grant. Where no fallback is possible, the caller keeps the data
 * retained so the popup can save it later.
 */
export async function writeCaptureBundle(bundle, suffix = "") {
  const handle = await readSetting(DIRECTORY_KEY);
  if (handle) {
    try {
      if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") {
        return await writeCaptureBundleToHandle(handle, bundle, suffix);
      }
    } catch {
      // Treat an unusable handle exactly like a lapsed one.
    }
  }
  if (typeof URL.createObjectURL === "function") return downloadCaptureBundle(bundle, suffix);
  throw new Error(
    handle
      ? "Output folder access expired and this context cannot download. Open the extension and save the retained capture data."
      : "Choose an output folder before capturing.",
  );
}
