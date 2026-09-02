// The only hosts the background worker will fetch images from during a capture.
// Exported so callers and tests derive the list rather than restating it.
export const ALLOWED_IMAGE_HOSTS = new Set(["www.examtopics.com", "img.examtopics.com"]);

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function fetchQuestionImage(url, fetchImage = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
    throw new Error("Image URL is outside the allowed image hosts.");
  }

  const response = await fetchImage(parsed.href);
  if (!response.ok) throw new Error(`Image request failed with status ${response.status}.`);
  const contentType = response.headers.get("content-type")?.split(";")[0].trim() || "";
  if (!contentType.startsWith("image/")) throw new Error(`Image request returned ${contentType || "an unknown content type"}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}
