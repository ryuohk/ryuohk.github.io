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


export const MasteryRating = {
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
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
