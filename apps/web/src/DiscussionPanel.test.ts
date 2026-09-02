import { describe, expect, it } from "vitest";
import { buildDiscussionForest } from "./DiscussionPanel";
import type { DiscussionComment } from "./types";

function comment(id: string, parentId: string | null = null): DiscussionComment {
  return {
    id,
    parentId,
    author: `Author ${id}`,
    authorUrl: "",
    postedAt: "",
    relativeTime: "",
    selectedAnswers: [],
    content: `Comment ${id}`,
    links: [],
    upvotes: 0,
    badges: [],
  };
}

describe("discussion threading", () => {
  it("preserves root comments, replies, and nested replies", () => {
    const forest = buildDiscussionForest([
      comment("root"),
      comment("reply", "root"),
      comment("nested", "reply"),
      comment("second-root"),
    ]);

    expect(forest.map((node) => node.comment.id)).toEqual(["root", "second-root"]);
    expect(forest[0].replies[0].comment.id).toBe("reply");
    expect(forest[0].replies[0].replies[0].comment.id).toBe("nested");
  });

  it("keeps cyclic source comments visible as roots", () => {
    const forest = buildDiscussionForest([comment("one", "two"), comment("two", "one")]);
    expect(forest.map((node) => node.comment.id)).toEqual(["one", "two"]);
  });
});
