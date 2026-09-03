import { describe, expect, it } from "vitest";
import { repairRunTogetherText, shouldShowAnswerText, splitCapturedList, splitCardFront } from "./card-content";

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

/**
 * Repairing text the capture ran together.
 *
 * Source pages join inline runs with no separator, so questions arrive as
 * "an Azure subscription.You need to". The stored text is left as captured on purpose,
 * because a question's identity is a hash of its prompt and rewriting it at capture
 * time would duplicate everything already in the shared library.
 */
describe("repairRunTogetherText", () => {
  it("separates a sentence that runs into the next", () => {
    expect(repairRunTogetherText("You have an Azure subscription.You need to deploy a database."))
      .toBe("You have an Azure subscription. You need to deploy a database.");
  });

  it("separates a colon or comma from what follows", () => {
    expect(repairRunTogetherText("meet the following requirements:Support read-only replicas."))
      .toBe("meet the following requirements: Support read-only replicas.");
    expect(repairRunTogetherText("minimize cost,Maximize availability"))
      .toBe("minimize cost, Maximize availability");
  });

  it("separates the question type marker that opens most questions", () => {
    expect(repairRunTogetherText("HOTSPOT -You have an Azure subscription."))
      .toBe("HOTSPOT - You have an Azure subscription.");
    expect(repairRunTogetherText("DRAG DROP -Match each service."))
      .toBe("DRAG DROP - Match each service.");
  });

  it("leaves an acronym alone", () => {
    // The letter before the stop is uppercase, so this is not a sentence ending.
    expect(repairRunTogetherText("The U.S.A region")).toBe("The U.S.A region");
    expect(repairRunTogetherText("Use ASP.NET Core")).toBe("Use ASP.NET Core");
    expect(repairRunTogetherText("Target .NET applications")).toBe("Target .NET applications");
  });

  it("leaves version numbers and decimals alone", () => {
    expect(repairRunTogetherText("version 1.2 of the API")).toBe("version 1.2 of the API");
    expect(repairRunTogetherText("costs 10.50 per month")).toBe("costs 10.50 per month");
  });

  it("leaves correctly spaced text untouched, and is safe to run twice", () => {
    const clean = "You have an Azure subscription. You need to deploy a database.";
    expect(repairRunTogetherText(clean)).toBe(clean);
    expect(repairRunTogetherText(repairRunTogetherText("a subscription.You need"))).toBe("a subscription. You need");
  });

  it("survives empty and malformed input", () => {
    expect(repairRunTogetherText("")).toBe("");
    expect(repairRunTogetherText(undefined as unknown as string)).toBe("");
  });
});

describe("splitCardFront applies the repair", () => {
  it("repairs the prompt and every choice", () => {
    const content = splitCardFront("HOTSPOT -You have a subscription.You need a database.\n\nA. Use replicas.Enable balancing\nB. Use a pool");

    expect(content.prompt).toBe("HOTSPOT - You have a subscription. You need a database.");
    expect(content.choices[0]).toBe("A. Use replicas. Enable balancing");
  });

  it("still finds the case study marker, which the repair would otherwise rewrite", () => {
    const context = `HOTSPOT -Case Study -${"Contoso operates two datacenters and needs a plan. ".repeat(30)}`;
    const content = splitCardFront(`${context}.To meet the technical requirements, what should you deploy?`);

    expect(content.context).not.toBe("");
    expect(content.prompt.startsWith("To meet the technical requirements")).toBe(true);
  });
});
