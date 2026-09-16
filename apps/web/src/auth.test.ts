import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import type { AuthState } from "./auth";

const harness = vi.hoisted(() => ({
  state: null as AuthState | null,
  effect: null as (() => (() => void) | void) | null,
  listener: null as ((event: AuthChangeEvent, session: Session | null) => void) | null,
  restore: vi.fn(), lookup: vi.fn(), unsubscribe: vi.fn(),
}));

vi.mock("react", () => ({
  useState: (initial: () => AuthState) => {
    harness.state = initial();
    return [harness.state, (next: AuthState) => { harness.state = next; }];
  },
  useEffect: (effect: () => (() => void) | void) => { harness.effect = effect; },
}));
vi.mock("./auth-session", () => ({ restoreSession: harness.restore, SIGN_IN_LINK_ERROR: "Request a fresh link." }));
vi.mock("./supabase", () => ({
  cloudEnabled: true,
  supabase: {
    auth: { onAuthStateChange: (listener: typeof harness.listener) => {
      harness.listener = listener;
      return { data: { subscription: { unsubscribe: harness.unsubscribe } } };
    } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: harness.lookup }) }) }),
  },
}));

import { useAuthState } from "./auth";

const session = { user: { id: "member-id", email: "member@example.com" } } as Session;
let cleanup: (() => void) | void;

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await vi.runAllTimersAsync();
}

function mount() {
  useAuthState();
  cleanup = harness.effect!();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  harness.restore.mockResolvedValue({ session });
  harness.lookup.mockResolvedValue({ data: { role: "member" }, error: null });
});
afterEach(() => { cleanup?.(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("email login gate", () => {
  it("opens the library after restoring a session and checking membership", async () => {
    mount();
    expect(harness.state?.status).toBe("loading");
    await settle();
    expect(harness.state?.status).toBe("ready");
    expect(harness.state?.email).toBe(session.user.email);
  });

  it("does not erase a failed-link explanation with INITIAL_SESSION", async () => {
    harness.restore.mockResolvedValue({ session: null, error: "Request a fresh link." });
    mount();
    harness.listener!("INITIAL_SESSION", null);
    await settle();
    harness.listener!("INITIAL_SESSION", null);
    await settle();
    expect(harness.state?.status).toBe("sign-in-error");
    expect(harness.state?.error).toBe("Request a fresh link.");
  });

  it("keeps an authenticated but uninvited account out of the library", async () => {
    harness.lookup.mockResolvedValue({ data: null, error: null });
    mount();
    await settle();
    expect(harness.state?.status).toBe("unauthorized");
  });

  it("starts membership queries outside the authentication listener", async () => {
    mount();
    await settle();
    harness.lookup.mockClear();
    harness.listener!("SIGNED_IN", session);
    expect(harness.lookup).not.toHaveBeenCalled();
    await settle();
    expect(harness.lookup).toHaveBeenCalledOnce();
  });

  it("does not let a slow membership lookup undo sign-out", async () => {
    let finish!: (result: { data: { role: string }; error: null }) => void;
    harness.lookup.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await settle();
    harness.listener!("SIGNED_OUT", null);
    await settle();
    expect(harness.state?.status).toBe("signed-out");
    finish({ data: { role: "member" }, error: null });
    await settle();
    expect(harness.state?.status).toBe("signed-out");
  });

  it("shows a retry option when session initialization throws", async () => {
    harness.restore.mockRejectedValue(new Error("network failure"));
    mount();
    await settle();
    expect(harness.state?.status).toBe("sign-in-error");
  });

  it("does not update an unmounted gate", async () => {
    mount();
    cleanup?.();
    await settle();
    expect(harness.state?.status).toBe("loading");
    expect(harness.unsubscribe).toHaveBeenCalled();
  });
});
