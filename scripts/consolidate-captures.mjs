import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeCaptureBundle, parseCaptureBundle } from "../packages/core/src/index.js";

const inputDirectory = path.resolve(process.argv[2] || "capture_json_files");
const outputPath = path.resolve(process.argv[3] || path.join(inputDirectory, "combined-repaired.crambot.json"));
const outputName = path.basename(outputPath);

function embeddedCount(question) {
  return question.images.filter((image) => image.dataUrl?.startsWith("data:image/")).length;
}

function qualityScore(question) {
  return embeddedCount(question) * 100
    + question.correctAnswers.length * 10
    + question.mostVotedAnswers.length * 5
    + (question.explanation ? 1 : 0)
    + (question.discussion?.comments.length || 0);
}

async function fetchImageData(source) {
  const parsed = new URL(source);
  if (parsed.protocol !== "https:" || !["www.examtopics.com", "img.examtopics.com"].includes(parsed.hostname)) {
    throw new Error("URL is outside the allowed image hosts.");
  }
  const response = await fetch(parsed.href);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0].trim() || "";
  if (!contentType.startsWith("image/")) throw new Error(`Expected an image but received ${contentType || "an unknown content type"}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${bytes.toString("base64")}`;
}

async function mapWithConcurrency(items, concurrency, action) {
  let nextIndex = 0;
  const results = new Array(items.length);
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await action(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const filenames = (await readdir(inputDirectory))
  .filter((name) => name.endsWith(".crambot.json") && name !== outputName)
  .sort();
if (!filenames.length) throw new Error(`No capture files found in ${inputDirectory}`);

const byId = new Map();
let sourceRows = 0;
const sources = [];
for (const filename of filenames) {
  const input = JSON.parse(await readFile(path.join(inputDirectory, filename), "utf8"));
  const bundle = parseCaptureBundle(input);
  sources.push(bundle.source);
  sourceRows += bundle.questions.length;
  for (const question of bundle.questions) {
    const existing = byId.get(question.id);
    if (!existing || qualityScore(question) > qualityScore(existing)) byId.set(question.id, question);
  }
}

const questions = [...byId.values()];
const missingSources = [...new Set(questions.flatMap((question) => question.images)
  .filter((image) => !image.dataUrl)
  .map((image) => image.src))];
const imageResults = new Map();
await mapWithConcurrency(missingSources, 4, async (source) => {
  try {
    imageResults.set(source, { dataUrl: await fetchImageData(source) });
  } catch (error) {
    imageResults.set(source, { error: error instanceof Error ? error.message : String(error) });
  }
});

for (const question of questions) {
  question.images = question.images.map((image) => {
    if (image.dataUrl) return image;
    const result = imageResults.get(image.src);
    return result?.dataUrl ? { ...image, dataUrl: result.dataUrl } : image;
  });
}

const examCodes = [...new Set(questions.map((question) => question.examCode).filter(Boolean))];
const providers = [...new Set(sources.map((source) => source.provider).filter(Boolean))];
const pageUrls = [...new Set(sources.map((source) => source.pageUrl).filter(Boolean))];
const exportedAt = new Date().toISOString();
const bundle = makeCaptureBundle(questions, {
  provider: providers.length === 1 ? providers[0] : "Multiple providers",
  examCode: examCodes.length === 1 ? examCodes[0] : "MULTIPLE",
  sourceUrl: pageUrls.length === 1 ? pageUrls[0] : "",
  exportedAt,
});
const failedImages = [...imageResults].filter(([, result]) => result.error);
bundle.warnings.push(...failedImages.map(([source, result]) => `Could not repair image ${source}: ${result.error}`));
bundle.capture = {
  combinedFrom: filenames,
  sourceRows,
  duplicatesRemoved: sourceRows - bundle.questions.length,
  images: {
    found: bundle.questions.reduce((count, question) => count + question.images.length, 0),
    embedded: bundle.questions.reduce((count, question) => count + embeddedCount(question), 0),
    failed: failedImages.length,
  },
};

await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  outputPath,
  sourceFiles: filenames.length,
  sourceRows,
  questions: bundle.questions.length,
  duplicatesRemoved: bundle.capture.duplicatesRemoved,
  images: bundle.capture.images,
  warnings: bundle.warnings.length,
}, null, 2));
