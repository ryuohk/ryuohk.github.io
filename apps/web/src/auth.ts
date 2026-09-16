import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { clearStudyStateMarkers } from "./study-state";
import { cloudEnabled, supabase } from "./supabase";
import { restoreSession, SIGN_IN_LINK_ERROR } from "./auth-session";

export type AuthStatus =
  /** Built without backend credentials: everything stays on this device. */
  | "local-only"
  /** Still restoring a stored session. */
  | "loading"
  /** Nobody is signed in. */
  | "signed-out"
  /** The email callback failed; show a reason and allow a fresh link. */
  | "sign-in-error"
  /** Signed in, but the address is not on the invite list. */
  | "unauthorized"
  /** Signed in, but the membership lookup itself failed. Not the same as uninvited. */
  | "error"
  /** Signed in and invited. */
  | "ready";

export interface AuthState {
  status: AuthStatus;
  /** Why sign-in or the membership lookup failed. */
  error?: string;
  session: Session | null;
  email: string | null;
  userId: string | null;
  /** Library owners may delete anything; members only their own contributions. */
  isOwner: boolean;
}

const SIGNED_OUT: AuthState = { status: "signed-out", session: null, email: null, userId: null, isOwner: false };

/** Distinguishes a schema or permission fault from simply not being invited. */
function describeMembershipError(error: unknown): string {
  const detail = error as { code?: unknown; message?: unknown };
  const code = typeof detail?.code === "string" ? detail.code : "";
  const message = typeof detail?.message === "string" ? detail.message : "Unknown error";
  if (code === "42703") {
    return "The library database is missing a column this version of CramBot expects. It needs its pending migration applied.";
  }
  return message;
}

async function resolveMembership(session: Session | null): Promise<AuthState> {
  if (!session || !supabase) return SIGNED_OUT;
  const email = session.user.email ?? null;
  const base = { session, email, userId: session.user.id, isOwner: false };

  // The membership row is created by a database trigger for invited addresses only.
  // Row level security means an uninvited account simply reads nothing back.
  //
  // `select("*")` rather than naming columns on purpose: naming a column the schema
  // has not caught up with yet fails the whole query, and an absent membership row
  // and a failed lookup are indistinguishable from the result alone. That once
  // reported a missing column as "not on the invite list", which sent the reader
  // hunting through their invite list for a problem that was never there.
  const { data, error } = await supabase
    .from("library_members")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) {
    // A network failure should not lock out an already-signed-in user offline.
    if (!navigator.onLine) return { ...base, status: "ready" };
    return { ...base, status: "error", error: describeMembershipError(error) };
  }
  // `role` may be absent on a database that predates ownership; treat that as a
  // member rather than failing, since the policies are the real authority anyway.
  const role = (data as { role?: unknown } | null)?.role;
  return { ...base, status: data ? "ready" : "unauthorized", isOwner: role === "owner" };
}

export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>(() =>
    cloudEnabled ? { ...SIGNED_OUT, status: "loading" } : { ...SIGNED_OUT, status: "local-only" },
  );

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let active = true;
    let restored = false;
    let revision = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();

    async function updateSession(session: Session | null) {
      const current = ++revision;
      try {
        const next = await resolveMembership(session);
        if (active && current === revision) setState(next);
      } catch (error) {
        if (active && current === revision) {
          setState({
            ...SIGNED_OUT, session, email: session?.user.email ?? null, userId: session?.user.id ?? null,
            status: session ? "error" : "sign-in-error",
            error: session ? describeMembershipError(error) : SIGN_IN_LINK_ERROR,
          });
        }
      }
    }

    const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
      // restoreSession owns the initial state, including callback errors. The SDK's
      // initial null session must not overwrite a failed-link explanation.
      if (event === "INITIAL_SESSION") return;
      // Supabase invokes listeners while holding its auth lock. Membership queries
      // use that same client, so start them only after the listener has returned.
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (active && restored) void updateSession(session);
      }, 0);
      timers.add(timer);
    });

    void restoreSession(client).then(async ({ session, error }) => {
      if (!active) return;
      restored = true;
      if (error) setState({ ...SIGNED_OUT, status: "sign-in-error", error });
      else await updateSession(session);
    }).catch(() => {
      if (active) {
        setState({ ...SIGNED_OUT, status: "sign-in-error", error: SIGN_IN_LINK_ERROR });
        restored = true;
      }
    });

    return () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
      subscription.subscription.unsubscribe();
    };
  }, []);

  return state;
}

/** Where the emailed link should land. Must be listed in the Supabase redirect allowlist. */
export function redirectTarget(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

export async function sendSignInLink(email: string): Promise<void> {
  if (!supabase) throw new Error("Cloud sync is not configured for this build.");
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { emailRedirectTo: redirectTarget() },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (!supabase) return;
  // Otherwise the next person to sign in on this browser inherits these markers and
  // their first sync mistakes the previous person's set for their own local changes.
  clearStudyStateMarkers();
  await supabase.auth.signOut();
}
