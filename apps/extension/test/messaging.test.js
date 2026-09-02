import { describe, expect, it, vi } from "vitest";
import { requestPageCapture, startAutomaticCapture, stopAutomaticCapture } from "../src/messaging.js";

function chromeMock(sendMessage, executeScript = vi.fn().mockResolvedValue(undefined)) {
  return {
    tabs: { sendMessage },
    scripting: { executeScript },
  };
}

describe("capture messaging", () => {
  it("uses an existing page listener without injecting", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const chromeApi = chromeMock(sendMessage);

    await expect(requestPageCapture(chromeApi, 17)).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("sends explicit start and stop commands for automatic capture", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    const chromeApi = chromeMock(sendMessage);

    await startAutomaticCapture(chromeApi, 17);
    await stopAutomaticCapture(chromeApi, 17);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 17, { type: "CRAMBOT_AUTO_START" });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 17, { type: "CRAMBOT_AUTO_STOP" });
  });

  it("injects the content script and retries when no receiver exists", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce({ ok: true, bundle: { questions: [] } });
    const chromeApi = chromeMock(sendMessage);

    await expect(requestPageCapture(chromeApi, 23)).resolves.toMatchObject({ ok: true });
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 23 },
      files: ["content.js"],
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not hide unrelated messaging errors", async () => {
    const failure = new Error("The tab was closed.");
    const sendMessage = vi.fn().mockRejectedValue(failure);
    const chromeApi = chromeMock(sendMessage);

    await expect(requestPageCapture(chromeApi, 29)).rejects.toBe(failure);
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("surfaces an injection failure without retrying indefinitely", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("Receiving end does not exist."));
    const injectionFailure = new Error("Cannot access this page.");
    const chromeApi = chromeMock(sendMessage, vi.fn().mockRejectedValue(injectionFailure));

    await expect(requestPageCapture(chromeApi, 31)).rejects.toBe(injectionFailure);
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
