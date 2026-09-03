import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { signOut, type AuthState } from "./auth";
import { shouldShowAnswerText, splitCapturedList, splitCardFront } from "./card-content";
import { DiscussionPanel } from "./DiscussionPanel";
import { ALL_EXAMS, filterCardsByExam, listExamCodes } from "./exam-filter";
import { EXAM_FILTER_KEY, SESSION_KEY, SETTINGS_KEY } from "./study-state";
import type { SyncResult } from "./sync";
import { useCloudSync, type CloudSync } from "./useCloudSync";
import {
  ensureMasteryProgress,
  exportLibrary,
  listCards,
  listQuestions,
  removeCards,
  resetMasteryRatings,
  restoreLibrary,
  saveImport,
  saveReview,
} from "./db";
import { prepareImportSelection } from "./importer";
import {
  addCardsToMasterySession,
  advanceStudySession,
  reviseStudyResult,
  cleanMasteryCardIds,
  createStudySession,
  evaluateAnswer,
  filterEasyReviewPool,
  filterMasteryPool,
  normalizeAnswerLabel,
  selectMasteryAdditions,
  setSessionAnswer,
  summarizeStudySession,
  updateMasteryCardIds,
  type StudyMode,
  type StudySession,
  type StudySettings,
} from "./study-session";
import { MasteryRating, type CapturedQuestion, type MasteryRating as MasteryRatingValue, type ReviewLog, type StudyCard } from "./types";

type View = "study" | "library" | "import";
type CapturedTextElement = "div" | "h2" | "h3" | "p" | "strong";

// Imported rather than restated: sync reads and writes these same two keys, and a
// silent drift between the two spellings would break carry-over without any error.
const DEFAULT_STUDY_SETTINGS: StudySettings = {
  masterySetSize: 20,
  masteryPool: "all-not-easy",
  easyReviewSize: 20,
  masteryCardIds: [],
};
const RATING_OPTIONS = [
  { value: MasteryRating.Again, label: "Again", tone: "again" },
  { value: MasteryRating.Hard, label: "Hard", tone: "hard" },
  { value: MasteryRating.Good, label: "Good", tone: "good" },
  { value: MasteryRating.Easy, label: "Easy", tone: "easy" },
] as const;

function normalizeQuestionCount(value: unknown, fallback: number): number {
  const count = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : fallback;
}

function normalizeCardIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : [];
}

function readStudySettings(session: StudySession | null = null): StudySettings {
  try {
    const current = localStorage.getItem(SETTINGS_KEY);
    const stored = JSON.parse(current ?? localStorage.getItem("crambot-study-settings") ?? "{}") as Partial<StudySettings> & { questionCount?: number };
    const migratedCount = normalizeQuestionCount(stored.questionCount, DEFAULT_STUDY_SETTINGS.masterySetSize);
    const masteryCardIds = normalizeCardIds(stored.masteryCardIds);
    const legacySessionIds = session?.mode === "mastery" ? normalizeCardIds(session.queue) : [];
    return {
      masterySetSize: normalizeQuestionCount(stored.masterySetSize, migratedCount),
      masteryPool: stored.masteryPool === "again-hard" ? "again-hard" : "all-not-easy",
      easyReviewSize: normalizeQuestionCount(stored.easyReviewSize, migratedCount),
      masteryCardIds: [...new Set([...masteryCardIds, ...legacySessionIds])],
    };
  } catch {
    return {
      ...DEFAULT_STUDY_SETTINGS,
      masteryCardIds: session?.mode === "mastery" ? normalizeCardIds(session.queue) : [],
    };
  }
}

function readExamFilter(): string {
  try {
    return localStorage.getItem(EXAM_FILTER_KEY) || ALL_EXAMS;
  } catch {
    return ALL_EXAMS;
  }
}

