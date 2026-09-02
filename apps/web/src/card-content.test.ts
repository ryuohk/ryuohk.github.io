import { describe, expect, it } from "vitest";
import { shouldShowAnswerText, splitCapturedList, splitCardFront } from "./card-content";

describe("flashcard content shaping", () => {
  it("puts a final case-study question before collapsible reference text", () => {
    const reference = `Introductory Info\nCase Study -${"Reference material. ".repeat(80)}Question Overview stays in the reference.`;
    const content = splitCardFront(`${reference}\nQuestion\nYou need to recommend a notification solution. What should you include?\nReveal Solution\n\nA. Option one\nB. Option two`);

    expect(content.prompt).toBe("You need to recommend a notification solution. What should you include?");
    expect(content.context).toContain("Question Overview stays in the reference.");
    expect(content.choices).toEqual(["A. Option one", "B. Option two"]);
  });

  it("does not split an ordinary question containing the word question", () => {
    const content = splitCardFront("Which question format should you recommend?\n\nA. First\nB. Second");
    expect(content.prompt).toBe("Which question format should you recommend?");
    expect(content.context).toBe("");
  });

  it("handles a long case study whose final question heading was lost", () => {
    const reference = `HOTSPOT -Case Study -${"Requirements and background. ".repeat(100)}`;
    const content = splitCardFront(`${reference}.To meet the authentication requirements, what should you include?\nReveal Solution`);

    expect(content.prompt).toBe("To meet the authentication requirements, what should you include?");
    expect(content.context).toContain("Requirements and background.");
  });

  it("does not split short or malformed case-study text", () => {
    const content = splitCardFront("Case Study - Short text.\nQuestion\nWhat should you do?");
    expect(content.context).toBe("");
    expect(content.prompt).toContain("Case Study");
  });
});

describe("captured list markers", () => {
  it("recognizes both source list symbols", () => {
    expect(splitCapturedList("Requirements:✑ First requirement.✑ Second requirement.")).toEqual({
      lead: "Requirements:",
      items: ["First requirement.", "Second requirement."],
      tail: "",
    });
    expect(splitCapturedList("Services: • Monitor • Sentinel")).toEqual({
      lead: "Services:",
      items: ["Monitor", "Sentinel"],
      tail: "",
    });
  });

  it("separates the question text following the final bullet", () => {
    expect(splitCapturedList("Requirements:✑ Minimize costs.What should you recommend?")).toEqual({
      lead: "Requirements:",
      items: ["Minimize costs."],
      tail: "What should you recommend?",
    });
    expect(splitCapturedList("Includes: • Cosmos DB accountYou need to deploy the application.")).toEqual({
      lead: "Includes:",
      items: ["Cosmos DB account"],
      tail: "You need to deploy the application.",
    });
  });

  it("leaves ordinary text unchanged", () => {
    expect(splitCapturedList("What should you recommend?")).toEqual({
      lead: "What should you recommend?",
      items: [],
      tail: "",
    });
  });
});

describe("image answer text", () => {
  it("hides legacy Box-letter artifacts and the image placeholder", () => {
    expect(shouldShowAnswerText("B\nO\nX", 1)).toBe(false);
    expect(shouldShowAnswerText("See the captured answer image below.", 1)).toBe(false);
  });

  it("keeps real choice text and answers without an image", () => {
    expect(shouldShowAnswerText("B. Azure SQL Database", 1)).toBe(true);
    expect(shouldShowAnswerText("B\nO\nX", 0)).toBe(true);
  });
});
