// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signIn: vi.fn(), change: vi.fn() }));
vi.mock("./auth", () => ({ useAuthState: () => ({ status: "signed-out" }), signInWithPassword: auth.signIn, changePassword: auth.change, signOut: vi.fn() }));
import { AuthGate } from "./AuthGate";
import { PasswordSettings } from "./PasswordSettings";

let root: Root;
let container: HTMLDivElement;
function enter(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  auth.signIn.mockResolvedValue(undefined); auth.change.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe("password screens", () => {
  it("signs in without an email link or signup option", async () => {
    await act(async () => { root.render(<AuthGate>{() => <div>FLASHCARDS</div>}</AuthGate>); });
    await act(async () => { enter(container.querySelector('input[type="email"]')!, "member@example.com"); enter(container.querySelector('input[type="password"]')!, "temporary password"); });
    await submit();
    expect(auth.signIn).toHaveBeenCalledWith("member@example.com", "temporary password");
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(container.textContent).not.toContain("Email me");
    expect(container.textContent).not.toContain("Create account");
  });
  it("shows login errors and allows retry", async () => {
    auth.signIn.mockRejectedValue(new Error("Incorrect password"));
    await act(async () => { root.render(<AuthGate>{() => <div />}</AuthGate>); });
    await act(async () => { enter(container.querySelector('input[type="email"]')!, "member@example.com"); enter(container.querySelector('input[type="password"]')!, "wrong"); });
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Incorrect password");
    expect(container.querySelector("button")!.disabled).toBe(false);
  });
  it("rejects mismatched new passwords without updating the account", async () => {
    await act(async () => { root.render(<PasswordSettings />); });
    await act(async () => { container.querySelector("button")!.click(); });
    await act(async () => { const inputs = container.querySelectorAll("input"); enter(inputs[0], "temporary"); enter(inputs[1], "new secure password"); enter(inputs[2], "different password"); });
    await submit();
    expect(auth.change).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("do not match");
  });
  it("changes the password and clears password fields", async () => {
    await act(async () => { root.render(<PasswordSettings />); });
    await act(async () => { container.querySelector("button")!.click(); });
    await act(async () => { const inputs = container.querySelectorAll("input"); enter(inputs[0], "temporary"); enter(inputs[1], "new secure password"); enter(inputs[2], "new secure password"); });
    await submit();
    expect(auth.change).toHaveBeenCalledWith("temporary", "new secure password");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("has been changed");
    expect(container.querySelectorAll("input")).toHaveLength(0);
  });
});
