import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/**
 * The anon key is meant to be public. It only lets the browser talk to PostgREST;
 * every table is protected by row level security, so an unauthenticated or
 * uninvited holder of this key reads nothing.
 */
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      })
    : null;

/** False when the app was built without backend credentials: it then runs local-only. */
export const cloudEnabled = supabase !== null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("CramBot was built without Supabase credentials.");
  return supabase;
}
