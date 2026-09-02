import { useCallback, useEffect, useRef, useState } from "react";
import { cloudEnabled } from "./supabase";
import { describeSyncError, pendingCount, syncNow, type SyncResult } from "./sync";

const INTERVAL_MS = 60_000;
/** Rating a run of cards should produce one upload, not one per card. */
const DEBOUNCE_MS = 2_000;

export type SyncPhase = "disabled" | "idle" | "syncing" | "offline" | "error";

export interface CloudSync {
  phase: SyncPhase;
  pending: number;
  lastSyncedAt: string | null;
  error: string | null;
  /** Ask for a sync soon. Safe to call after every local write. */
  request: () => void;
}

/**
 * Keeps this device in step with the shared library: on sign-in, when the tab comes
 * back to the foreground, when the network returns, once a minute, and shortly after
 * local edits. Everything keeps working offline; changes queue locally and drain on
 * reconnect.
 */
export function useCloudSync(userId: string | null, onRemoteChange: (result: SyncResult) => void): CloudSync {
  const [phase, setPhase] = useState<SyncPhase>(cloudEnabled ? "idle" : "disabled");
  const [pending, setPending] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remoteChange = useRef(onRemoteChange);
  remoteChange.current = onRemoteChange;

  const runRef = useRef<() => void>(() => undefined);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!cloudEnabled || !userId) {
      runRef.current = () => undefined;
      return;
    }
    let active = true;

    async function run() {
      if (!userId) return;
      if (!navigator.onLine) {
        if (!active) return;
        setPhase("offline");
        setPending(await pendingCount());
        return;
      }
      if (active) setPhase("syncing");
      // The queue drains page by page, so polling it turns a long first upload
      // into visible progress instead of an indefinite "Syncing…".
      const progress = window.setInterval(() => {
        void pendingCount().then((count) => {
          if (active) setPending(count);
        });
      }, 1_500);
      try {
        const result = await syncNow(userId);
        if (!active) return;
        setError(null);
        setPhase("idle");
        setLastSyncedAt(new Date().toISOString());
        setPending(await pendingCount());
        if (result.pulled > 0 || result.deleted > 0 || result.stateAdopted) remoteChange.current(result);
      } catch (problem) {
        if (!active) return;
        setError(describeSyncError(problem));
        setPhase(navigator.onLine ? "error" : "offline");
        setPending(await pendingCount());
      } finally {
        window.clearInterval(progress);
      }
    }

    runRef.current = () => void run();
    void run();

    const timer = window.setInterval(() => void run(), INTERVAL_MS);
    const wake = () => {
      if (document.visibilityState === "visible") void run();
    };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);

    return () => {
      active = false;
      runRef.current = () => undefined;
      window.clearInterval(timer);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [userId]);

  useEffect(() => () => window.clearTimeout(debounce.current), []);

  const request = useCallback(() => {
    if (!cloudEnabled) return;
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => runRef.current(), DEBOUNCE_MS);
  }, []);

  return { phase, pending, lastSyncedAt, error, request };
}
