/**
 * The in-progress mastery set and study settings, and the bookkeeping that lets
 * them follow one person between their own devices.
 *
 * These live in localStorage because that is where the app already keeps them.
 * Sync only has to answer two questions: has this device changed anything since
 * the last successful sync, and is the server holding something newer.
 */

export const SESSION_KEY = "crambot-active-mastery-session";
export const SETTINGS_KEY = "crambot-mastery-settings";
/** Plain string, not JSON: an exam code, or "all". */
export const EXAM_FILTER_KEY = "crambot-exam-filter";

const SNAPSHOT_KEY = "crambot-study-state-snapshot";
const SERVER_AT_KEY = "crambot-study-state-server-at";
const EPOCH = "1970-01-01T00:00:00.000Z";

export interface StudyStatePayload {
  session: unknown;
  settings: unknown;
  examFilter: string | null;
}

/**
 * Key-sorted JSON. Postgres `jsonb` does not preserve key order, so a value that
 * makes a round trip comes back reordered. Comparing raw JSON.stringify output
 * would then read as "changed" on every pull, and two devices would push each
 * other's state back and forth forever.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function readLocalStudyState(): StudyStatePayload {
  let examFilter: string | null = null;
  try {
    examFilter = localStorage.getItem(EXAM_FILTER_KEY);
  } catch {
    examFilter = null;
  }
  return { session: readJson(SESSION_KEY), settings: readJson(SETTINGS_KEY), examFilter };
}

export function writeLocalStudyState(payload: StudyStatePayload): void {
  try {
    if (payload.session) localStorage.setItem(SESSION_KEY, JSON.stringify(payload.session));
    else localStorage.removeItem(SESSION_KEY);
    if (payload.settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload.settings));
    if (payload.examFilter) localStorage.setItem(EXAM_FILTER_KEY, payload.examFilter);
    else localStorage.removeItem(EXAM_FILTER_KEY);
  } catch {
    // A blocked or full storage only costs us the carry-over, never the session itself.
  }
}

function readMarker(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** True when this device has study state the server has not seen. */
export function studyStateChanged(): boolean {
  return stableStringify(readLocalStudyState()) !== readMarker(SNAPSHOT_KEY, "");
}

export function lastServerStudyStateAt(): string {
  return readMarker(SERVER_AT_KEY, EPOCH);
}

/** Records what the server now holds, so the next sync can tell changed from unchanged. */
export function markStudyStateSynced(payload: StudyStatePayload, serverAt: string): void {
  try {
    localStorage.setItem(SNAPSHOT_KEY, stableStringify(payload));
    localStorage.setItem(SERVER_AT_KEY, serverAt);
  } catch {
    // Without the marker the next sync simply re-pushes, which is harmless.
  }
}

/** Signing out on a shared machine must not leave one person's set for the next. */
export function clearStudyStateMarkers(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
    localStorage.removeItem(SERVER_AT_KEY);
  } catch {
    // Nothing to do; the markers are only an optimisation.
  }
}
