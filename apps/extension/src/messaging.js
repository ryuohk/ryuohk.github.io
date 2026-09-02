const NO_RECEIVER_PATTERN = /Could not establish connection|Receiving end does not exist/i;

async function sendContentMessage(chromeApi, tabId, message) {
  try {
    return await chromeApi.tabs.sendMessage(tabId, message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!NO_RECEIVER_PATTERN.test(detail)) throw error;

    await chromeApi.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    return chromeApi.tabs.sendMessage(tabId, message);
  }
}

export function requestPageCapture(chromeApi, tabId) {
  return sendContentMessage(chromeApi, tabId, { type: "CRAMBOT_CAPTURE_PAGE" });
}

export function startAutomaticCapture(chromeApi, tabId) {
  return sendContentMessage(chromeApi, tabId, { type: "CRAMBOT_AUTO_START" });
}

export function stopAutomaticCapture(chromeApi, tabId) {
  return sendContentMessage(chromeApi, tabId, { type: "CRAMBOT_AUTO_STOP" });
}
