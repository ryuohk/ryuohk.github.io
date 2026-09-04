import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { signOut, type AuthState } from "./auth";
import { repairRunTogetherText, shouldShowAnswerText, splitCapturedList, splitCardFront, stripChoiceLabel } from "./card-content";
import { DiscussionPanel } from "./DiscussionPanel";
import { ALL_EXAMS, filterCardsByExam, listExamCodes } from "./exam-filter";
import { EXAM_FILTER_KEY, SESSION_KEY, SETTINGS_KEY } from "./study-state";
import type { SyncResult } from "./sync";
import {
  DEFAULT_SPEECH_RATE,
  DEFAULT_SPEECH_VOLUME,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  SPEECH_VOLUME_MAX,
  SPEECH_VOLUME_MIN,
  applySpeechSettings,
  buildQuestionSpeech,
  cancelSpeech,
  pauseSpeech,
  resumeSpeech,
  isSpeaking,
  isSpeechSupported,
  listSpeechVoices,
  onVoicesReady,
  speakText,
} from "./speech";
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
  addCardsToGroup,
  addCardsToMasterySession,
  advanceStudySession,
  reviseStudyResult,
  cleanCardGroups,
  cleanMasteryCardIds,
  countCardsByLabel,
  createStudySession,
  deleteGroup,
  evaluateAnswer,
  filterCardsByGroup,
  filterCardsByLabel,
  filterEasyReviewPool,
  filterMasteryPool,
  filterUngroupedCards,
  findGroupName,
  groupsForCard,
  listGroupNames,
  normalizeAnswerLabel,
  normalizeGroupName,
  removeCardsFromGroup,
  renameGroup,
  planEasyReview,
  planMasteryAdditions,
  selectMasteryAdditions,
  setSessionAnswer,
  shuffleItems,
  summarizeStudySession,
  updateMasteryCardIds,
  type CardGroups,
  type LabelFilter,
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
  // Small on purpose. This is the size of a first pool, and the empty state offers to
  // add exactly this many, so it is the first commitment anyone is asked to make.
  masterySetSize: 5,
  shuffleChoices: false,
  masteryPool: "all-not-easy",
  // Everything that is ready, unless you ask for parts. The heading counts the ready
  // pool, so Start review has to hand you that pool and not a silent slice of it.
  easyReviewScope: "all",
  easyReviewSize: 20,
  masteryCardIds: [],
  cardGroups: {},
  speakQuestions: false,
  speechRate: DEFAULT_SPEECH_RATE,
  speechVolume: DEFAULT_SPEECH_VOLUME,
};
/** Per-device: the voice list comes from the OS and differs between machines. */
const VOICE_KEY = "crambot-speech-voice";

/**
 * Two labels, because only two things ever happened.
 *
 * The old four were Anki's, and those words name scheduling intervals: "Again" is show
 * me in a minute, "Good" is the normal gap. Scheduling was taken out of this app, so
 * whichever of the three non-Easy buttons you pressed, the question simply went to the
 * back of the queue. Nothing in the code branched on Good at all, and Hard existed only
 * to populate one dropdown option.
 *
 * The stored values are untouched. Not yet writes 1 and Got it writes 4, exactly as
 * Again and Easy did, so nothing already rated has to be migrated, and a device still
 * running an older build can write a 2 or a 3 without confusing anything: those read
 * back as Not yet, which is what they always behaved as.
 */
const RATING_OPTIONS = [
  { value: MasteryRating.Again, label: "Not yet", tone: "again" },
  { value: MasteryRating.Easy, label: "Got it", tone: "easy" },
] as const;

/**
 * The library's label filter, in the order the labels are earned.
 *
 * The words match the buttons in Study and the badge on each row, because a filter
 * that renamed them would leave you guessing which of two vocabularies you were
 * choosing from. Unrated is last: it is the absence of a label, not a third one.
 */
const LABEL_FILTERS: readonly { value: LabelFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "not-yet", label: "Not yet" },
  { value: "got-it", label: "Got it" },
  { value: "unrated", label: "Unrated" },
];

/**
 * The two library views that are not a group, and the prefix that marks one that is.
 *
 * A group can be called anything, "all" included, so the filter cannot be a bare name.
 */
const ALL_GROUPS = "all";
const UNGROUPED = "ungrouped";
const GROUP_PREFIX = "group:";

function selectedGroupName(filter: string): string | null {
  return filter.startsWith(GROUP_PREFIX) ? filter.slice(GROUP_PREFIX.length) : null;
}

function normalizeQuestionCount(value: unknown, fallback: number): number {
  const count = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(count) ? Math.max(1, Math.floor(count)) : fallback;
}

function normalizeCardIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))] : [];
}

/**
 * Rebuilds the group map from stored or restored JSON, discarding anything malformed.
 *
 * These settings come back from localStorage, from another device through sync, and
 * from a backup file, and the last of those is a file a person can edit. A group with
 * no name or no members is dropped rather than kept as something the filter would
 * offer and the list would never fill.
 */
function normalizeCardGroups(value: unknown): CardGroups {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const groups: CardGroups = {};
  for (const [rawName, cardIds] of Object.entries(value as Record<string, unknown>)) {
    const name = normalizeGroupName(rawName);
    const members = normalizeCardIds(cardIds);
    if (!name || members.length === 0) continue;
    // A file could hold "Networking" and "networking" as separate keys; fold them.
    const existing = findGroupName(groups, name);
    groups[existing ?? name] = [...new Set([...(existing ? groups[existing] : []), ...members])];
  }
  return groups;
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
      shuffleChoices: stored.shuffleChoices === true,
      // Pinned, not read. With two labels "Again + Hard only" and "All not Easy" select
      // the same questions, so the choice was removed. Reading a stored "again-hard"
      // would quietly hide questions carrying the retired Good, which are in the pool.
      masteryPool: "all-not-easy",
      // Absent in anything saved before parts existed, and those settings were carrying
      // a size that was applied whether or not anyone had chosen it. Reading a missing
      // value as "all" is what turns that stale 20 back into the whole ready pool.
      easyReviewScope: stored.easyReviewScope === "batch" ? "batch" : "all",
      easyReviewSize: normalizeQuestionCount(stored.easyReviewSize, migratedCount),
      masteryCardIds: [...new Set([...masteryCardIds, ...legacySessionIds])],
      cardGroups: normalizeCardGroups(stored.cardGroups),
      speakQuestions: stored.speakQuestions === true,
      speechRate: normalizeSpeechRate(stored.speechRate),
      speechVolume: normalizeSpeechVolume(stored.speechVolume),
    };
  } catch {
    return {
      ...DEFAULT_STUDY_SETTINGS,
      masteryCardIds: session?.mode === "mastery" ? normalizeCardIds(session.queue) : [],
    };
  }
}

