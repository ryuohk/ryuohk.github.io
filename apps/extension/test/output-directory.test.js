import { describe, expect, it, vi } from "vitest";
import {
  captureBundleFilename,
  ensureDirectoryHandlePermission,
  writeCaptureBundleToHandle,
} from "../src/output-directory.js";
const bundle = {
  source: { examCode: "AZ-305" },
  questions: [{ id: "q1", discussion: { comments: [{ id: "c1" }] } }],
};

describe("capture output directory", () => {
  it("creates deterministic exam-specific JSON filenames", () => {
    expect(captureBundleFilename(bundle, "partial", new Date("2026-08-30T12:34:56.789Z"))).toBe(
      "crambot-az-305-2026-08-30T12-34-56-789Z-partial.crambot.json",
    );
  });

  it("restores write permission on a previously saved directory handle", async () => {
    const handle = {
      queryPermission: vi.fn().mockResolvedValue("prompt"),
      requestPermission: vi.fn().mockResolvedValue("granted"),
    };

    await expect(ensureDirectoryHandlePermission(handle, true)).resolves.toBe("granted");
    expect(handle.queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });
  });

  it("writes the complete JSON through the selected directory handle", async () => {
    const writable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const fileHandle = { createWritable: vi.fn().mockResolvedValue(writable) };
    const directoryHandle = {
      queryPermission: vi.fn().mockResolvedValue("granted"),
      getFileHandle: vi.fn().mockResolvedValue(fileHandle),
    };

    const filename = await writeCaptureBundleToHandle(
      directoryHandle,
      bundle,
      "partial",
      new Date("2026-08-30T12:34:56.789Z"),
    );

    expect(directoryHandle.getFileHandle).toHaveBeenCalledWith(filename, { create: true });
    expect(writable.write).toHaveBeenCalledWith(JSON.stringify(bundle, null, 2));
    expect(writable.close).toHaveBeenCalledOnce();
    expect(writable.abort).not.toHaveBeenCalled();
  });

  it("refuses to write after folder permission expires", async () => {
    const directoryHandle = { queryPermission: vi.fn().mockResolvedValue("prompt") };
    await expect(writeCaptureBundleToHandle(directoryHandle, bundle)).rejects.toThrow(/access expired/i);
  });
});
