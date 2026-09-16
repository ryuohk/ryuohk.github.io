import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AuthState } from "./auth";

const auth = vi.hoisted(() => ({ state: null as AuthState | null }));
vi.mock("./auth", () => ({ useAuthState: () => auth.state, sendSignInLink: vi.fn(), signOut: vi.fn() }));
import { AuthGate } from "./AuthGate";

function render(status: AuthState["status"], error?: string) {
  auth.state = { status, error, session: null, email: "member@example.com", userId: null, isOwner: false };
  return renderToStaticMarkup(createElement(AuthGate, { children: () => createElement("div", null, "FLASHCARDS") }));
}

describe("login screen", () => {
  it("opens the flashcards for an admitted session without asking for email", () => {
    const html = render("ready");
    expect(html).toContain("FLASHCARDS");
    expect(html).not.toContain("Email me a link");
  });

  it("waits for callback processing instead of showing the email form", () => {
    const html = render("loading");
    expect(html).toContain("Checking your session");
    expect(html).not.toContain("Email me a link");
    expect(html).not.toContain("FLASHCARDS");
  });

  it("explains failed links and offers a fresh one", () => {
    const html = render("sign-in-error", "Request a fresh link.");
    expect(html).toContain("Request a fresh link.");
    expect(html).toContain("Email me a link");
    expect(html).not.toContain("FLASHCARDS");
  });

  it("keeps uninvited users out of the flashcards", () => {
    const html = render("unauthorized");
    expect(html).toContain("Not on the invite list");
    expect(html).not.toContain("FLASHCARDS");
  });
});
