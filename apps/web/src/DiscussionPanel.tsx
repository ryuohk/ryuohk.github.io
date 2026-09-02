import { useState } from "react";
import type { CapturedDiscussion, DiscussionComment } from "./types";

export interface DiscussionNode {
  comment: DiscussionComment;
  replies: DiscussionNode[];
}

export function buildDiscussionForest(comments: readonly DiscussionComment[]): DiscussionNode[] {
  const nodeById = new Map(comments.map((comment) => [comment.id, { comment, replies: [] as DiscussionNode[] }]));
  const roots: DiscussionNode[] = [];

  for (const comment of comments) {
    const node = nodeById.get(comment.id);
    if (!node) continue;
    const parent = comment.parentId ? nodeById.get(comment.parentId) : undefined;
    if (!parent || parent === node) {
      roots.push(node);
      continue;
    }

    let ancestor: DiscussionNode | undefined = parent;
    let cyclic = false;
    while (ancestor) {
      if (ancestor === node) {
        cyclic = true;
        break;
      }
      ancestor = ancestor.comment.parentId ? nodeById.get(ancestor.comment.parentId) : undefined;
    }
    if (cyclic) roots.push(node);
    else parent.replies.push(node);
  }
  return roots;
}

function safeHttpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function DiscussionCommentView({ node }: { node: DiscussionNode }) {
  const { comment } = node;
  const authorUrl = safeHttpUrl(comment.authorUrl);
  const links = comment.links
    .map((link) => ({ ...link, url: safeHttpUrl(link.url) }))
    .filter((link) => link.url);
  const uniqueLinks = links.filter((link, index) => links.findIndex((candidate) => candidate.url === link.url) === index);
  return (
    <article className="discussion-comment">
      <header>
        <strong>{authorUrl
          ? <a href={authorUrl} target="_blank" rel="noreferrer">{comment.author || "Anonymous"}</a>
          : comment.author || "Anonymous"}</strong>
        {(comment.postedAt || comment.relativeTime) && <span title={comment.relativeTime || undefined}>{comment.postedAt || comment.relativeTime}</span>}
        {comment.upvotes > 0 && <span>{comment.upvotes} upvote{comment.upvotes === 1 ? "" : "s"}</span>}
      </header>
      <div className="discussion-badges">
        {comment.selectedAnswers.length > 0 && <span className="selected-answer">Selected {comment.selectedAnswers.join(", ")}</span>}
        {comment.badges.map((badge) => <span key={badge}>{badge}</span>)}
      </div>
      <p className="discussion-content">{comment.content}</p>
      {uniqueLinks.length > 0 && <div className="discussion-links" aria-label="Comment links">{uniqueLinks.map((link) => (
        <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.text || link.url}</a>
      ))}</div>}
      {node.replies.length > 0 && <div className="discussion-replies">{node.replies.map((reply) => <DiscussionCommentView key={reply.comment.id} node={reply} />)}</div>}
    </article>
  );
}

const OPEN_KEY = "crambot.discussion.open";

function readOpenPreference(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function DiscussionPanel({ discussion, expectedCount }: { discussion: CapturedDiscussion; expectedCount: number | null }) {
  const [open, setOpen] = useState(readOpenPreference);
  const roots = buildDiscussionForest(discussion.comments);
  const total = discussion.comments.length;
  const shortfall = expectedCount !== null && expectedCount !== total ? ` of ${expectedCount}` : "";
  return (
    <details
      className="discussion-panel"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        try {
          localStorage.setItem(OPEN_KEY, String(next));
        } catch {
          // A browser with site data disabled simply does not remember the preference.
        }
      }}
    >
      <summary>
        <span className="answer-label">DISCUSSION</span>
        <span className="discussion-count">{total} comment{total === 1 ? "" : "s"}{shortfall}</span>
      </summary>
      {!discussion.isComplete && <p className="discussion-warning">This discussion was not completely captured.</p>}
      {roots.length > 0
        ? <div className="discussion-comments">{roots.map((node) => <DiscussionCommentView key={node.comment.id} node={node} />)}</div>
        : <p className="discussion-empty">No discussion comments were present when this question was captured.</p>}
    </details>
  );
}
