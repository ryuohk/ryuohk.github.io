export interface Choice {
  label: string;
  text: string;
}

export interface DiscussionComment {
  id: string;
  parentId: string | null;
  author: string;
  authorUrl: string;
  postedAt: string;
  relativeTime: string;
  selectedAnswers: string[];
  content: string;
  links: Array<{ text: string; url: string }>;
  upvotes: number;
  badges: string[];
}

export interface CapturedDiscussion {
  id: string;
  title: string;
  sourceUrl: string;
  isComplete: boolean;
  comments: DiscussionComment[];
}

export interface CapturedQuestion {
  id: string;
  examCode: string;
  sourceUrl: string;
  topic: string;
  number: string;
  prompt: string;
  choices: Choice[];
  correctAnswers: string[];
  mostVotedAnswers: string[];
  voteDistribution: Array<{ label: string; percent: number }>;
  explanation: string;
  discussionCount: number | null;
  discussion: CapturedDiscussion | null;
  images: Array<{ src: string; alt: string; role: "question" | "answer"; dataUrl?: string }>;
  capturedAt: string;
}

export interface GeneratedCard {
  id: string;
  questionId: string;
  type: string;
  front: string;
  back: string;
  explanation: string;
  questionImages: Array<{ src: string; alt: string; role: "question"; dataUrl?: string }>;
  answerImages: Array<{ src: string; alt: string; role: "answer"; dataUrl?: string }>;
  tags: string[];
  confidence: "source-answer" | "community-only" | "missing-answer";
  sourceUrl: string;
  createdAt: string;
}


/**
 * What you said about a question the last time you were asked it.
 *
 * The numbers are the storage format and never change meaning, because they are
 * already written on every device and in the cloud. The names have changed twice as
 * the app's model did, so read the number, not the history:
 *
 *   1  Again      -> Not yet.    Stays in the Mastery pool and comes round again.
 *   2  Hard       -> retired. Written by builds before the labels were cut to two.
 *   3  Good       -> retired, likewise. Both read as Not yet, which is how they
 *                    always behaved: neither ever left the pool.
 *   4  KeepFresh  -> Keep fresh. Leaves the Mastery pool and joins the Review queue.
 *                    This was called Easy, and before that it was Anki's Easy button.
 *                    Every question already marked with it keeps behaving exactly as
 *                    it did, which is why the middle rung reuses this number rather
 *                    than the new one.
 *   5  GotIt      -> Got it. Leaves the pool and is not reviewed either, unless you
 *                    ask for it. New, so nothing carries it until you press it.
 *
 * Ordered weakest to strongest, and the database checks the range, so a new state
 * has to be added at the end and the check widened to match.
 */
export const MasteryRating = {
  Again: 1,
  Hard: 2,
  Good: 3,
  KeepFresh: 4,
  GotIt: 5,
} as const;

export type MasteryRating = typeof MasteryRating[keyof typeof MasteryRating];

export interface StudyCard extends GeneratedCard {
  masteryRating: MasteryRating | null;
  ratingUpdatedAt: string | null;
  updatedAt: string;
  notes?: string;
  feedbackFlags?: Array<"unclear" | "wrong-answer" | "outdated">;
  /**
   * Who contributed this to the shared library, filled in by sync. Undefined for
   * cards that only exist locally or predate ownership tracking; the interface
   * treats those as deletable, and the database has the final say either way.
   */
  createdBy?: string;
}

export interface ReviewLog {
  id: string;
  cardId: string;
  rating: MasteryRating;
  reviewedAt: string;
}
