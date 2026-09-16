import type { Session, SupabaseClient } from "@supabase/supabase-js";

export const SIGN_IN_LINK_ERROR = "Your session could not be restored from this link. Sign in with your email and password below instead.";

/** Wait for URL authentication before deciding whether to show the email form. */
export async function restoreSession(client: SupabaseClient): Promise<{ session: Session | null; error?: string }> {
  const initialized = await client.auth.initialize();
  const { data, error } = await client.auth.getSession();
  // A reused link must not lock out someone who already has a valid session.
  if (data.session && !error) return { session: data.session };
  if (initialized.error || error) return { session: null, error: SIGN_IN_LINK_ERROR };
  // Old PKCE links opened without their verifier are not recognized by the SDK.
  // Explain that they need a fresh link rather than silently repeating the form.
  if (new URL(window.location.href).searchParams.has("code")) {
    return { session: null, error: SIGN_IN_LINK_ERROR };
  }
  return { session: null };
}
