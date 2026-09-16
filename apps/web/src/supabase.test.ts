import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreSession, SIGN_IN_LINK_ERROR } from "./auth-session";

const user = { id: "11111111-1111-4111-8111-111111111111", email: "member@example.com", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-16T00:00:00Z" };
let browserIndex = 0;

function browser(href: string) {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    location: new URL(href),
    history: { state: null, replaceState: vi.fn() },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", { visibilityState: "hidden", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("BroadcastChannel", undefined);
  const project = `crambot-test-${++browserIndex}`;
  vi.stubEnv("VITE_SUPABASE_URL", `https://${project}.supabase.co`);
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-public-key");
  const fetch = vi.fn(async () => new Response(JSON.stringify(user), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return { storage, fetch, storageKey: `sb-${project}-auth-token` };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("email link sessions", () => {
  it("signs in from a verified email link in a browser without a PKCE verifier", async () => {
    const { storage, fetch } = browser("https://crambot.test/#access_token=test-access&refresh_token=test-refresh&expires_in=3600&token_type=bearer&type=magiclink");
    const { supabase } = await import("./supabase");
    const initialized = await supabase!.auth.initialize();
    expect(initialized.error).toBeNull();
    const { data, error } = await supabase!.auth.getSession();
    expect(error).toBeNull();
    expect(data.session?.user.email).toBe(user.email);
    expect(fetch).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe("");
    expect([...storage.values()].some((value) => value.includes("test-refresh"))).toBe(true);
    expect((await restoreSession(supabase!)).session?.user.email).toBe(user.email);
  });

  it.each(["magiclink", "signup"])("restores a %s link before deciding the user is signed out", async (type) => {
    browser(`https://crambot.test/#access_token=test-access&refresh_token=test-refresh&expires_in=3600&token_type=bearer&type=${type}`);
    const { supabase } = await import("./supabase");
    expect((await restoreSession(supabase!)).session?.user.id).toBe(user.id);
  });

  it("requests links without a browser-bound code challenge", async () => {
    const { fetch } = browser("https://crambot.test/");
    const { supabase } = await import("./supabase");
    await supabase!.auth.signInWithOtp({ email: user.email, options: { emailRedirectTo: "https://crambot.test/" } });
    const body = JSON.parse((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(body.email).toBe(user.email);
    expect(body.code_challenge).toBeNull();
  });

  it("shows a reason for an expired or already-used link", async () => {
    const { fetch } = browser("https://crambot.test/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    const { supabase } = await import("./supabase");
    expect(await restoreSession(supabase!)).toEqual({ session: null, error: SIGN_IN_LINK_ERROR });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not discard an existing session when an old link is reused", async () => {
    const { storage, storageKey } = browser("https://crambot.test/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    storage.set(storageKey, JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh", expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user }));
    const { supabase } = await import("./supabase");
    expect((await restoreSession(supabase!)).session?.user.id).toBe(user.id);
  });

  it("explains that a legacy PKCE link needs to be replaced", async () => {
    browser("https://crambot.test/?code=old-code");
    const { supabase } = await import("./supabase");
    expect(await restoreSession(supabase!)).toEqual({ session: null, error: SIGN_IN_LINK_ERROR });
  });

  it("does not sign in from a malformed callback", async () => {
    browser("https://crambot.test/#access_token=test-access&refresh_token=test-refresh");
    const { supabase } = await import("./supabase");
    expect(await restoreSession(supabase!)).toEqual({ session: null, error: SIGN_IN_LINK_ERROR });
  });

  it("keeps an ordinary signed-out visit distinct from a failed link", async () => {
    browser("https://crambot.test/");
    const { supabase } = await import("./supabase");
    expect(await restoreSession(supabase!)).toEqual({ session: null });
  });
});
