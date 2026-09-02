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

export function splitCardFront(front: string): CardContent {
  const [rawPrompt, ...choiceBlocks] = front.split("\n\n");
  const choices = choiceBlocks.join("\n\n").split("\n").filter(Boolean);
  const promptWithoutControlText = rawPrompt.replace(/\n?Reveal Solution\s*$/i, "").trim();
  const marker = "\nQuestion\n";
  const markerIndex = promptWithoutControlText.lastIndexOf(marker);
  const looksLikeCaseStudy = /(?:^|\n)(?:Introductory Info\n)?(?:HOTSPOT\s*-)?Case Study\s*-/i.test(promptWithoutControlText.slice(0, 500));

  if (looksLikeCaseStudy && markerIndex >= 1000) {
    return {
      prompt: promptWithoutControlText.slice(markerIndex + marker.length).trim(),
      context: promptWithoutControlText.slice(0, markerIndex).trim(),
      choices,
    };
  }

  const fallbackMarker = ".To meet ";
  const fallbackIndex = promptWithoutControlText.lastIndexOf(fallbackMarker);
  if (looksLikeCaseStudy && fallbackIndex >= promptWithoutControlText.length * 0.7) {
    return {
      prompt: promptWithoutControlText.slice(fallbackIndex + 1).trim(),
      context: promptWithoutControlText.slice(0, fallbackIndex + 1).trim(),
      choices,
    };
  }

  return { prompt: promptWithoutControlText, context: "", choices };
}
