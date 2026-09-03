import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { clearStudyStateMarkers } from "./study-state";
import { cloudEnabled, supabase } from "./supabase";

export type AuthStatus =
  /** Built without backend credentials: everything stays on this device. */
  | "local-only"
  /** Still restoring a stored session. */
  | "loading"
  /** Nobody is signed in. */
  | "signed-out"
  /** Signed in, but the address is not on the invite list. */
  | "unauthorized"
  /** Signed in and invited. */
  | "ready";

export interface AuthState {
  status: AuthStatus;
  session: Session | null;
  email: string | null;
  userId: string | null;
  /** Library owners may delete anything; members only their own contributions. */
  isOwner: boolean;
}

const SIGNED_OUT: AuthState = { status: "signed-out", session: null, email: null, userId: null, isOwner: false };

async function resolveMembership(session: Session | null): Promise<AuthState> {
  if (!session || !supabase) return SIGNED_OUT;
  const email = session.user.email ?? null;
  const base = { session, email, userId: session.user.id, isOwner: false };

  // The membership row is created by a database trigger for invited addresses only.
  // Row level security means an uninvited account simply reads nothing back.
  const { data, error } = await supabase
    .from("library_members")
    .select("user_id,role")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error) {
    // A network failure should not lock out an already-signed-in user offline.
    if (!navigator.onLine) return { ...base, status: "ready" };
    return { ...base, status: "unauthorized" };
  }
  return { ...base, status: data ? "ready" : "unauthorized", isOwner: data?.role === "owner" };
}

export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>(() =>
    cloudEnabled ? { ...SIGNED_OUT, status: "loading" } : { ...SIGNED_OUT, status: "local-only" },
  );

  useEffect(() => {
    if (!supabase) return;
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      void resolveMembership(data.session).then((next) => {
        if (active) setState(next);
      });
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      void resolveMembership(session).then((next) => {
        if (active) setState(next);
      });
    });

    return () => {
      active = false;
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
