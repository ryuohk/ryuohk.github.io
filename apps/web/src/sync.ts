import {
  applyRemoteDeletions,
  applyRemoteLibrary,
  clearPending,
  listCards,
  listPending,
  listQuestions,
  listReviews,
  type PendingEntry,
} from "./db";
import { requireSupabase } from "./supabase";
import {
  lastServerStudyStateAt,
  markStudyStateSynced,
  readLocalStudyState,
  stableStringify,
  studyStateChanged,
  writeLocalStudyState,
} from "./study-state";
import type { CapturedQuestion, GeneratedCard, MasteryRating, ReviewLog, StudyCard } from "./types";

/**
 * Two-way sync between this device's IndexedDB and the shared Supabase library.
 *
 * Shared:  questions and card content, so either person's imports help both.
 * Private: FSRS schedule, notes, flags and the review log, keyed to the signed-in user.
 *
 * Push runs before pull, so on a conflict the newest upload wins and this device
 * never clobbers work it just sent. Rows are pulled by an `updated_at` watermark
 * with a small overlap so a commit landing mid-sync is not skipped.
 */

const WATERMARK_PREFIX = "crambot-sync-watermark";
const OVERLAP_MS = 15_000;
const EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * Card and question rows carry base64 images inline and vary wildly in size, so
 * uploads are capped by payload bytes rather than row count. A 286-question exam
 * library runs to tens of megabytes; sending it as a few huge requests fails.
 */
const CONTENT_PAGE = 25;
const RECORD_PAGE = 400;
const MAX_UPLOAD_BYTES = 2_000_000;

export interface SyncResult {
  pushed: number;
  pulled: number;
  deleted: number;
  /** True when the in-progress set was replaced by newer state from another device. */
  stateAdopted: boolean;
}

interface QuestionRow { id: string; data: CapturedQuestion; updated_at: string }
interface CardRow { id: string; question_id: string; data: GeneratedCard; updated_at: string }
export interface ProgressRow {
  card_id: string;
  mastery_rating: MasteryRating | null;
  rating_updated_at: string | null;
  notes: string | null;
  feedback_flags: string[] | null;
  updated_at: string;
}
interface ReviewRow { id: string; card_id: string; rating: MasteryRating; reviewed_at: string; created_at: string }
interface DeletionRow { entity_type: "card" | "question"; entity_id: string; deleted_at: string }

function watermarkKey(userId: string): string {
  return `${WATERMARK_PREFIX}:${userId}`;
}

export function readWatermark(userId: string): string {
  try {
    return localStorage.getItem(watermarkKey(userId)) ?? EPOCH;
  } catch {
    return EPOCH;
  }
}

function writeWatermark(userId: string, value: string): void {
  try {
    localStorage.setItem(watermarkKey(userId), value);
  } catch {
    // A full or blocked storage quota only costs us a larger next query.
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += size) pages.push(items.slice(index, index + size));
  return pages;
}

/**
 * Supabase rejects with a plain `{ message, details, hint, code }` object rather than
 * an Error, so `String(problem)` renders it as "[object Object]" and the reason for a
 * stalled queue becomes invisible. This keeps whatever detail the failure carries.
 */
export function describeSyncError(problem: unknown): string {
  if (problem instanceof Error && problem.message) return problem.message;
  if (problem && typeof problem === "object") {
    const detail = problem as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const text = [detail.message, detail.details, detail.hint]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .map((part) => part.trim())
      .join(" · ");
    const code = typeof detail.code === "string" && detail.code.trim() !== "" ? detail.code.trim() : "";
    if (text) return code ? `${text} (${code})` : text;
    if (code) return `The sync service rejected the request with code ${code}.`;
    try {
      const json = JSON.stringify(problem);
      if (json && json !== "{}") return json;
    } catch {
      // A circular payload falls through to the generic message below.
    }
  }
  const rendered = String(problem);
  return rendered && rendered !== "[object Object]"
    ? rendered
    : "The sync service returned an error with no message.";
}

/**
 * Names the stage and the size of the page that failed. One rejected page aborts the
 * whole push, so the queue stops draining until that specific request is understood.
 */
function assertUploaded(stage: string, error: unknown, rows: number, bytes = 0): void {
  if (!error) return;
  const size = bytes > 0 ? `, ${(bytes / 1_000_000).toFixed(2)} MB` : "";
  throw new Error(`${stage} failed (${rows} row${rows === 1 ? "" : "s"}${size}): ${describeSyncError(error)}`);
}

