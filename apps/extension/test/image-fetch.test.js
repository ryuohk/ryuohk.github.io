import { describe, expect, it } from "vitest";
import { ALLOWED_IMAGE_HOSTS, fetchQuestionImage } from "../src/image-fetch.js";

// Derived from the allowlist itself, so these tests stay correct if the hosts change.
const allowedHost = [...ALLOWED_IMAGE_HOSTS].at(-1);

describe("extension image fetch", () => {
  it("returns a portable data URL for an allowed image host", async () => {
    const fetchImage = async () => new Response(Uint8Array.from([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png" },
    });

    await expect(fetchQuestionImage(`https://${allowedHost}/exam-101/image258.png`, fetchImage))
      .resolves.toBe("data:image/png;base64,iVBORw==");
  });

  it("rejects hosts outside the allowlist before making a request", async () => {
    let called = false;
    const fetchImage = async () => {
      called = true;
      return new Response();
    };

    await expect(fetchQuestionImage("https://example.test/image.png", fetchImage)).rejects.toThrow(/outside the allowed/);
    expect(called).toBe(false);
  });

  it("rejects a login page masquerading as an image response", async () => {
    const fetchImage = async () => new Response("Sign in", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    await expect(fetchQuestionImage(`https://${allowedHost}/exam-101/image.png`, fetchImage)).rejects.toThrow(/text\/html/);
  });
});