function readStudySession(): StudySession | null {
  try {
    const stored = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as StudySession | null;
    if (!stored || (stored.mode !== "mastery" && stored.mode !== "easy-review") || !Array.isArray(stored.order) || !Array.isArray(stored.queue)) return null;
    return stored;
  } catch {
    return null;
  }
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function ratingLabel(rating: MasteryRatingValue | null): string {
  return RATING_OPTIONS.find((option) => option.value === rating)?.label ?? "Unrated";
}

function downloadJson(data: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function SyncBadge({ cloud }: { cloud: CloudSync }) {
  if (cloud.phase === "disabled") return null;
  const label = cloud.phase === "syncing"
    ? "Syncing…"
    : cloud.phase === "offline"
      ? `${cloud.pending} pending · offline`
      : cloud.phase === "error"
        ? `${cloud.pending} pending · sync error`
        : cloud.pending
          ? `${cloud.pending} pending`
          : "Synced";
  return <button className={`sync-badge ${cloud.phase}`} onClick={() => cloud.request()} title={cloud.error ?? undefined}>{label}</button>;
}

function CapturedText({ text, as: Element, className }: { text: string; as: CapturedTextElement; className?: string }) {
  const parts = splitCapturedList(text);
  if (parts.items.length === 0) return <Element className={className}>{text}</Element>;
  return (
    <Element className={className}>
      {parts.lead && <span>{parts.lead}</span>}
      <ul className="captured-list">{parts.items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
      {parts.tail && <span className="captured-list-tail">{parts.tail}</span>}
    </Element>
  );
}

/**
 * A whole-number field you can actually edit.
 *
 * Committing straight from onChange means an empty box is rejected, so selecting all
 * and deleting snaps the old value back and the only way to change 20 to 5 is to
 * edit around the digits. This keeps whatever is typed in a local draft, commits as
 * soon as it parses, and on blur falls back to the last good value if the box was
 * left empty or invalid.
 */
function CountField({ label, value, onCommit }: { label: string; value: number; onCommit: (next: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label>
      {label}
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={draft ?? String(value)}
        onChange={(event) => {
          setDraft(event.target.value);
          const next = Number(event.target.value);
          if (event.target.value.trim() !== "" && Number.isFinite(next) && next >= 1) onCommit(Math.floor(next));
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

export default function App({ auth }: { auth?: AuthState } = {}) {
  const restoredSession = useMemo(readStudySession, []);
  const [cards, setCards] = useState<StudyCard[]>([]);
  const [questions, setQuestions] = useState<CapturedQuestion[]>([]);
  const [view, setView] = useState<View>("study");
  const [studyMode, setStudyMode] = useState<StudyMode>(restoredSession?.mode ?? "mastery");
  const [studySettings, setStudySettings] = useState<StudySettings>(() => readStudySettings(restoredSession));
  const [studySession, setStudySession] = useState<StudySession | null>(restoredSession);
  const [revealed, setRevealed] = useState(false);
  const [query, setQuery] = useState("");
  const [examFilter, setExamFilter] = useState(readExamFilter);
  const [extensionInfo, setExtensionInfo] = useState<{ version: string; bytes: number } | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState("Loading your library…");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ensureMasteryProgress()
      .then(() => Promise.all([listCards(), listQuestions()]))
      .then(([storedCards, storedQuestions]) => {
        setCards(storedCards);
        setQuestions(storedQuestions);
        setStudySettings((existing) => ({ ...existing, masteryCardIds: cleanMasteryCardIds(storedCards, existing.masteryCardIds) }));
        setNotice(storedCards.length ? restoredSession ? "Resumed your saved study session." : "" : "Import your first capture to begin.");
        if (restoredSession) {
          const availableIds = new Set(storedCards.map((card) => card.id));
          setStudySession((existing) => existing ? {
            ...existing,
            queue: existing.queue.filter((id) => availableIds.has(id)),
            order: existing.order.filter((id) => availableIds.has(id)),
          } : null);
        }
      })
      .catch((error) => setNotice(`Could not open local storage: ${error instanceof Error ? error.message : String(error)}`));
  }, []);

  const handleRemoteChange = useCallback((result: SyncResult) => {
    // Library refreshes are silent on purpose. They happen on a timer while you are
    // mid-question, so they must never disturb the card you are looking at.
    if (result.refusedDeletions > 0) {
      const count = result.refusedDeletions;
      setNotice(`${count} question${count === 1 ? "" : "s"} could not be deleted because ${count === 1 ? "it was" : "they were"} contributed by someone else, so ${count === 1 ? "it has" : "they have"} been restored. Only the contributor or a library owner can remove ${count === 1 ? "it" : "them"}.`);
    }
    if (result.pulled > 0 || result.deleted > 0 || result.refusedDeletions > 0) {
      void Promise.all([listCards(), listQuestions()]).then(([storedCards, storedQuestions]) => {
        setCards(storedCards);
        setQuestions(storedQuestions);
        setStudySettings((existing) => ({ ...existing, masteryCardIds: cleanMasteryCardIds(storedCards, existing.masteryCardIds) }));
      });
    }
    // Only a set genuinely handed over from another device replaces what is on screen.
    if (result.stateAdopted) {
      setExamFilter(readExamFilter());
      const adopted = readStudySession();
      setStudySettings(readStudySettings(adopted));
      setStudySession(adopted);
      if (adopted) setStudyMode(adopted.mode);
      // The revealed answer belonged to the card this tab was on, not the incoming one.
      setRevealed(false);
    }
  }, []);
  const cloud = useCloudSync(auth?.userId ?? null, handleRemoteChange);

  useEffect(() => localStorage.setItem(SETTINGS_KEY, JSON.stringify(studySettings)), [studySettings]);
  useEffect(() => {
    if (studySession) localStorage.setItem(SESSION_KEY, JSON.stringify(studySession));
    else localStorage.removeItem(SESSION_KEY);
  }, [studySession]);

  // Carry the set to your other devices. Debounced inside the hook, so working
  // through a run of questions produces one upload rather than one per answer.
  useEffect(() => cloud.request(), [studySession, studySettings, examFilter, cloud.request]);

  const questionById = useMemo(() => new Map(questions.map((question) => [question.id, question])), [questions]);
  const examCodes = useMemo(() => listExamCodes(cards, questionById), [cards, questionById]);
  const examCards = useMemo(() => filterCardsByExam(cards, examFilter, questionById), [cards, examFilter, questionById]);
  const allNotEasy = useMemo(() => filterMasteryPool(examCards, "all-not-easy"), [examCards]);
  const masteryPoolIds = useMemo(() => new Set(studySettings.masteryCardIds), [studySettings.masteryCardIds]);
  const currentMasteryPool = useMemo(
    () => examCards.filter((card) => masteryPoolIds.has(card.id) && card.masteryRating !== MasteryRating.Easy),
    [examCards, masteryPoolIds],
  );
  const masteryAdditionsAvailable = useMemo(
    () => filterMasteryPool(examCards, studySettings.masteryPool).filter((card) => !masteryPoolIds.has(card.id)),
    [examCards, masteryPoolIds, studySettings.masteryPool],
  );
  const easyPool = useMemo(() => filterEasyReviewPool(examCards), [examCards]);
  useEffect(() => {
    // Guard on examCodes being populated. On a device whose library has not synced
    // yet, examCodes is briefly empty, and without this the restored or adopted
    // filter would be reset to All exams and that reset would be pushed upstream.
    if (examCodes.length > 0 && examFilter !== ALL_EXAMS && !examCodes.includes(examFilter)) setExamFilter(ALL_EXAMS);
  }, [examCodes, examFilter]);

  useEffect(() => {
    try {
      localStorage.setItem(EXAM_FILTER_KEY, examFilter);
    } catch {
      // Losing the preference is not worth interrupting a study session for.
    }
  }, [examFilter]);

  // The extension zip and this manifest are emitted by the extension build, not
  // precached by the service worker. A local dev build without them just omits the
  // version line rather than breaking the panel.
  useEffect(() => {
    if (view !== "import" || extensionInfo) return;
    let active = true;
    void fetch(`${import.meta.env.BASE_URL}extension.json`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (active && data && typeof data.version === "string") setExtensionInfo(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [view, extensionInfo]);
  /**
   * How many answers back from the live question we are looking. 0 is the live
   * question; 1 is the answer just given, and so on through the results log.
   * Results are append-only, so an index into them is stable while browsing.
   */
  /**
   * Mirrors the database policy so the interface does not offer deletes that will be
   * refused. Postgres remains the authority; this only keeps the buttons honest.
   * A card with no recorded contributor is local-only or predates ownership tracking,
   * and the server will decide on it either way.
   */
  const canDeleteCard = useCallback(
    (card: StudyCard) => cloud.phase === "disabled" || auth?.isOwner || !card.createdBy || card.createdBy === auth?.userId,
    [cloud.phase, auth?.isOwner, auth?.userId],
  );

  const [historyStep, setHistoryStep] = useState(0);
  const historyIndex = studySession && historyStep > 0 ? studySession.results.length - historyStep : -1;
  const historyResult = historyIndex >= 0 ? studySession?.results[historyIndex] : undefined;
  const viewingHistory = Boolean(historyResult);

  const currentCardId = historyResult?.cardId ?? studySession?.queue[0];
  const currentCard = currentCardId ? cards.find((card) => card.id === currentCardId) : undefined;
  const currentQuestion = currentCard ? questionById.get(currentCard.questionId) : undefined;
  const correctAnswers = currentQuestion
    ? currentQuestion.correctAnswers.length ? currentQuestion.correctAnswers : currentQuestion.mostVotedAnswers
    : [];
  // A past question shows the answers you gave then, not whatever is in the live
  // answer map, which may since have been cleared for a repeat of the same card.
  const activeChoices = new Set(
    historyResult ? historyResult.selectedAnswers : currentCard && studySession ? studySession.answers[currentCard.id] ?? [] : [],
  );
  const reviewContent = currentCard ? splitCardFront(currentCard.front) : null;
  // History is always shown answered; there is nothing to reveal about it.
  const showAnswer = revealed || viewingHistory;
  const answerWasCorrect = showAnswer ? evaluateAnswer([...activeChoices], correctAnswers) : null;
  const sessionFinished = Boolean(studySession && studySession.queue.length === 0 && !viewingHistory);
  const sessionSummary = studySession ? summarizeStudySession(studySession) : null;

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return examCards
      .filter((card) => !needle || `${card.front} ${card.back} ${card.notes ?? ""} ${card.tags.join(" ")}`.toLowerCase().includes(needle))
      .sort((left, right) => left.front.localeCompare(right.front));
  }, [examCards, query]);
  const selectedCards = useMemo(() => examCards.filter((card) => selectedCardIds.has(card.id)), [examCards, selectedCardIds]);
  const allFilteredSelected = filteredCards.length > 0 && filteredCards.every((card) => selectedCardIds.has(card.id));

  async function handleImport(files: File[]) {
    setBusy(true);
    try {
      const inputs = await Promise.all(files.map((file) => file.text().then((text) => JSON.parse(text) as unknown)));
      const selection = prepareImportSelection(inputs, cards);
      if (selection.kind === "library") {
        await restoreLibrary(selection.library.questions, selection.library.cards, selection.library.reviews);
        if (selection.library.studySettings) {
          const restored = selection.library.studySettings as Partial<StudySettings> & { questionCount?: number };
          const count = normalizeQuestionCount(restored.questionCount, studySettings.masterySetSize);
          setStudySettings({
            masterySetSize: normalizeQuestionCount(restored.masterySetSize, count),
            masteryPool: restored.masteryPool === "again-hard" ? "again-hard" : "all-not-easy",
            easyReviewSize: normalizeQuestionCount(restored.easyReviewSize, count),
            masteryCardIds: normalizeCardIds(restored.masteryCardIds),
          });
        }
        setNotice(`Restored ${selection.library.cards.length} questions and ${selection.library.reviews.length} rating records.`);
      } else {
        await saveImport(selection.prepared.questions, selection.prepared.cards);
        setNotice(`Imported ${selection.prepared.added} new and updated ${selection.prepared.updated} existing questions.`);
      }
      const [refreshedCards, refreshedQuestions] = await Promise.all([listCards(), listQuestions()]);
      setCards(refreshedCards);
      setQuestions(refreshedQuestions);
      setStudySettings((existing) => ({ ...existing, masteryCardIds: cleanMasteryCardIds(refreshedCards, existing.masteryCardIds) }));
      setSelectedCardIds(new Set());
      setStudySession(null);
      setStudyMode("mastery");
      setView("study");
      cloud.request();
    } catch (error) {
      setNotice(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleExport() {
    setBusy(true);
    try {
      const library = await exportLibrary();
      downloadJson({ ...library, studySettings }, `crambot-library-${new Date().toISOString().slice(0, 10)}.json`);
      setNotice("Library backup downloaded.");
    } catch (error) {
      setNotice(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function changeExamFilter(nextExam: string) {
    setExamFilter(nextExam);
    setStudySession(null);
    setRevealed(false);
    setSelectedCardIds(new Set());
  }

  function startStudySession(mode = studyMode) {
    const nextSession = createStudySession(examCards, studySettings, mode);
    setStudyMode(mode);
    setStudySession(nextSession);
    setRevealed(false);
    setNotice(nextSession.total ? "" : mode === "mastery" ? "Your Mastery pool is empty. Add questions to begin." : "No Easy questions are available to review.");
  }

  function addToMasteryPool(startAfterAdding = false) {
    const additions = selectMasteryAdditions(examCards, studySettings);
    if (additions.length === 0) {
      setNotice("No additional questions match the selected Mastery filter.");
      return;
    }
    const nextSettings = {
      ...studySettings,
      masteryCardIds: [...new Set([...studySettings.masteryCardIds, ...additions])],
    };
    setStudySettings(nextSettings);
    setStudySession((existing) => {
      if (existing?.mode === "mastery") return addCardsToMasterySession(existing, additions);
      return startAfterAdding ? createStudySession(examCards, nextSettings, "mastery") : existing;
    });
    if (startAfterAdding) setStudyMode("mastery");
    setRevealed(false);
    setNotice(`${additions.length} question${additions.length === 1 ? "" : "s"} added to the Mastery pool.`);
  }

  async function handleRating(rating: MasteryRatingValue) {
    if (!currentCard || !studySession) return;
    const now = new Date();
    /**
     * A card's stored label reflects the most recent thing you said about it. When
     * correcting an older answer for a card that was answered again later, the
     * session result changes but the label must keep the later verdict.
     */
    const supersededByLaterAnswer = historyIndex >= 0
      && studySession.results.some((result, index) => index > historyIndex && result.cardId === currentCard.id);
    if (supersededByLaterAnswer) {
      setStudySession((existing) => existing ? reviseStudyResult(existing, historyIndex, rating) : null);
      cloud.request();
      return;
    }
    const updated: StudyCard = {
      ...currentCard,
      masteryRating: rating,
      ratingUpdatedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const review: ReviewLog = {
      id: `${currentCard.id}_${now.getTime()}_${rating}`,
      cardId: currentCard.id,
      rating,
      reviewedAt: now.toISOString(),
    };
    try {
      await saveReview(updated, review);
      setCards((existing) => existing.map((card) => card.id === updated.id ? updated : card));
      setStudySettings((existing) => ({
        ...existing,
        masteryCardIds: updateMasteryCardIds(existing.masteryCardIds, currentCard.id, studySession.mode, rating),
      }));
      if (historyIndex >= 0) {
        setStudySession((existing) => existing ? reviseStudyResult(existing, historyIndex, rating) : null);
        // Stay on the corrected question rather than jumping away mid-correction.
      } else {
        setStudySession((existing) => existing
          ? advanceStudySession(existing, currentCard.id, rating, [...activeChoices], correctAnswers, now)
          : null);
        setRevealed(false);
      }
      cloud.request();
    } catch (error) {
      setNotice(`Could not save this rating: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function toggleChoice(choice: string) {
    if (revealed || !currentCard || !studySession) return;
    const selected = new Set(studySession.answers[currentCard.id] ?? []);
    if (selected.has(choice)) selected.delete(choice);
    else selected.add(choice);
    setStudySession((existing) => existing ? setSessionAnswer(existing, currentCard.id, [...selected]) : null);
  }

  async function handleReset() {
    if (!examCards.length) return;
    const scope = examFilter === ALL_EXAMS ? "all exams" : examFilter;
    const questionDescription = scope === "all exams"
      ? `${examCards.length} questions across all exams`
      : `${examCards.length} ${scope} questions`;
    if (!window.confirm(`Reset the labels on ${questionDescription}?\n\nThe selected questions will become Unrated and return to Mastery. Questions, notes, and rating history will not be deleted.`)) return;
    setBusy(true);
    try {
      const updated = await resetMasteryRatings(examCards.map((card) => card.id));
      setCards(updated);
      setStudySession(null);
      setRevealed(false);
      setStudyMode("mastery");
      const resetIds = new Set(examCards.map((card) => card.id));
      setStudySettings((existing) => ({
        ...existing,
        masteryPool: "all-not-easy",
        masteryCardIds: existing.masteryCardIds.filter((cardId) => !resetIds.has(cardId)),
      }));
      setNotice(`Reset ${scope === "all exams" ? `${examCards.length} question labels across all exams` : `${examCards.length} ${scope} question labels`}. Start a new Mastery set when ready.`);
      cloud.request();
    } catch (error) {
      setNotice(`Could not reset labels: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleSelection(cardId: string) {
    setSelectedCardIds((existing) => {
      const next = new Set(existing);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }

  function toggleFilteredSelection() {
    setSelectedCardIds((existing) => {
      const next = new Set(existing);
      for (const card of filteredCards) {
        if (allFilteredSelected) next.delete(card.id);
        else next.add(card.id);
      }
      return next;
    });
  }

  async function handleRemove(rawCardsToRemove: StudyCard[], scope: "single" | "selected" | "all") {
    // Silently dropping questions you cannot delete would make bulk actions lie about
    // what they did, so the ineligible ones are named rather than skipped quietly.
    const cardsToRemove = rawCardsToRemove.filter(canDeleteCard);
    const blocked = rawCardsToRemove.length - cardsToRemove.length;
    if (blocked > 0 && cardsToRemove.length === 0) {
      setNotice(`${blocked === 1 ? "That question was" : `Those ${blocked} questions were`} contributed by someone else, so only they or a library owner can delete ${blocked === 1 ? "it" : "them"}.`);
      return;
    }
    if (!cardsToRemove.length) return;
    const confirmation = scope === "all"
      ? examFilter === ALL_EXAMS
        ? `Delete all ${cardsToRemove.length} questions and their rating history?`
        : `Delete all ${cardsToRemove.length} ${examFilter} questions and their rating history?\n\nQuestions from your other exams are not affected.`
      : scope === "selected"
        ? `Delete ${cardsToRemove.length} selected questions and their rating history?`
        : `Delete this question and its rating history?\n\n${splitCardFront(cardsToRemove[0].front).prompt.slice(0, 140)}`;
    const reach = cloud.phase === "disabled" ? "This cannot be undone." : "This removes the questions from the shared library for everyone.";
    const skipped = blocked > 0 ? `\n\n${blocked} question${blocked === 1 ? "" : "s"} contributed by someone else will be kept.` : "";
    if (!window.confirm(`${confirmation}\n\n${reach}${skipped}`)) return;
    setBusy(true);
    try {
      await removeCards(cardsToRemove);
      const removedIds = new Set(cardsToRemove.map((card) => card.id));
      setCards((existing) => existing.filter((card) => !removedIds.has(card.id)));
      setSelectedCardIds((existing) => new Set([...existing].filter((id) => !removedIds.has(id))));
      setStudySettings((existing) => ({
        ...existing,
        masteryCardIds: existing.masteryCardIds.filter((cardId) => !removedIds.has(cardId)),
      }));
      setStudySession((existing) => {
        if (!existing) return null;
        const order = existing.order.filter((id) => !removedIds.has(id));
        return {
          ...existing,
          queue: existing.queue.filter((id) => !removedIds.has(id)),
          order,
          total: order.length,
          results: existing.results.filter((result) => !removedIds.has(result.cardId)),
        };
      });
      setRevealed(false);
      setNotice(`${cardsToRemove.length} question${cardsToRemove.length === 1 ? "" : "s"} deleted.`);
      cloud.request();
    } catch (error) {
      setNotice(`Could not delete ${cardsToRemove.length === 1 ? "question" : "questions"}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function handleKeyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || target?.closest("button, input, select, textarea, summary")) return;
      if (currentCard && (event.code === "ArrowLeft" || event.code === "ArrowRight")) {
        event.preventDefault();
        const total = studySession?.results.length ?? 0;
        setHistoryStep((step) => (event.code === "ArrowLeft" ? Math.min(total, step + 1) : Math.max(0, step - 1)));
        return;
      }
      if (!showAnswer && currentCard && event.code === "Space") {
        event.preventDefault();
        setRevealed(true);
        return;
      }
      const option = RATING_OPTIONS[Number(event.key) - 1];
      if (showAnswer && option) void handleRating(option.value);
    }
    document.addEventListener("keydown", handleKeyboard);
    return () => document.removeEventListener("keydown", handleKeyboard);
  }, [currentCard, showAnswer, studySession, historyStep]);

  // A new or ended session invalidates any history position we were holding.
  useEffect(() => setHistoryStep(0), [studySession?.id]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">C</span><span>CramBot</span></div>
        <nav aria-label="Primary navigation">
          <button className={view === "study" ? "active" : ""} onClick={() => setView("study")}><span>◉</span> Study <b>{allNotEasy.length}</b></button>
          <button className={view === "library" ? "active" : ""} onClick={() => setView("library")}><span>▤</span> Library <b>{cards.length}</b></button>
          <button className={view === "import" ? "active" : ""} onClick={() => setView("import")}><span>↥</span> Import</button>
        </nav>
        <div className="sidebar-foot">
          {cloud.phase === "disabled"
            ? <><p>LOCAL-FIRST</p><span>Your study data stays in this browser until you export it.</span></>
            : <><p>SHARED LIBRARY</p><span>Questions are shared. Mastery labels stay private to {auth?.email ?? "your account"}.</span></>}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="kicker">MASTERY STUDY</p><h1>{view === "study" ? "Study" : view === "library" ? "Question library" : "Import captures"}</h1></div>
          <div className="topbar-actions">
            {view !== "import" && examCodes.length > 0 && <label className="exam-filter">Exam<select value={examFilter} onChange={(event) => changeExamFilter(event.target.value)}>
              <option value={ALL_EXAMS}>All exams</option>
              {examCodes.map((exam) => <option key={exam} value={exam}>{exam}</option>)}
            </select></label>}
            <SyncBadge cloud={cloud} />
            <button className="secondary" disabled={busy || cards.length === 0} onClick={handleExport}>Export backup</button>
            {auth?.status === "ready" && <button className="secondary" onClick={() => void signOut()}>Sign out</button>}
          </div>
        </header>

        {notice && <div className="notice" role="status">{notice}</div>}
        {cloud.phase === "error" && cloud.error && (
          <div className="notice sync-failure" role="alert">
            <strong>Sync is stalled with {cloud.pending} change{cloud.pending === 1 ? "" : "s"} queued.</strong>
            <span>{cloud.error}</span>
            <span>Nothing is lost. The queue stays on this device and drains once the request above succeeds.</span>
          </div>
        )}

        {view === "study" && (
          <section className="review-layout mastery-layout">
            <section className="mastery-overview" aria-label="Mastery progress">
              <div><strong>{allNotEasy.length}</strong><span>to master</span></div>
              <div><strong>{easyPool.length}</strong><span>Easy</span></div>
              <div><strong>{examCards.length ? Math.round((easyPool.length / examCards.length) * 100) : 0}%</strong><span>mastered</span></div>
              <button className="danger-button" disabled={busy || examCards.length === 0} onClick={() => void handleReset()}>{examFilter === ALL_EXAMS ? "Reset all labels" : `Reset ${examFilter} labels`}</button>
            </section>

            <div className="study-controls">
              <div className="mode-tabs two-mode" role="group" aria-label="Study mode">
                <button className={studyMode === "mastery" ? "active" : ""} aria-pressed={studyMode === "mastery"} onClick={() => { setStudyMode("mastery"); setStudySession(null); setRevealed(false); }}>Mastery</button>
                <button className={studyMode === "easy-review" ? "active" : ""} aria-pressed={studyMode === "easy-review"} onClick={() => { setStudyMode("easy-review"); setStudySession(null); setRevealed(false); }}>Review Easy</button>
              </div>
              <p className="mode-description">{studyMode === "mastery"
                ? "Build a persistent pool and work each question until it reaches Easy."
                : "Review mastered questions once; relabel anything that needs more work."}</p>
              <div className="session-settings simplified-settings">
                {studyMode === "mastery" ? <>
                  <CountField
                    label="Questions to add"
                    value={studySettings.masterySetSize}
                    onCommit={(masterySetSize) => setStudySettings((existing) => ({ ...existing, masterySetSize }))}
                  />
                  <label>Include<select value={studySettings.masteryPool} onChange={(event) => setStudySettings((existing) => ({ ...existing, masteryPool: event.target.value as StudySettings["masteryPool"] }))}>
                    <option value="all-not-easy">All not Easy</option>
                    <option value="again-hard">Again + Hard only</option>
                  </select></label>
                  <span className="pool-count">{currentMasteryPool.length} in pool · {masteryAdditionsAvailable.length} available to add</span>
                </> : <>
                  <CountField
                    label="Questions to review"
                    value={studySettings.easyReviewSize}
                    onCommit={(easyReviewSize) => setStudySettings((existing) => ({ ...existing, easyReviewSize }))}
                  />
                  <span className="pool-count">{easyPool.length} Easy</span>
                </>}
                {studyMode === "mastery" ? <>
                  {!studySession && <button className="primary compact" disabled={currentMasteryPool.length === 0} onClick={() => startStudySession("mastery")}>Study current pool</button>}
                  <button className={studySession ? "primary compact" : "secondary compact"} disabled={masteryAdditionsAvailable.length === 0} onClick={() => addToMasteryPool()}>{studySession ? "Add questions" : "Add questions to pool"}</button>
                </> : <button className="primary compact" disabled={easyPool.length === 0} onClick={() => startStudySession("easy-review")}>{studySession ? "Restart review" : "Start Easy review"}</button>}
                {studySession && <button className="secondary compact" onClick={() => setStudySession(null)}>End session</button>}
              </div>
            </div>

            <div className="progress-card">
              {studySession ? <>
                <div><span className="metric">{studySession.queue.length}</span><small>remaining</small></div>
                <div><span className="metric">{studySession.completed}</span><small>{studyMode === "mastery" ? "mastered" : "reviewed"}</small></div>
                <div><span className="metric">{studySession.attempts}</span><small>attempts</small></div>
              </> : <>
                <div><span className="metric">{studyMode === "mastery" ? currentMasteryPool.length : easyPool.length}</span><small>{studyMode === "mastery" ? "in pool" : "available"}</small></div>
                <div><span className="metric">{studyMode === "mastery" ? masteryAdditionsAvailable.length : studySettings.easyReviewSize}</span><small>{studyMode === "mastery" ? "available to add" : "set target"}</small></div>
              </>}
            </div>

            {sessionFinished && studySession && sessionSummary ? (
              <section className="results-card">
                <p className="kicker">SESSION COMPLETE</p>
                <h2>{studySession.mode === "mastery" ? "Mastery set complete" : "Easy review complete"}</h2>
                <div className="result-metrics">
                  <div><strong>{sessionSummary.completed}</strong><span>{studySession.mode === "mastery" ? "mastered" : "reviewed"}</span></div>
                  <div><strong>{formatDuration(sessionSummary.durationSeconds)}</strong><span>duration</span></div>
                  <div><strong>{sessionSummary.averageSeconds}s</strong><span>per question</span></div>
                  <div><strong>{sessionSummary.accuracy === null ? "—" : `${sessionSummary.accuracy}%`}</strong><span>answer accuracy</span></div>
                </div>
                <div className="result-actions">
                  <button className="primary" disabled={currentMasteryPool.length === 0 && masteryAdditionsAvailable.length === 0} onClick={() => currentMasteryPool.length ? startStudySession("mastery") : addToMasteryPool(true)}>{currentMasteryPool.length ? "Study Mastery pool" : "Build Mastery pool"}</button>
                  <button className="secondary" disabled={easyPool.length === 0} onClick={() => startStudySession("easy-review")}>Review Easy questions</button>
                  <button className="secondary" onClick={() => setStudySession(null)}>Done</button>
                </div>
              </section>
            ) : currentCard && reviewContent ? (
              <article className="study-card">
                <div className="card-meta">
                  {/* Counts mastery, not position. Unmastered cards are pushed back onto
                      the queue, so there is no stable position to count through. */}
                  <span>{studySession && `${studySession.completed} of ${studySession.total} ${studySession.mode === "mastery" ? "mastered" : "reviewed"} · `}{currentCard.tags.join(" · ") || "Uncategorized"}</span>
                  <span className={`mastery-label label-${ratingLabel(currentCard.masteryRating).toLowerCase()}`}>{ratingLabel(currentCard.masteryRating)}</span>
                </div>
                {studySession && (studySession.results.length > 0 || viewingHistory) && (
                  <div className="history-nav">
                    <button
                      type="button"
                      className="secondary compact"
                      disabled={historyStep >= studySession.results.length}
                      onClick={() => setHistoryStep((step) => step + 1)}
                    >
                      ← Previous
                    </button>
                    <span className="history-position">
                      {viewingHistory
                        ? `Answered question ${studySession.results.length - historyStep + 1} of ${studySession.results.length}`
                        : "Current question"}
                    </span>
                    <button
                      type="button"
                      className="secondary compact"
                      disabled={historyStep === 0}
                      onClick={() => setHistoryStep((step) => Math.max(0, step - 1))}
                    >
                      Next →
                    </button>
                  </div>
                )}
                {viewingHistory && historyResult && (
                  <p className="history-note">
                    Reviewing an earlier answer, rated <strong>{ratingLabel(historyResult.rating)}</strong>. Choosing a
                    rating below replaces it.
                  </p>
                )}
                <CapturedText text={reviewContent.prompt} as="h2" />
                {reviewContent.context && <details className="case-study-reference"><summary>Case study reference</summary><CapturedText text={reviewContent.context} as="div" /></details>}
                {currentCard.questionImages.length > 0 && <div className="question-images">{currentCard.questionImages.map((image) => <img key={image.src} src={image.dataUrl || image.src} alt={image.alt || "Question diagram"} />)}</div>}
                <div className="choices" aria-label="Answer choices">
                  {splitCardFront(currentCard.front).choices.map((choice) => {
                    const selected = activeChoices.has(choice);
                    const expected = correctAnswers.map(normalizeAnswerLabel).includes(normalizeAnswerLabel(choice));
                    const feedbackClass = showAnswer ? expected ? "correct-choice" : selected ? "incorrect-choice" : "" : "";
                    return <button type="button" key={choice} className={`${selected ? "selected" : ""} ${feedbackClass}`.trim()} aria-pressed={selected} disabled={showAnswer} onClick={() => toggleChoice(choice)}>{choice}</button>;
                  })}
                </div>
                {!showAnswer ? (
                  <button className="primary reveal" onClick={() => setRevealed(true)}>{activeChoices.size ? "Check answer" : "Reveal answer"} <span className="shortcut">Space</span></button>
                ) : (
                  <div className="answer-panel">
                    <p className="answer-label">{answerWasCorrect === null ? "ANSWER" : answerWasCorrect ? "CORRECT" : "INCORRECT"}</p>
                    {shouldShowAnswerText(currentCard.back, currentCard.answerImages.length) && <h3>{currentCard.back}</h3>}
                    {currentCard.answerImages.length > 0 && <div className="answer-images">{currentCard.answerImages.map((image) => <img key={image.src} src={image.dataUrl || image.src} alt={image.alt || "Answer diagram"} />)}</div>}
                    {currentCard.explanation && <CapturedText text={currentCard.explanation} as="p" />}
                    {currentQuestion?.discussion && <DiscussionPanel discussion={currentQuestion.discussion} expectedCount={currentQuestion.discussionCount} />}
                    <p className="rating-help">{studySession?.mode === "mastery" ? "Easy removes this question from the Mastery pool. Again, Hard, and Good keep it in the pool." : "Again adds this question to your Mastery pool. Hard and Good return it to the general Mastery list."}</p>
                    <div className="ratings" aria-label="Set difficulty label">{RATING_OPTIONS.map((rating, index) => <button key={rating.value} className={rating.tone} onClick={() => void handleRating(rating.value)}>{rating.label} <kbd>{index + 1}</kbd></button>)}</div>
                  </div>
                )}
              </article>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">✓</div>
                <h2>{!cards.length ? "No questions yet" : studyMode === "mastery" ? allNotEasy.length ? "Build your next Mastery set" : "All questions mastered" : easyPool.length ? "Review mastered questions" : "No Easy questions yet"}</h2>
                <p>{!cards.length ? "Capture a question page with the extension, then import its JSON file." : studyMode === "mastery" ? allNotEasy.length ? "Choose a set size and work every question to Easy." : "Review Easy questions or reset all labels to begin another pass." : easyPool.length ? "Review the least recently practiced Easy questions first." : "Master questions to Easy before starting a review."}</p>
                {!cards.length && <button className="primary" onClick={() => setView("import")}>Import a capture</button>}
              </div>
            )}
          </section>
        )}

        {view === "library" && (
          <section className="library">
            <div className="library-manager">
              <div><strong>{examFilter === ALL_EXAMS ? `${cards.length} question${cards.length === 1 ? "" : "s"} in your library` : `${examCards.length} ${examFilter} question${examCards.length === 1 ? "" : "s"} (${cards.length} total)`}</strong><span>{selectedCardIds.size ? `${selectedCardIds.size} selected` : `${filteredCards.length} shown`}</span></div>
              <div className="library-bulk-actions">
                <button className="secondary compact" disabled={busy || filteredCards.length === 0} onClick={toggleFilteredSelection}>{allFilteredSelected ? "Clear shown" : `Select shown (${filteredCards.length})`}</button>
                <button className="danger-button" disabled={busy || selectedCards.filter(canDeleteCard).length === 0} onClick={() => void handleRemove(selectedCards, "selected")}>Delete selected</button>
                <button className="danger-button danger-solid" disabled={busy || examCards.filter(canDeleteCard).length === 0} onClick={() => void handleRemove(examCards, "all")}>{examFilter === ALL_EXAMS ? "Delete all questions" : `Delete all ${examFilter} questions`}</button>
              </div>
            </div>
            <div className="library-tools"><input type="search" aria-label="Search question library" placeholder="Search questions, answers, notes, or tags" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
            <div className="card-list">
              {filteredCards.map((card) => {
                const content = splitCardFront(card.front);
                const selected = selectedCardIds.has(card.id);
                return <article className={selected ? "selected" : ""} key={card.id}>
                  <label className="card-checkbox"><input type="checkbox" checked={selected} onChange={() => toggleSelection(card.id)} aria-label={`Select question: ${content.prompt}`} /></label>
                  <div className="library-card-content">
                    <div className="library-card-meta"><span className="tag">{card.tags.join(" · ") || "Uncategorized"}</span><div className="library-card-actions"><span className={`mastery-label label-${ratingLabel(card.masteryRating).toLowerCase()}`}>{ratingLabel(card.masteryRating)}</span><button className="danger-link" disabled={busy || !canDeleteCard(card)} title={canDeleteCard(card) ? undefined : "Only the person who contributed this question, or a library owner, can delete it."} onClick={() => void handleRemove([card], "single")}>Delete</button></div></div>
                    <CapturedText text={content.prompt} as="h3" /><p><strong>Answer:</strong> {card.back}</p>{card.notes && <p><strong>Notes:</strong> {card.notes}</p>}
                  </div>
                </article>;
              })}
              {!filteredCards.length && <div className="empty-inline">{cards.length ? "No questions match this search." : "No questions in your library yet."}</div>}
            </div>
          </section>
        )}

        {view === "import" && (
          <section className="import-panel">
            <p className="step">STEP 1</p><h2>Install the capture extension</h2>
            <p>Chrome or Edge on a desktop. Phones cannot run extensions, so capture there and study anywhere.</p>
            <p className="extension-get">
              <a className="primary download-extension" href={`${import.meta.env.BASE_URL}crambot-extension.zip`} download>
                Download the extension
              </a>
              {extensionInfo && <small>Version {extensionInfo.version} · {Math.round(extensionInfo.bytes / 1024)} kB</small>}
            </p>
            <ol className="install-steps">
              <li>Unzip it somewhere you will keep. The browser loads it from that folder every launch, so do not delete it afterwards.</li>
              <li>Open <code>chrome://extensions</code>, or <code>edge://extensions</code>, by pasting it into the address bar. Browsers block pages from linking there.</li>
              <li>Turn on <strong>Developer mode</strong>.</li>
              <li>Select <strong>Load unpacked</strong> and choose the unzipped folder.</li>
            </ol>
            <p className="install-note">
              The browser will show a notice about developer-mode extensions on each launch. That is expected for anything installed outside the Web Store, and it is safe to dismiss.
            </p>

            <p className="step">STEP 2</p><h2>Capture a question page</h2><p>Open the page yourself, then use the extension. Move the downloaded capture, or a full library backup, onto whichever device you are importing from.</p>
            <p className="step">STEP 3</p><h2>Choose your downloaded files</h2>
            <label className={`drop-zone ${busy ? "busy" : ""}`}><input ref={fileInput} type="file" multiple accept=".json,.crambot.json,application/json" disabled={busy} onChange={(event) => event.target.files?.length && void handleImport(Array.from(event.target.files))} /><span className="upload-icon">↥</span><strong>{busy ? "Importing…" : "Choose one or more captures"}</strong><small>Select all page captures at once; duplicates are removed automatically. Select a library backup by itself.</small></label>
          </section>
        )}
      </main>
    </div>
  );
}
