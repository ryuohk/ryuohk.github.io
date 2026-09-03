export interface CardContent {
  prompt: string;
  context: string;
  choices: string[];
}

export interface CapturedList {
  lead: string;
  items: string[];
  tail: string;
}

/**
 * Restores spaces the capture never had.
 *
 * Source pages run inline text together, so a question arrives as "an Azure
 * subscription.You need to deploy" and both reads and sounds that way. The stored text
 * is deliberately left as captured: a question's identity is a hash of its prompt, so
 * repairing it at capture time would make every question a stranger to the copy already
 * in the shared library and duplicate the lot. This runs on the way to the screen
 * instead, which costs nothing and fixes what is already stored.
 *
 * Both rules require a lowercase letter or digit before the punctuation, so an acronym
 * like U.S.A is left alone. ".NET" is excluded by name, being common enough here to be
 * worth the exception.
 */
export function repairRunTogetherText(text: string): string {
  return String(text ?? "")
    .replace(/([a-z0-9])([.!?:;,])(?!NET\b)([A-Z])/g, "$1$2 $3")
    // "HOTSPOT -You have" and "DRAG DROP -Match the" open a great many questions.
    .replace(/(\s-)(?=[A-Z])/g, "$1 ");
}

/**
 * Drops the "A." from the front of a choice, leaving the choice itself.
 *
 * Shuffling the rows achieves nothing while the labels are on show: the letters are in
 * the captured order whatever the rows do, so a question answered before is still
 * answerable from "it was C". The label is only hidden while the answer is hidden, and
 * comes back on reveal so the stated answer, the highlighting and the discussion all
 * refer to the same letters again.
 *
 * The separator has to be a stop or a bracket. A hyphen would take the "A" off choices
 * like "A-Series virtual machines".
 */
export function stripChoiceLabel(choice: string): string {
  return String(choice ?? "").replace(/^\s*[A-Za-z][.)]\s*(?=\S)/, "");
}

const CAPTURED_LIST_MARKER = /\s*[✑•]\s*/;
const CAPTURED_LIST_TAIL = /(?:What\b|Which\b|How\b|To meet\b|You need\b|The solution\b|The monitoring solution\b|Solution:|Box \d+:|Incorrect Answers:)/;

export function splitCapturedList(text: string): CapturedList {
  const parts = text.split(CAPTURED_LIST_MARKER);
  if (parts.length === 1) return { lead: text, items: [], tail: "" };

  const items = parts.slice(1).map((part) => part.trim()).filter(Boolean);
  let tail = "";
  const lastItem = items.at(-1);
  const tailMatch = lastItem?.slice(1).match(CAPTURED_LIST_TAIL);
  if (lastItem && tailMatch?.index !== undefined) {
    const tailIndex = tailMatch.index + 1;
    items[items.length - 1] = lastItem.slice(0, tailIndex).trim();
    tail = lastItem.slice(tailIndex).trim();
  }

  return {
    lead: parts[0].trim(),
    items,
    tail,
  };
}

const IMAGE_ANSWER_PLACEHOLDER = "See the captured answer image below.";

export function shouldShowAnswerText(back: string, answerImageCount: number): boolean {
  if (answerImageCount === 0) return true;
  const normalized = back.trim();
  if (normalized === IMAGE_ANSWER_PLACEHOLDER) return false;
  return !/^(?:[A-Z]\s*)+$/.test(normalized);
}

/**
 * Applied to the pieces rather than the whole card, because the split above hunts for
 * markers like ".To meet " that the repair would rewrite out from under it.
 */
function repaired(content: CardContent): CardContent {
  return {
    prompt: repairRunTogetherText(content.prompt),
    context: repairRunTogetherText(content.context),
    choices: content.choices.map(repairRunTogetherText),
  };
}

export function splitCardFront(front: string): CardContent {
  const [rawPrompt, ...choiceBlocks] = front.split("\n\n");
  const choices = choiceBlocks.join("\n\n").split("\n").filter(Boolean);
  const promptWithoutControlText = rawPrompt.replace(/\n?Reveal Solution\s*$/i, "").trim();
  const marker = "\nQuestion\n";
  const markerIndex = promptWithoutControlText.lastIndexOf(marker);
  const looksLikeCaseStudy = /(?:^|\n)(?:Introductory Info\n)?(?:HOTSPOT\s*-)?Case Study\s*-/i.test(promptWithoutControlText.slice(0, 500));

  if (looksLikeCaseStudy && markerIndex >= 1000) {
    return repaired({
      prompt: promptWithoutControlText.slice(markerIndex + marker.length).trim(),
      context: promptWithoutControlText.slice(0, markerIndex).trim(),
      choices,
    });
  }

  const fallbackMarker = ".To meet ";
  const fallbackIndex = promptWithoutControlText.lastIndexOf(fallbackMarker);
  if (looksLikeCaseStudy && fallbackIndex >= promptWithoutControlText.length * 0.7) {
    return repaired({
      prompt: promptWithoutControlText.slice(fallbackIndex + 1).trim(),
      context: promptWithoutControlText.slice(0, fallbackIndex + 1).trim(),
      choices,
    });
  }

  return repaired({ prompt: promptWithoutControlText, context: "", choices });
}
