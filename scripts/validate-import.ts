import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { splitCardFront } from "../apps/web/src/card-content";
import { prepareBatchImport } from "../apps/web/src/importer";

const requestedPaths = process.argv.slice(2).length
  ? process.argv.slice(2).map((value) => path.resolve(value))
  : [path.resolve("capture_json_files/combined-repaired.crambot.json")];
const inputPaths: string[] = [];
for (const requestedPath of requestedPaths) {
  if ((await stat(requestedPath)).isDirectory()) {
    const names = (await readdir(requestedPath)).filter((name) => name.endsWith(".crambot.json")).sort();
    inputPaths.push(...names.map((name) => path.join(requestedPath, name)));
  } else {
    inputPaths.push(requestedPath);
  }
}
const inputs = await Promise.all(inputPaths.map(async (inputPath) => JSON.parse(await readFile(inputPath, "utf8"))));
const prepared = prepareBatchImport(inputs, [], new Date("2026-08-28T12:00:00.000Z"));
const allImages = prepared.cards.flatMap((card) => [...card.questionImages, ...card.answerImages]);
const caseStudyCards = prepared.cards.filter((card) => /case study/i.test(card.front));
const shapedCaseStudies = caseStudyCards.map((card) => splitCardFront(card.front));
const summary = {
  inputFiles: inputPaths.length,
  questions: prepared.questions.length,
  cards: prepared.cards.length,
  added: prepared.added,
  updated: prepared.updated,
  warnings: prepared.warnings.length,
  images: allImages.length,
  embeddedImages: allImages.filter((image) => image.dataUrl?.startsWith("data:image/")).length,
  missingAnswerCards: prepared.cards.filter((card) => card.confidence === "missing-answer").length,
  caseStudyCards: caseStudyCards.length,
  collapsibleCaseStudies: shapedCaseStudies.filter((content) => content.context).length,
  longestDisplayedCaseStudyQuestion: Math.max(...shapedCaseStudies.map((content) => content.prompt.length), 0),
};

if (summary.cards !== summary.questions) throw new Error(`Expected one card per question, received ${summary.cards} cards for ${summary.questions} questions.`);
if (summary.embeddedImages !== summary.images) throw new Error(`Only ${summary.embeddedImages} of ${summary.images} images are embedded.`);
if (summary.missingAnswerCards) throw new Error(`${summary.missingAnswerCards} cards still have no captured answer.`);
if (summary.collapsibleCaseStudies !== summary.caseStudyCards) throw new Error(`Only ${summary.collapsibleCaseStudies} of ${summary.caseStudyCards} case studies are collapsible.`);
console.log(JSON.stringify(summary, null, 2));