function normalizeSpeechRate(value: unknown): number {
  const rate = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(rate)) return DEFAULT_SPEECH_RATE;
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate));
}

function normalizeSpeechVolume(value: unknown): number {
  const volume = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(volume)) return DEFAULT_SPEECH_VOLUME;
  return Math.min(SPEECH_VOLUME_MAX, Math.max(SPEECH_VOLUME_MIN, volume));
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
  if (rating === null) return "Unrated";
  // Retired Hard and Good read as Not yet: they always behaved as in-pool.
  return rating === MasteryRating.Easy ? "Got it" : "Not yet";
}

/** A class-name-safe stand-in, since the labels themselves now contain a space. */
function ratingTone(rating: MasteryRatingValue | null): string {
  if (rating === null) return "unrated";
  return rating === MasteryRating.Easy ? "easy" : "again";
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

/**
 * A panel behind a caret, for controls that are set once or used rarely.
 *
 * A `details` element only closes when its own summary is clicked, which for a panel
 * floating over the page means it stays open while you carry on working behind it.
 * The outside click is caught on pointerdown rather than click, so dragging a slider
 * and releasing beyond the panel does not count as leaving: the gesture began inside.
 */
function MoreMenu({ label, title, className, children }: { label: ReactNode; title: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      if (menuRef.current) menuRef.current.open = false;
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const menu = menuRef.current;
      // A missing element means the panel was unmounted while open. Clearing the state
      // here is what detaches these listeners.
      if (menu && menu.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <details className={`more-menu ${className ?? ""}`.trim()} ref={menuRef} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary title={title} aria-label={title}>{label}</summary>
      <div className="more-panel">{children}</div>
    </details>
  );
}

/**
 * Files the current selection under a group, existing or new.
 *
 * One control for both, because "add these to Networking" and "add these to a group I
 * am inventing now" are the same intention and splitting them into two buttons makes
 * you decide which one you are doing before you have decided anything.
 *
 * The panel stays open after a pick, deliberately: filing a selection under two
 * groups at once is ordinary, and the notice underneath already confirms each one.
 */
function GroupPicker({ names, selectionSize, onPick }: { names: readonly string[]; selectionSize: number; onPick: (name: string) => void }) {
  const [draft, setDraft] = useState("");
  const pending = normalizeGroupName(draft);
  const taken = names.some((name) => name.toLowerCase() === pending.toLowerCase());
  return (
    <MoreMenu className="group-menu" title="File the selected questions under a group" label="Add to group ▾">
      {selectionSize === 0
        ? <p className="group-menu-hint">Select some questions first, then file them under a group.</p>
        : <>
          <form onSubmit={(event) => { event.preventDefault(); if (!pending) return; onPick(pending); setDraft(""); }}>
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="New group"
              aria-label="New group name"
              maxLength={48}
            />
            <button className="primary compact" type="submit" disabled={!pending}>
              {taken ? "Add" : "Create"}
            </button>
          </form>
          {names.length > 0 && <p className="group-menu-hint">Or one you already have:</p>}
          {names.map((name) => (
            <button key={name} className="secondary compact" onClick={() => onPick(name)}>{name}</button>
          ))}
        </>}
    </MoreMenu>
  );
}

function CapturedText({ text: raw, as: Element, className }: { text: string; as: CapturedTextElement; className?: string }) {
  // Idempotent, so prose that came through splitCardFront already is unharmed.
  const text = repairRunTogetherText(raw);
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
  // Not persisted, unlike the exam filter. That one says which course you are on and
  // holds between visits; this one narrows a list you are looking at right now, and
  // coming back to a library that silently hides most of itself is a bug report.
  const [labelFilter, setLabelFilter] = useState<LabelFilter>("all");
  // Prefixed rather than a bare name, so a group called "all" or "ungrouped" cannot
  // be mistaken for the two options that are not groups.
  const [groupFilter, setGroupFilter] = useState<string>(ALL_GROUPS);
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
        setStudySettings((existing) => ({ ...existing, masteryCardIds: cleanMasteryCardIds(storedCards, existing.masteryCardIds), cardGroups: cleanCardGroups(existing.cardGroups, storedCards) }));
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
        setStudySettings((existing) => ({ ...existing, masteryCardIds: cleanMasteryCardIds(storedCards, existing.masteryCardIds), cardGroups: cleanCardGroups(existing.cardGroups, storedCards) }));
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
  const easyReviewPlan = useMemo(() => planEasyReview(easyPool.length, studySettings), [easyPool.length, studySettings]);
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
  /**
   * The choices in the order they are shown, which is also the order they are read.
   *
   * Keyed on the question and the toggle rather than on the choices array, which is
   * rebuilt every render and would otherwise reshuffle on every keystroke. Flipping the
   * toggle is a dependency change, so it reshuffles what is on screen at once; turning
   * it off restores the order the question was captured in.
   */
  const displayChoices = useMemo(() => {
    if (!currentCard) return [];
    const choices = splitCardFront(currentCard.front).choices;
    return studySettings.shuffleChoices ? shuffleItems(choices) : choices;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCard?.id, currentCard?.front, studySettings.shuffleChoices]);
  // History is always shown answered; there is nothing to reveal about it.
  const showAnswer = revealed || viewingHistory;
  const answerWasCorrect = showAnswer ? evaluateAnswer([...activeChoices], correctAnswers) : null;
  /**
   * Shuffled rows still give the game away while their letters are on show, because the
   * letters keep the captured order whatever the rows do. Hidden only while the answer
   * is, so on reveal the stated answer, the highlighting and the discussion all line up
   * with visible letters again.
   */
  const hideChoiceLabels = studySettings.shuffleChoices && !showAnswer;
  /**
   * Exactly what the rows say, so what is read matches what is on screen. Memoized
   * because mapping would otherwise hand the speech memo a new array every render.
   */
  const spokenChoices = useMemo(
    () => (hideChoiceLabels ? displayChoices.map(stripChoiceLabel) : displayChoices),
    [displayChoices, hideChoiceLabels],
  );
  const sessionFinished = Boolean(studySession && studySession.queue.length === 0 && !viewingHistory);
  const sessionSummary = studySession ? summarizeStudySession(studySession) : null;

  // Counted before the search narrows anything, so the filter reports what the exam
  // holds rather than what the words you have typed so far happen to leave.
  const labelCounts = useMemo(() => countCardsByLabel(examCards), [examCards]);

  const cardGroups = studySettings.cardGroups;
  const groupNames = useMemo(() => listGroupNames(cardGroups), [cardGroups]);
  // Scoped to the exam, so switching exams does not offer groups with nothing in them.
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const name of groupNames) counts.set(name, filterCardsByGroup(examCards, cardGroups, name).length);
    return counts;
  }, [cardGroups, examCards, groupNames]);
  const ungroupedCount = useMemo(() => filterUngroupedCards(examCards, cardGroups).length, [cardGroups, examCards]);
  // One pass for the whole list rather than a scan per row.
  const groupsByCardId = useMemo(() => {
    const byCard = new Map<string, string[]>();
    for (const name of groupNames) {
      for (const cardId of cardGroups[name]) byCard.set(cardId, [...(byCard.get(cardId) ?? []), name]);
    }
    return byCard;
  }, [cardGroups, groupNames]);
  const activeGroup = selectedGroupName(groupFilter);

  // A group that empties out, or an exam that has none of its questions, would leave
  // the library looking empty for a reason nothing on screen explains.
  useEffect(() => {
    if (activeGroup && !findGroupName(cardGroups, activeGroup)) setGroupFilter(ALL_GROUPS);
  }, [activeGroup, cardGroups]);

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const scoped = activeGroup
      ? filterCardsByGroup(examCards, cardGroups, activeGroup)
      : groupFilter === UNGROUPED
        ? filterUngroupedCards(examCards, cardGroups)
        : examCards;
    return filterCardsByLabel(scoped, labelFilter)
      // Group names join the haystack, so searching "networking" finds the questions
      // you filed under it even when the word appears nowhere in the question itself.
      .filter((card) => !needle || `${card.front} ${card.back} ${card.notes ?? ""} ${card.tags.join(" ")} ${(groupsByCardId.get(card.id) ?? []).join(" ")}`.toLowerCase().includes(needle))
      .sort((left, right) => left.front.localeCompare(right.front));
  }, [activeGroup, cardGroups, examCards, groupFilter, groupsByCardId, labelFilter, query]);
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
          setStudySettings((existing) => ({
            masterySetSize: normalizeQuestionCount(restored.masterySetSize, count),
            // A backup predating either preference carries none, so keep this device's.
            shuffleChoices: restored.shuffleChoices ?? existing.shuffleChoices,
            masteryPool: restored.masteryPool === "again-hard" ? "again-hard" : "all-not-easy",
            easyReviewScope: restored.easyReviewScope === "batch" ? "batch" : "all",
            easyReviewSize: normalizeQuestionCount(restored.easyReviewSize, count),
            masteryCardIds: normalizeCardIds(restored.masteryCardIds),
            // A backup predating groups carries none, so this device keeps its own
            // rather than having them wiped by restoring an older library.
            cardGroups: restored.cardGroups ? normalizeCardGroups(restored.cardGroups) : existing.cardGroups,
            speakQuestions: restored.speakQuestions ?? existing.speakQuestions,
            speechRate: normalizeSpeechRate(restored.speechRate ?? existing.speechRate),
            speechVolume: normalizeSpeechVolume(restored.speechVolume ?? existing.speechVolume),
          }));
        }
        setNotice(`Restored ${selection.library.cards.length} questions and ${selection.library.reviews.length} rating records.`);
      } else {
        await saveImport(selection.prepared.questions, selection.prepared.cards);
        setNotice(`Imported ${selection.prepared.added} new and updated ${selection.prepared.updated} existing questions.`);
      }
      const [refreshedCards, refreshedQuestions] = await Promise.all([listCards(), listQuestions()]);
      setCards(refreshedCards);
      setQuestions(refreshedQuestions);
      setStudySettings((existing) => ({ ...existing, masteryCardIds: cleanMasteryCardIds(refreshedCards, existing.masteryCardIds), cardGroups: cleanCardGroups(existing.cardGroups, refreshedCards) }));
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

  /**
   * Empties the Mastery pool.
   *
   * Scoped to the exam filter, because clearing while filtered to one exam should not
   * quietly discard the pool you built for another. Ratings are left alone: the pool is
   * a list of what you chose to drill, not a record of how well you know it, so
   * clearing it costs you the selection and nothing else.
   */
  function clearMasteryPool() {
    const scopedIds = examFilter === ALL_EXAMS ? null : new Set(examCards.map((card) => card.id));
    const remaining = scopedIds ? studySettings.masteryCardIds.filter((id) => !scopedIds.has(id)) : [];
    const removed = studySettings.masteryCardIds.length - remaining.length;
    if (removed === 0) {
      setNotice("The Mastery pool is already empty.");
      return;
    }
    if (!window.confirm(`Remove ${removed} question${removed === 1 ? "" : "s"} from the Mastery pool? Your Again, Hard, Good and Easy labels are kept.`)) return;
    setStudySettings((existing) => ({ ...existing, masteryCardIds: remaining }));
    setStudySession((existing) => (existing?.mode === "mastery" ? null : existing));
    cancelSpeech();
    setSpeechPaused(false);
    setRevealed(false);
    setNotice(`Mastery pool cleared. ${removed} question${removed === 1 ? "" : "s"} removed.`);
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

  /**
   * Files the selected questions under a group, creating it if it is new.
   *
   * Groups are yours alone. They ride in your study settings, which sync between your
   * own devices and never reach the shared library, so grouping questions by what they
   * have in common is a note to yourself rather than an edit to everyone's copy.
   */
  function addSelectedToGroup(rawName: string) {
    const name = normalizeGroupName(rawName);
    if (!name || selectedCards.length === 0) return;
    const cardIds = selectedCards.map((card) => card.id);
    const existingName = findGroupName(cardGroups, name);
    const alreadyIn = new Set(existingName ? cardGroups[existingName] : []);
    const added = cardIds.filter((cardId) => !alreadyIn.has(cardId)).length;
    setStudySettings((existing) => ({ ...existing, cardGroups: addCardsToGroup(existing.cardGroups, name, cardIds) }));
    setNotice(added === 0
      ? `Already in ${existingName ?? name}.`
      : `${added} question${added === 1 ? "" : "s"} added to ${existingName ?? name}.`);
  }

  function removeSelectedFromGroup(name: string) {
    if (selectedCards.length === 0) return;
    const cardIds = selectedCards.map((card) => card.id);
    const remaining = removeCardsFromGroup(cardGroups, name, cardIds);
    const removed = (cardGroups[name]?.length ?? 0) - (remaining[name]?.length ?? 0);
    if (removed === 0) {
      setNotice(`None of the selected questions are in ${name}.`);
      return;
    }
    setStudySettings((existing) => ({ ...existing, cardGroups: removeCardsFromGroup(existing.cardGroups, name, cardIds) }));
    setSelectedCardIds(new Set());
    setNotice(remaining[name]
      ? `${removed} question${removed === 1 ? "" : "s"} removed from ${name}.`
      : `${name} is empty now, so it has been removed.`);
  }

  function handleRenameGroup(name: string) {
    const wanted = window.prompt(`Rename ${name} to:`, name);
    if (wanted === null) return;
    const next = normalizeGroupName(wanted);
    if (!next || next === name) return;
    const merging = findGroupName(cardGroups, next);
    if (merging && merging !== name && !window.confirm(`${merging} already exists. Merge ${name} into it?`)) return;
    setStudySettings((existing) => ({ ...existing, cardGroups: renameGroup(existing.cardGroups, name, next) }));
    setGroupFilter(`${GROUP_PREFIX}${merging ?? next}`);
    setNotice(merging && merging !== name ? `${name} merged into ${merging}.` : `Renamed to ${next}.`);
  }

  /** Only the grouping goes; the questions and your labels on them are untouched. */
  function handleDeleteGroup(name: string) {
    const count = cardGroups[name]?.length ?? 0;
    if (!window.confirm(`Remove the group ${name}? The ${count} question${count === 1 ? "" : "s"} in it stay in your library, along with your labels.`)) return;
    setStudySettings((existing) => ({ ...existing, cardGroups: deleteGroup(existing.cardGroups, name) }));
    setGroupFilter(ALL_GROUPS);
    setNotice(`${name} removed. Its questions are still in your library.`);
  }

  /**
   * Puts hand-picked library questions into the Mastery pool.
   *
   * Picking from the library is how you drill a specific topic rather than whatever a
   * random batch offers. Anything already marked Got it has its label cleared on the
   * way in, because the pool sheds Got it questions on every sync and it would
   * otherwise look added and then disappear. That is a change to your ratings, so the
   * notice says how many, rather than it happening quietly.
   */
  async function handleAddSelectedToPool() {
    if (selectedCards.length === 0) return;
    const plan = planMasteryAdditions(selectedCards, studySettings.masteryCardIds);
    setBusy(true);
    try {
      if (plan.unretire.length) setCards(await resetMasteryRatings(plan.unretire));
      setStudySettings((existing) => ({
        ...existing,
        masteryCardIds: [...new Set([...existing.masteryCardIds, ...plan.add])],
      }));
      // A Mastery session already running takes them too, rather than making you
      // finish the set before the questions you just chose appear.
      setStudySession((existing) => (existing?.mode === "mastery" ? addCardsToMasterySession(existing, plan.add) : existing));
      setSelectedCardIds(new Set());
      const parts = [`${plan.add.length} question${plan.add.length === 1 ? "" : "s"} added to the Mastery pool.`];
      if (plan.alreadyPooled.length) parts.push(`${plan.alreadyPooled.length} ${plan.alreadyPooled.length === 1 ? "was" : "were"} already in it.`);
      if (plan.unretire.length) parts.push(`${plan.unretire.length} marked Got it ${plan.unretire.length === 1 ? "is" : "are"} now unrated so ${plan.unretire.length === 1 ? "it" : "they"} can be drilled again.`);
      setNotice(parts.join(" "));
      cloud.request();
    } catch (error) {
      setNotice(`Could not add to the Mastery pool: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
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

  /**
   * Voice choice stays on the device rather than syncing. The available voices come
   * from the operating system, so a name picked on a laptop simply does not exist on
   * a phone, and syncing it would leave one device silently falling back.
   */
  const [voiceURI, setVoiceURI] = useState<string>(() => {
    try {
      return localStorage.getItem(VOICE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speechPaused, setSpeechPaused] = useState(false);
  const [speechActive, setSpeechActive] = useState(false);
  useEffect(() => {
    const refresh = () => setVoices(listSpeechVoices());
    refresh();
    return onVoicesReady(refresh);
  }, []);

  /**
   * Live speech settings, read fresh as each chunk starts.
   *
   * Kept in a ref rather than the effect's dependencies so that dragging the speed or
   * volume slider does not cancel and restart the question. The utterance already
   * speaking cannot change, so an adjustment lands on the next sentence.
   */
  const speechOptionsRef = useRef({ rate: studySettings.speechRate, volume: studySettings.speechVolume, voiceURI: voiceURI || null });
  speechOptionsRef.current = { rate: studySettings.speechRate, volume: studySettings.speechVolume, voiceURI: voiceURI || null };

  const currentSpeechText = useMemo(
    () => currentCard && reviewContent
      ? buildQuestionSpeech(reviewContent.prompt, spokenChoices, currentCard.questionImages.length)
      : "",
    [currentCard, reviewContent, spokenChoices],
  );

  /**
   * Whether a question is actually mid-reading.
   *
   * Speech ends on its own with no React-visible event, so a button labelled from the
   * last click would say "Pause" long after the reading finished. Polling while the
   * toggle is on is cheap and keeps the label honest.
   */
  useEffect(() => {
    if (!studySettings.speakQuestions || !isSpeechSupported()) {
      setSpeechActive(false);
      return;
    }
    const tick = () => setSpeechActive(isSpeaking());
    tick();
    const timer = window.setInterval(tick, 400);
    return () => window.clearInterval(timer);
  }, [studySettings.speakQuestions, currentCard?.id, speechPaused]);


  /** One button covering pause, resume, and replaying a question already read out. */
  function toggleSpeechPlayback() {
    if (speechPaused) {
      // Resume picks up at the interrupted sentence. It returns false only if the run
      // was discarded meanwhile, in which case reading the question again is better
      // than the button doing nothing.
      if (!resumeSpeech() && currentSpeechText) speakText(currentSpeechText, () => speechOptionsRef.current);
      setSpeechPaused(false);
      return;
    }
    if (pauseSpeech()) {
      setSpeechPaused(true);
      return;
    }
    if (currentSpeechText) speakText(currentSpeechText, () => speechOptionsRef.current);
  }

  /**
   * Speaks whenever the question changes, and only then. Reveals, re-renders and
   * slider adjustments must not restart it.
   */
  useEffect(() => {
    if (!studySettings.speakQuestions || !currentCard || !reviewContent || view !== "study") {
      cancelSpeech();
      setSpeechPaused(false);
      return;
    }
    setSpeechPaused(false);
    speakText(
      // Read in the order shown. Not a dependency: reshuffling mid-question should not
      // interrupt the reading, and the choices are read from the current value anyway.
      buildQuestionSpeech(reviewContent.prompt, spokenChoices, currentCard.questionImages.length),
      () => speechOptionsRef.current,
    );
    // Leaving the question, the view, or the app stops it mid-sentence rather than
    // talking over whatever comes next.
    return () => cancelSpeech();
    // Rate and volume are deliberately absent: they are read live from the ref.
  }, [currentCard?.id, studySettings.speakQuestions, voiceURI, view]);

  useEffect(() => () => cancelSpeech(), []);

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
          <h1>{view === "study" ? "Study" : view === "library" ? "Library" : "Import"}</h1>
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
            {/* Setup, and the standing totals, are about choosing what to study. Once a
                session is running they sit between you and the question for no reason,
                so they give way to the row below and the question moves up the page. */}
            {!studySession && (
            <section className="mastery-overview" aria-label="Mastery progress">
              <div><strong>{allNotEasy.length}</strong><span>to master</span></div>
              <div><strong>{easyPool.length}</strong><span>got it</span></div>
              <div><strong>{examCards.length ? Math.round((easyPool.length / examCards.length) * 100) : 0}%</strong><span>mastered</span></div>
            </section>
            )}

            <div className="study-controls">
              {studySession ? (
              <div className="session-settings running-session">
                {studyMode === "mastery" && <button className="secondary compact" disabled={masteryAdditionsAvailable.length === 0} onClick={() => addToMasteryPool()}>Add questions</button>}
                <button className="secondary compact" onClick={() => setStudySession(null)}>End session</button>
              </div>
              ) : (
              <>
              <div className="mode-tabs two-mode" role="group" aria-label="Study mode">
                <button className={studyMode === "mastery" ? "active" : ""} aria-pressed={studyMode === "mastery"} onClick={() => { setStudyMode("mastery"); setStudySession(null); setRevealed(false); }}>Mastery</button>
                <button className={studyMode === "easy-review" ? "active" : ""} aria-pressed={studyMode === "easy-review"} onClick={() => { setStudyMode("easy-review"); setStudySession(null); setRevealed(false); }}>Review</button>
              </div>
              <p className="mode-description">{studyMode === "mastery"
                ? "Build a persistent pool and work each question until you have got it."
                : "Review mastered questions once; relabel anything that needs more work."}</p>
              <div className="session-settings simplified-settings">
                {studyMode === "mastery" ? <>
                  <CountField
                    label="Questions to add"
                    value={studySettings.masterySetSize}
                    onCommit={(masterySetSize) => setStudySettings((existing) => ({ ...existing, masterySetSize }))}
                  />
                  <span className="pool-count">{currentMasteryPool.length} in pool · {masteryAdditionsAvailable.length} available to add</span>
                </> : <>
                  <div className="scope-tabs" role="group" aria-label="How much to review">
                    <button
                      className={studySettings.easyReviewScope === "all" ? "active" : ""}
                      aria-pressed={studySettings.easyReviewScope === "all"}
                      onClick={() => setStudySettings((existing) => ({ ...existing, easyReviewScope: "all" }))}
                    >All {easyPool.length}</button>
                    <button
                      className={studySettings.easyReviewScope === "batch" ? "active" : ""}
                      aria-pressed={studySettings.easyReviewScope === "batch"}
                      onClick={() => setStudySettings((existing) => ({ ...existing, easyReviewScope: "batch" }))}
                    >In parts</button>
                  </div>
                  {studySettings.easyReviewScope === "batch" && (
                    <CountField
                      label="Questions per part"
                      value={studySettings.easyReviewSize}
                      onCommit={(easyReviewSize) => setStudySettings((existing) => ({ ...existing, easyReviewSize }))}
                    />
                  )}
                  <span className="pool-count">{studySettings.easyReviewScope === "batch"
                    ? `${easyReviewPlan.sessionSize} this session · ${easyReviewPlan.parts} part${easyReviewPlan.parts === 1 ? "" : "s"} to cover all ${easyPool.length}`
                    : `${easyPool.length} to review`}</span>
                </>}
                {studyMode === "mastery" ? <>
                  <button className="primary compact" disabled={currentMasteryPool.length === 0} onClick={() => startStudySession("mastery")}>Study current pool</button>
                  <button className="secondary compact" disabled={masteryAdditionsAvailable.length === 0} onClick={() => addToMasteryPool()}>Add questions to pool</button>
                  <button className="secondary compact" disabled={currentMasteryPool.length === 0} onClick={() => clearMasteryPool()}>Clear pool</button>
                </> : <button className="primary compact" disabled={easyPool.length === 0} onClick={() => startStudySession("easy-review")}>Start review</button>}
              </div>
              </>
              )}
              <div className="study-toggles">
                <label className="study-toggle">
                  <input
                    type="checkbox"
                    checked={studySettings.shuffleChoices}
                    onChange={(event) => setStudySettings((existing) => ({ ...existing, shuffleChoices: event.target.checked }))}
                  />
                  Shuffle choices
                </label>
                {isSpeechSupported() && (
                  <label className="study-toggle">
                    <input
                      type="checkbox"
                      checked={studySettings.speakQuestions}
                      onChange={(event) => setStudySettings((existing) => ({ ...existing, speakQuestions: event.target.checked }))}
                    />
                    Read questions aloud
                  </label>
                )}
                {isSpeechSupported() && studySettings.speakQuestions && (
                    <>
                      <button
                        type="button"
                        className={speechPaused ? "primary compact" : "secondary compact"}
                        disabled={!currentSpeechText && !speechActive && !speechPaused}
                        onClick={() => toggleSpeechPlayback()}
                      >
                        {speechPaused ? "▶ Play" : speechActive ? "❚❚ Pause" : "↻ Read again"}
                      </button>
                      {/* Speed, volume and voice are set once and then never touched, so
                          they sit behind a caret rather than taking a band of the screen
                          above every question. */}
                      <MoreMenu
                        title="Speech settings"
                        label={`${studySettings.speechRate.toFixed(1)}× · ${Math.round(studySettings.speechVolume * 100)}%`}
                      >
                          <label className="speech-rate">
                            Speed
                            <input
                              type="range"
                              min={SPEECH_RATE_MIN}
                              max={SPEECH_RATE_MAX}
                              step={0.1}
                              value={studySettings.speechRate}
                              onChange={(event) => setStudySettings((existing) => ({ ...existing, speechRate: Number(event.target.value) }))}
                              onPointerUp={() => applySpeechSettings()}
                              onKeyUp={() => applySpeechSettings()}
                            />
                            <span className="speech-rate-value">{studySettings.speechRate.toFixed(1)}×</span>
                          </label>
                          <label className="speech-rate">
                            Volume
                            <input
                              type="range"
                              min={SPEECH_VOLUME_MIN}
                              max={SPEECH_VOLUME_MAX}
                              step={0.05}
                              value={studySettings.speechVolume}
                              onChange={(event) => setStudySettings((existing) => ({ ...existing, speechVolume: Number(event.target.value) }))}
                              onPointerUp={() => applySpeechSettings()}
                              onKeyUp={() => applySpeechSettings()}
                            />
                            <span className="speech-rate-value">{Math.round(studySettings.speechVolume * 100)}%</span>
                          </label>
                          {voices.length > 0 && (
                            <label className="speech-voice">
                              Voice
                              <select
                                value={voiceURI}
                                onChange={(event) => {
                                  setVoiceURI(event.target.value);
                                  try {
                                    if (event.target.value) localStorage.setItem(VOICE_KEY, event.target.value);
                                    else localStorage.removeItem(VOICE_KEY);
                                  } catch {
                                    // The choice simply will not persist; speech still works.
                                  }
                                }}
                              >
                                <option value="">System default</option>
                                {voices.map((voice) => (
                                  <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>
                                ))}
                              </select>
                            </label>
                          )}
                          <button
                            type="button"
                            className="secondary compact"
                            onClick={() => speakText("Speech is on. This is how questions will sound.", () => speechOptionsRef.current)}
                          >
                            Test voice
                          </button>
                      </MoreMenu>
                  </>
                )}
              </div>
            </div>

            <div className="progress-card">
              {studySession ? <>
                <div><span className="metric">{studySession.queue.length}</span><small>remaining</small></div>
                <div><span className="metric">{studySession.completed}</span><small>{studyMode === "mastery" ? "mastered" : "reviewed"}</small></div>
                <div><span className="metric">{studySession.attempts}</span><small>attempts</small></div>
              </> : <>
                <div><span className="metric">{studyMode === "mastery" ? currentMasteryPool.length : easyPool.length}</span><small>{studyMode === "mastery" ? "in pool" : "available"}</small></div>
                <div><span className="metric">{studyMode === "mastery" ? masteryAdditionsAvailable.length : easyReviewPlan.sessionSize}</span><small>{studyMode === "mastery" ? "available to add" : "this session"}</small></div>
              </>}
            </div>

            {sessionFinished && studySession && sessionSummary ? (
              <section className="results-card">
                <p className="kicker">SESSION COMPLETE</p>
                <h2>{studySession.mode === "mastery" ? "Mastery set complete" : "Review complete"}</h2>
                <div className="result-metrics">
                  <div><strong>{sessionSummary.completed}</strong><span>{studySession.mode === "mastery" ? "mastered" : "reviewed"}</span></div>
                  <div><strong>{formatDuration(sessionSummary.durationSeconds)}</strong><span>duration</span></div>
                  <div><strong>{sessionSummary.averageSeconds}s</strong><span>per question</span></div>
                  <div><strong>{sessionSummary.accuracy === null ? "—" : `${sessionSummary.accuracy}%`}</strong><span>answer accuracy</span></div>
                </div>
                <div className="result-actions">
                  <button className="primary" disabled={currentMasteryPool.length === 0 && masteryAdditionsAvailable.length === 0} onClick={() => currentMasteryPool.length ? startStudySession("mastery") : addToMasteryPool(true)}>{currentMasteryPool.length ? "Study Mastery pool" : "Build Mastery pool"}</button>
                  <button className="secondary" disabled={easyPool.length === 0} onClick={() => startStudySession("easy-review")}>Review what you know</button>
                  <button className="secondary" onClick={() => setStudySession(null)}>Done</button>
                </div>
              </section>
            ) : currentCard && reviewContent ? (
              <article className="study-card">
                <div className="card-meta">
                  {/* Counts mastery, not position. Unmastered cards are pushed back onto
                      the queue, so there is no stable position to count through. */}
                  <span>{currentCard.tags.join(" · ") || "Uncategorized"}</span>
                  <span className={`mastery-label label-${ratingTone(currentCard.masteryRating)}`}>{ratingLabel(currentCard.masteryRating)}</span>
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
                  {displayChoices.map((choice) => {
                    const selected = activeChoices.has(choice);
                    const expected = correctAnswers.map(normalizeAnswerLabel).includes(normalizeAnswerLabel(choice));
                    const feedbackClass = showAnswer ? expected ? "correct-choice" : selected ? "incorrect-choice" : "" : "";
                    return <button type="button" key={choice} className={`${selected ? "selected" : ""} ${feedbackClass}`.trim()} aria-pressed={selected} disabled={showAnswer} onClick={() => toggleChoice(choice)}>{hideChoiceLabels ? stripChoiceLabel(choice) : choice}</button>;
                  })}
                </div>
                {!showAnswer ? (
                  <button className="primary reveal" onClick={() => setRevealed(true)}>{activeChoices.size ? "Check answer" : "Reveal answer"} <span className="shortcut">Space</span></button>
                ) : (
                  <div className="answer-panel">
                    <p className="answer-label">{answerWasCorrect === null ? "ANSWER" : answerWasCorrect ? "CORRECT" : "INCORRECT"}</p>
                    {shouldShowAnswerText(currentCard.back, currentCard.answerImages.length) && <h3>{repairRunTogetherText(currentCard.back)}</h3>}
                    {currentCard.answerImages.length > 0 && <div className="answer-images">{currentCard.answerImages.map((image) => <img key={image.src} src={image.dataUrl || image.src} alt={image.alt || "Answer diagram"} />)}</div>}
                    {currentCard.explanation && <CapturedText text={currentCard.explanation} as="p" />}
                    {currentQuestion?.discussion && <DiscussionPanel discussion={currentQuestion.discussion} expectedCount={currentQuestion.discussionCount} />}
                    <p className="rating-help">{studySession?.mode === "mastery" ? "Got it retires this question from the pool. Not yet keeps it in and brings it round again." : "Not yet puts this question back into your Mastery pool. Got it keeps it in the review rotation."}</p>
                    <div className="ratings" aria-label="Rate this question">{RATING_OPTIONS.map((rating, index) => <button key={rating.value} className={rating.tone} onClick={() => void handleRating(rating.value)}>{rating.label} <kbd>{index + 1}</kbd></button>)}</div>
                  </div>
                )}
              </article>
            ) : (
              /* This is where the app explains itself. It shows only when there is
                 nothing to study, which is exactly when someone does not know what to
                 do, and it is gone for good once they act, so it costs nothing to
                 anyone who already knows their way around. It names buttons that are
                 on screen rather than describing concepts, and it offers the next step
                 directly instead of telling you to go and find it. */
              <div className="empty-state">
                {!cards.length ? (
                  <>
                    <div className="empty-icon">↥</div>
                    <h2>No questions yet</h2>
                    <p>Capture a question page with the extension, then import the file it saves.</p>
                    <button className="primary" onClick={() => setView("import")}>Import a capture</button>
                  </>
                ) : studyMode === "mastery" ? (
                  currentMasteryPool.length ? (
                    <>
                      <div className="empty-icon">◉</div>
                      <h2>{currentMasteryPool.length} question{currentMasteryPool.length === 1 ? "" : "s"} waiting in your pool</h2>
                      <p>Pick up where you left off, or add more before you start.</p>
                      <button className="primary" onClick={() => startStudySession("mastery")}>Study current pool</button>
                    </>
                  ) : masteryAdditionsAvailable.length ? (
                    <>
                      <div className="empty-icon">◉</div>
                      <h2>Build a pool, then work it down</h2>
                      <ol className="empty-steps">
                        <li>Your <strong>pool</strong> is the set you are drilling right now. It starts empty.</li>
                        <li>Answer a question, reveal it, then say <strong>Got it</strong> or <strong>Not yet</strong>.</li>
                        <li><strong>Got it</strong> retires a question. <strong>Not yet</strong> brings it round again. You are done when the pool is empty.</li>
                      </ol>
                      <div className="empty-actions">
                        <button className="primary" onClick={() => addToMasteryPool(true)}>Add {Math.min(studySettings.masterySetSize, masteryAdditionsAvailable.length)} and start</button>
                        <button className="secondary" onClick={() => setView("library")}>Pick questions myself</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="empty-icon">✓</div>
                      <h2>Nothing left to master</h2>
                      <p>Every question here is marked Got it. Review them to keep them fresh, or reset your labels from the Library to make another pass.</p>
                      {easyPool.length > 0 && <button className="primary" onClick={() => startStudySession("easy-review")}>Review what you know</button>}
                    </>
                  )
                ) : easyPool.length ? (
                  <>
                    <div className="empty-icon">◉</div>
                    <h2>{easyPool.length} question{easyPool.length === 1 ? "" : "s"} ready to review</h2>
                    <p>Review asks what you have not seen in longest, first. Answer <strong>Not yet</strong> on anything shaky and it goes back into your Mastery pool.</p>
                    {studySettings.easyReviewScope === "batch" && (
                      <p className="empty-note">Set to parts of {studySettings.easyReviewSize}, so this session takes {easyReviewPlan.sessionSize} and the next one carries on from there.</p>
                    )}
                    <button className="primary" onClick={() => startStudySession("easy-review")}>Start review{studySettings.easyReviewScope === "batch" ? ` · ${easyReviewPlan.sessionSize}` : ""}</button>
                  </>
                ) : (
                  <>
                    <div className="empty-icon">✓</div>
                    <h2>Nothing to review yet</h2>
                    <p>Questions arrive here once you mark them <strong>Got it</strong> in Mastery.</p>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {view === "library" && (
          <section className="library">
            <div className="library-tools">
              <input type="search" aria-label="Search question library" placeholder="Search questions, answers, notes, groups, or tags" value={query} onChange={(event) => setQuery(event.target.value)} />
              <label className="group-filter">
                <span>Group</span>
                <select
                  value={groupFilter}
                  // Same reasoning as the label filter: a selection made under one
                  // view must not act on rows another view hides.
                  onChange={(event) => { setGroupFilter(event.target.value); setSelectedCardIds(new Set()); }}
                >
                  <option value={ALL_GROUPS}>All groups ({examCards.length})</option>
                  {groupNames.map((name) => (
                    <option key={name} value={`${GROUP_PREFIX}${name}`}>{name} ({groupCounts.get(name) ?? 0})</option>
                  ))}
                  <option value={UNGROUPED}>Ungrouped ({ungroupedCount})</option>
                </select>
              </label>
              <div className="label-filter" role="group" aria-label="Filter by label">
                {LABEL_FILTERS.map(({ value, label }) => (
                  <button
                    key={value}
                    className={labelFilter === value ? "active" : ""}
                    aria-pressed={labelFilter === value}
                    // Selecting across a filter you then change would act on rows you
                    // can no longer see, so the selection goes with the view.
                    onClick={() => { setLabelFilter(value); setSelectedCardIds(new Set()); }}
                  >{label} <b>{labelCounts[value]}</b></button>
                ))}
              </div>
            </div>
            <div className="library-manager">
              <div><strong>{examFilter === ALL_EXAMS ? `${cards.length} question${cards.length === 1 ? "" : "s"} in your library` : `${examCards.length} ${examFilter} question${examCards.length === 1 ? "" : "s"} (${cards.length} total)`}</strong><span>{selectedCardIds.size
                ? `${selectedCardIds.size} selected`
                : activeGroup
                  ? `${filteredCards.length} shown in ${activeGroup}`
                  : `${filteredCards.length} shown`}</span></div>
              <div className="library-bulk-actions">
                <button className="secondary compact" disabled={busy || filteredCards.length === 0} onClick={toggleFilteredSelection}>{allFilteredSelected ? "Clear shown" : `Select shown (${filteredCards.length})`}</button>
                <button className="primary compact" disabled={busy || selectedCards.length === 0} onClick={() => void handleAddSelectedToPool()}>Add to Mastery pool</button>
                <GroupPicker names={groupNames} selectionSize={selectedCards.length} onPick={addSelectedToGroup} />
                <button className="danger-button" disabled={busy || selectedCards.filter(canDeleteCard).length === 0} onClick={() => void handleRemove(selectedCards, "selected")}>Delete selected</button>
                <MoreMenu className="danger-menu" title="Actions that cannot be undone" label="⋯">
                  {activeGroup && <>
                    <button className="secondary compact" disabled={busy || selectedCards.length === 0} onClick={() => removeSelectedFromGroup(activeGroup)}>Remove selected from {activeGroup}</button>
                    <button className="secondary compact" disabled={busy} onClick={() => handleRenameGroup(activeGroup)}>Rename {activeGroup}</button>
                    <button className="danger-button" disabled={busy} onClick={() => handleDeleteGroup(activeGroup)}>Remove the group {activeGroup}</button>
                  </>}
                  <button className="danger-button" disabled={busy || examCards.length === 0} onClick={() => void handleReset()}>{examFilter === ALL_EXAMS ? "Reset all labels" : `Reset ${examFilter} labels`}</button>
                  <button className="danger-button danger-solid" disabled={busy || examCards.filter(canDeleteCard).length === 0} onClick={() => void handleRemove(examCards, "all")}>{examFilter === ALL_EXAMS ? "Delete all questions" : `Delete all ${examFilter} questions`}</button>
                </MoreMenu>
              </div>
            </div>
            <div className="card-list">
              {filteredCards.map((card) => {
                const content = splitCardFront(card.front);
                const selected = selectedCardIds.has(card.id);
                const memberOf = groupsByCardId.get(card.id) ?? [];
                return <article className={selected ? "selected" : ""} key={card.id}>
                  <label className="card-checkbox"><input type="checkbox" checked={selected} onChange={() => toggleSelection(card.id)} aria-label={`Select question: ${content.prompt}`} /></label>
                  <div className="library-card-content">
                    <div className="library-card-meta"><span className="tag">{card.tags.join(" · ") || "Uncategorized"}</span>
                      {/* Clickable, because seeing a group on one question is exactly
                          when you want the rest of what is in it. */}
                      {memberOf.map((name) => (
                        <button
                          key={name}
                          className="group-chip"
                          title={`Show everything in ${name}`}
                          onClick={() => { setGroupFilter(`${GROUP_PREFIX}${name}`); setSelectedCardIds(new Set()); }}
                        >{name}</button>
                      ))}
                      <div className="library-card-actions"><span className={`mastery-label label-${ratingTone(card.masteryRating)}`}>{ratingLabel(card.masteryRating)}</span><button className="danger-link" disabled={busy || !canDeleteCard(card)} title={canDeleteCard(card) ? undefined : "Only the person who contributed this question, or a library owner, can delete it."} onClick={() => void handleRemove([card], "single")}>Delete</button></div></div>
                    <CapturedText text={content.prompt} as="h3" /><p><strong>Answer:</strong> {card.back}</p>{card.notes && <p><strong>Notes:</strong> {card.notes}</p>}
                  </div>
                </article>;
              })}
              {!filteredCards.length && <div className="empty-inline">{!cards.length
                ? "No questions in your library yet."
                : query.trim()
                  ? "No questions match this search."
                  : activeGroup
                    ? `Nothing in ${activeGroup} for this exam and label.`
                    : groupFilter === UNGROUPED
                      ? "Every question here is in a group."
                      : labelFilter === "all"
                        ? "No questions match this search."
                        : `Nothing is labelled ${LABEL_FILTERS.find(({ value }) => value === labelFilter)?.label} here yet.`}</div>}
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