function pageBytes(page: unknown[]): number {
  try {
    return JSON.stringify(page)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Splits rows into pages bounded by both row count and serialized size. A single
 * row larger than the byte budget still goes alone, since it cannot be split.
 */
export function chunkBySize<T>(items: T[], maxRows: number, maxBytes: number): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = JSON.stringify(item)?.length ?? 0;
    if (page.length > 0 && (page.length >= maxRows || bytes + size > maxBytes)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(item);
    bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/** Splits a StudyCard into the half everyone shares and the half that stays private. */
export function splitCard(card: StudyCard): { content: GeneratedCard; progress: Omit<ProgressRow, "updated_at"> } {
  const { masteryRating, ratingUpdatedAt, updatedAt: _updatedAt, notes, feedbackFlags, schedule: _schedule, suspended: _suspended, ...content } = card as StudyCard & { schedule?: unknown; suspended?: boolean };
  return {
    content,
    progress: {
      card_id: card.id,
      mastery_rating: masteryRating,
      rating_updated_at: ratingUpdatedAt,
      notes: notes ?? null,
      feedback_flags: feedbackFlags ?? null,
    },
  };
}

export function joinCard(content: GeneratedCard, progress: ProgressRow | undefined, fallback: StudyCard | undefined): StudyCard {
  // Callers sometimes pass a local StudyCard as the content half. Strip the private
  // fields off it first, or a cleared note would survive by riding along in the spread.
  const {
    masteryRating: _masteryRating,
    ratingUpdatedAt: _ratingUpdatedAt,
    updatedAt: _updatedAt,
    notes: _notes,
    feedbackFlags: _flags,
    schedule: _schedule,
    suspended: _suspended,
    ...shared
  } = content as StudyCard & { schedule?: unknown; suspended?: boolean };

  const masteryRating = progress ? progress.mastery_rating : fallback?.masteryRating ?? null;
  const ratingUpdatedAt = progress ? progress.rating_updated_at : fallback?.ratingUpdatedAt ?? null;
  const notes = progress ? progress.notes ?? undefined : fallback?.notes;
  const flags = progress ? progress.feedback_flags ?? undefined : fallback?.feedbackFlags;
  return {
    ...shared,
    masteryRating,
    ratingUpdatedAt,
    updatedAt: progress?.updated_at ?? fallback?.updatedAt ?? shared.createdAt,
    ...(notes ? { notes } : {}),
    ...(flags?.length ? { feedbackFlags: flags as StudyCard["feedbackFlags"] } : {}),
  };
}

function latest(current: string, candidate: string | undefined): string {
  if (!candidate) return current;
  return candidate > current ? candidate : current;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface ResolvedIntents {
  questionIds: Set<string>;
  cardIds: Set<string>;
  progressIds: Set<string>;
  reviewIds: Set<string>;
  deletedCardIds: string[];
  deletedQuestionIds: string[];
  /** Queue keys that the opposite, later intent has overruled. */
  superseded: string[];
}

/**
 * Decides what the queue actually means when it holds contradictory intents.
 *
 * The same id can be queued as both re-added and deleted, for instance if the
 * library was cleared and then the same capture re-imported. Deletions are pushed
 * last, so sending both would upload the cards and immediately tombstone them,
 * wiping the shared library for everyone including the other member. Only the
 * intent queued later is real; the earlier one is reported as superseded so the
 * caller can drop it from the queue.
 */
export function resolvePendingIntents(pending: readonly PendingEntry[]): ResolvedIntents {
  const of = (kind: PendingEntry["kind"]) => pending.filter((entry) => entry.kind === kind);
  const questionIds = new Set(of("question").map((entry) => entry.entityId));
  const cardIds = new Set(of("card").map((entry) => entry.entityId));
  const progressIds = new Set(of("progress").map((entry) => entry.entityId));
  const reviewIds = new Set(of("review").map((entry) => entry.entityId));

  const queuedAt = new Map(pending.map((entry) => [entry.key, entry.queuedAt]));
  const superseded: string[] = [];

  const resolve = (kind: "card" | "question", live: Set<string>, alsoDrop?: Set<string>): string[] =>
    of(`${kind}-deleted`)
      .map((entry) => entry.entityId)
      .filter((id) => {
        if (!live.has(id)) return true;
        const addedAt = queuedAt.get(`${kind}:${id}`) ?? "";
        const deletedAt = queuedAt.get(`${kind}-deleted:${id}`) ?? "";
        if (addedAt > deletedAt) {
          superseded.push(`${kind}-deleted:${id}`);
          return false;
        }
        superseded.push(`${kind}:${id}`);
        live.delete(id);
        if (alsoDrop?.delete(id)) superseded.push(`progress:${id}`);
        return true;
      });

  const deletedCardIds = resolve("card", cardIds, progressIds);
  const deletedQuestionIds = resolve("question", questionIds);

  return { questionIds, cardIds, progressIds, reviewIds, deletedCardIds, deletedQuestionIds, superseded };
}

/**
 * `settle` runs after every successful page rather than once at the end, so a large
 * first upload that dies halfway through does not restart from zero, and the queue
 * count visibly drains while it works.
 */
async function pushChanges(
  userId: string,
  pending: PendingEntry[],
  settle: (keys: string[]) => Promise<void>,
): Promise<number> {
  const client = requireSupabase();
  let pushed = 0;

  const { questionIds, cardIds, progressIds, reviewIds, deletedCardIds, deletedQuestionIds, superseded } =
    resolvePendingIntents(pending);
  if (superseded.length) await settle(superseded);

  const needsLocalData = questionIds.size || cardIds.size || progressIds.size || reviewIds.size;
  const [questions, cards, reviews] = needsLocalData
    ? await Promise.all([listQuestions(), listCards(), listReviews()])
    : [[], [], []];

  const cardById = new Map(cards.map((card) => [card.id, card]));

  const questionRows = questions
    .filter((question) => questionIds.has(question.id))
    .map((question) => ({ id: question.id, data: question }));
  const cardRows = [...cardIds]
    .map((id) => cardById.get(id))
    .filter((card): card is StudyCard => Boolean(card))
    .map((card) => {
      const { content } = splitCard(card);
      return { id: card.id, question_id: card.questionId, data: content };
    });

  // Lift tombstones first: re-importing something previously deleted has to clear
  // the "deleted" marker before the content lands, or the next pull removes it again.
  for (const [entityType, ids] of [
    ["card", cardRows.map((row) => row.id)],
    ["question", questionRows.map((row) => row.id)],
  ] as const) {
    for (const page of chunk(ids, RECORD_PAGE)) {
      const { error } = await client.from("deletions").delete().eq("entity_type", entityType).in("entity_id", page);
      assertUploaded(`Clearing ${entityType} tombstones`, error, page.length);
    }
  }

  // Shared questions.
  for (const page of chunkBySize(questionRows, CONTENT_PAGE, MAX_UPLOAD_BYTES)) {
    const { error } = await client.from("questions").upsert(page, { onConflict: "id" });
    assertUploaded("Uploading questions", error, page.length, pageBytes(page));
    pushed += page.length;
    await settle(page.map((row) => `question:${row.id}`));
  }

  // Shared card content.
  for (const page of chunkBySize(cardRows, CONTENT_PAGE, MAX_UPLOAD_BYTES)) {
    const { error } = await client.from("cards").upsert(page, { onConflict: "id" });
    assertUploaded("Uploading card content", error, page.length, pageBytes(page));
    pushed += page.length;
    await settle(page.map((row) => `card:${row.id}`));
  }

  // Private progress.
  const progressRows = [...progressIds]
    .map((id) => cardById.get(id))
    .filter((card): card is StudyCard => Boolean(card))
    .map((card) => ({ user_id: userId, ...splitCard(card).progress }));
  for (const page of chunk(progressRows, RECORD_PAGE)) {
    const { error } = await client.from("card_progress").upsert(page, { onConflict: "user_id,card_id" });
    assertUploaded("Uploading mastery progress", error, page.length);
    pushed += page.length;
    await settle(page.map((row) => `progress:${row.card_id}`));
  }

  // Private review log.
  const reviewRows = reviews
    .filter((review) => reviewIds.has(review.id))
    .map((review) => ({
      id: review.id,
      user_id: userId,
      card_id: review.cardId,
      rating: review.rating,
      reviewed_at: review.reviewedAt,
    }));
  for (const page of chunk(reviewRows, RECORD_PAGE)) {
    const { error } = await client.from("reviews").upsert(page, { onConflict: "id" });
    assertUploaded("Uploading review history", error, page.length);
    pushed += page.length;
    await settle(page.map((row) => `review:${row.id}`));
  }

  // Deletions, last, so a delete never races the upsert of the same id.
  for (const [kind, table, ids] of [
    ["card-deleted", "cards", deletedCardIds],
    ["question-deleted", "questions", deletedQuestionIds],
  ] as const) {
    if (ids.length === 0) continue;
    const entityType = table === "cards" ? "card" : "question";
    for (const page of chunk(ids, RECORD_PAGE)) {
      const tombstones = await client
        .from("deletions")
        // ON CONFLICT DO NOTHING rather than DO UPDATE. An existing tombstone already
        // says what we need it to say, and the update path would require an UPDATE
        // policy on a table members only ever need to insert into.
        .upsert(page.map((entityId) => ({ entity_type: entityType, entity_id: entityId })), {
          onConflict: "entity_type,entity_id",
          ignoreDuplicates: true,
        });
      assertUploaded(`Recording ${entityType} deletions`, tombstones.error, page.length);
      const removal = await client.from(table).delete().in("id", page);
      assertUploaded(`Deleting ${table}`, removal.error, page.length);
      pushed += page.length;
      await settle(page.map((entityId) => `${kind}:${entityId}`));
    }
  }

  // Queue entries whose local row vanished before it was ever pushed have nothing
  // left to send; drop them so they do not block the queue forever.
  const stale = pending
    .filter((entry) => {
      if (entry.kind === "question") return !questions.some((question) => question.id === entry.entityId);
      if (entry.kind === "card" || entry.kind === "progress") return !cardById.has(entry.entityId);
      if (entry.kind === "review") return !reviews.some((review) => review.id === entry.entityId);
      return false;
    })
    .map((entry) => entry.key);
  if (stale.length) await settle(stale);

  return pushed;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function pullPage<T>(
  table: string,
  columns: string,
  orderColumn: string,
  since: string,
  pageSize: number,
  scope?: { column: string; value: string },
): Promise<T[]> {
  const client = requireSupabase();
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    let query = client.from(table).select(columns).gt(orderColumn, since).order(orderColumn, { ascending: true });
    if (scope) query = query.eq(scope.column, scope.value);
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw new Error(`Downloading ${table} failed: ${describeSyncError(error)}`);
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function pullChanges(userId: string): Promise<{ pulled: number; deleted: number }> {
  const stored = readWatermark(userId);
  const since = new Date(Math.max(0, new Date(stored).getTime() - OVERLAP_MS)).toISOString();

  const [questionRows, cardRows, progressRows, reviewRows, deletionRows] = await Promise.all([
    pullPage<QuestionRow>("questions", "id,data,updated_at", "updated_at", since, CONTENT_PAGE),
    pullPage<CardRow>("cards", "id,question_id,data,updated_at", "updated_at", since, CONTENT_PAGE),
    pullPage<ProgressRow>(
      "card_progress",
      "card_id,mastery_rating,rating_updated_at,notes,feedback_flags,updated_at",
      "updated_at",
      since,
      RECORD_PAGE,
      { column: "user_id", value: userId },
    ),
    pullPage<ReviewRow>(
      "reviews",
      "id,card_id,rating,reviewed_at,created_at",
      "created_at",
      since,
      RECORD_PAGE,
      { column: "user_id", value: userId },
    ),
    pullPage<DeletionRow>("deletions", "entity_type,entity_id,deleted_at", "deleted_at", since, RECORD_PAGE),
  ]);

  const localCards = new Map((await listCards()).map((card) => [card.id, card]));
  const progressByCard = new Map(progressRows.map((row) => [row.card_id, row]));

  // A card whose content did not change but whose progress did still needs rebuilding.
  const contentById = new Map(cardRows.map((row) => [row.id, row.data]));
  const touchedCardIds = new Set([...contentById.keys(), ...progressByCard.keys()]);

  const mergedCards: StudyCard[] = [];
  for (const cardId of touchedCardIds) {
    const local = localCards.get(cardId);
    const content = contentById.get(cardId) ?? local;
    // Progress arriving for a card this device has never seen is kept until the
    // card itself syncs; there is nothing to write yet.
    if (!content) continue;
    mergedCards.push(joinCard(content, progressByCard.get(cardId), local));
  }

  const mergedQuestions = questionRows.map((row) => row.data);
  const mergedReviews: ReviewLog[] = reviewRows.map((row) => ({
    id: row.id,
    cardId: row.card_id,
    rating: row.rating,
    reviewedAt: row.reviewed_at,
  }));

  /**
   * Drop the echo of this device's own writes.
   *
   * The watermark deliberately reaches back a few seconds so a commit landing
   * mid-sync is never skipped, which means every sync re-reads the rows this
   * device just pushed. Counting those as "pulled" told the app that remote data
   * had changed after every single answer, and the resulting refresh wiped the
   * revealed answer out from under whoever was studying. Only rows that actually
   * differ from what is already stored count as a change.
   */
  const localQuestions = new Map((await listQuestions()).map((question) => [question.id, question]));
  const localReviewIds = new Set((await listReviews()).map((review) => review.id));

  const changedQuestions = mergedQuestions.filter((question) => {
    const local = localQuestions.get(question.id);
    return !local || stableStringify(local) !== stableStringify(question);
  });
  const changedCards = mergedCards.filter((card) => {
    const local = localCards.get(card.id);
    return !local || stableStringify(local) !== stableStringify(card);
  });
  const newReviews = mergedReviews.filter((review) => !localReviewIds.has(review.id));

  await applyRemoteLibrary(changedQuestions, changedCards, newReviews);

  // Likewise, a tombstone for something this device already removed is not news.
  const deletedCardIds = deletionRows
    .filter((row) => row.entity_type === "card" && localCards.has(row.entity_id))
    .map((row) => row.entity_id);
  const deletedQuestionIds = deletionRows
    .filter((row) => row.entity_type === "question" && localQuestions.has(row.entity_id))
    .map((row) => row.entity_id);
  await applyRemoteDeletions(deletedCardIds, deletedQuestionIds);

  let watermark = stored;
  for (const row of questionRows) watermark = latest(watermark, row.updated_at);
  for (const row of cardRows) watermark = latest(watermark, row.updated_at);
  for (const row of progressRows) watermark = latest(watermark, row.updated_at);
  for (const row of reviewRows) watermark = latest(watermark, row.created_at);
  for (const row of deletionRows) watermark = latest(watermark, row.deleted_at);
  if (watermark !== stored) writeWatermark(userId, watermark);

  return {
    pulled: changedQuestions.length + changedCards.length + newReviews.length,
    deleted: deletedCardIds.length + deletedQuestionIds.length,
  };
}

// ---------------------------------------------------------------------------

let running: Promise<SyncResult> | null = null;

/** Runs one push-then-pull cycle. Concurrent callers share the in-flight run. */
export function syncNow(userId: string): Promise<SyncResult> {
  if (running) return running;

  const run = (async () => {
    const pending = await listPending();
    // Only entries that made it upstream leave the queue, so a failed push retries.
    const pushed = pending.length ? await pushChanges(userId, pending, clearPending) : 0;
    const { pulled, deleted } = await pullChanges(userId);
    const stateAdopted = await syncStudyState(userId);
    return { pushed, pulled, deleted, stateAdopted };
  })();

  running = run;
  void run.catch(() => undefined).then(() => {
    if (running === run) running = null;
  });
  return run;
}

export async function pendingCount(): Promise<number> {
  return (await listPending()).length;
}

// ---------------------------------------------------------------------------
// Study state: the in-progress set and settings, carried between one person's
// own devices. Never shared with the other member; this is private study state.
// ---------------------------------------------------------------------------

/**
 * Most recently touched wins. A device that has changed anything since its last
 * sync pushes and becomes the truth. A device that has not changed anything, an
 * idle laptop tab for instance, never pushes, so it cannot clobber a set you
 * just worked through on your phone; it only adopts.
 *
 * Returns true when local state was replaced, so the caller can re-render.
 */
async function syncStudyState(userId: string): Promise<boolean> {
  const client = requireSupabase();

  if (studyStateChanged()) {
    const local = readLocalStudyState();
    const { data, error } = await client
      .from("study_state")
      .upsert(
        {
          user_id: userId,
          session: local.session ?? null,
          settings: local.settings ?? null,
          exam_filter: local.examFilter ?? null,
        },
        { onConflict: "user_id" },
      )
      .select("updated_at")
      .single();
    assertUploaded("Uploading study session", error, 1);
    markStudyStateSynced(local, data?.updated_at ?? new Date().toISOString());
    return false;
  }

  const { data, error } = await client
    .from("study_state")
    .select("session,settings,exam_filter,updated_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Reading study session failed: ${describeSyncError(error)}`);
  if (!data || data.updated_at <= lastServerStudyStateAt()) return false;

  const incoming = {
    session: data.session ?? null,
    settings: data.settings ?? null,
    examFilter: data.exam_filter ?? null,
  };
  // Mark before writing: the app's own persistence effect will rewrite these keys
  // as it re-renders, and without the marker in place that would look like a local
  // change and bounce straight back to the server.
  markStudyStateSynced(incoming, data.updated_at);
  writeLocalStudyState(incoming);
  return true;
}
