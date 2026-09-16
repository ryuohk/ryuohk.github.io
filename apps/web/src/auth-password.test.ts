import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signIn: vi.fn(), update: vi.fn() }));
vi.mock("./supabase", () => ({ cloudEnabled: true, supabase: { auth: { signInWithPassword: auth.signIn, updateUser: auth.update } } }));
import { signInWithPassword, changePassword } from "./auth";

beforeEach(() => {
  vi.clearAllMocks();
  auth.signIn.mockResolvedValue({ data: { session: { user: { id: "member" } } }, error: null });
  auth.update.mockResolvedValue({ data: { user: { id: "member" } }, error: null });
});

describe("password authentication", () => {
  it("normalizes email but preserves the exact password", async () => {
    await signInWithPassword(" Member@Example.com ", " exact password ");
    expect(auth.signIn).toHaveBeenCalledWith({ email: "member@example.com", password: " exact password " });
  });
  it.each([["", "password"], ["member@example.com", ""]])("rejects empty credentials", async (email, password) => {
    await expect(signInWithPassword(email, password)).rejects.toThrow("Enter your email and password");
    expect(auth.signIn).not.toHaveBeenCalled();
  });
  it("does not reveal whether an account exists on invalid credentials", async () => {
    auth.signIn.mockResolvedValue({ data: { session: null }, error: { code: "invalid_credentials" } });
    await expect(signInWithPassword("member@example.com", "wrong")).rejects.toThrow("email or password is incorrect");
  });
  it("directs unconfirmed accounts to the owner rather than sending an email link", async () => {
    auth.signIn.mockResolvedValue({ data: { session: null }, error: { code: "email_not_confirmed" } });
    await expect(signInWithPassword("member@example.com", "password")).rejects.toThrow("library owner to confirm");
  });
  it("does not silently accept a missing session", async () => {
    auth.signIn.mockResolvedValue({ data: { session: null }, error: null });
    await expect(signInWithPassword("member@example.com", "password")).rejects.toThrow("Sign-in did not complete");
  });
  it("changes the password through the authenticated client", async () => {
    await changePassword("temporary password", "my new password 123");
    expect(auth.update).toHaveBeenCalledWith({ current_password: "temporary password", password: "my new password 123" });
  });
  it.each([["", "long enough password"], ["old", "short"], ["same long password", "same long password"]])("rejects invalid password changes before contacting auth", async (current, password) => {
    await expect(changePassword(current, password)).rejects.toThrow();
    expect(auth.update).not.toHaveBeenCalled();
  });
  it("reports rejected password changes", async () => {
    auth.update.mockResolvedValue({ data: { user: null }, error: new Error("Current password is incorrect") });
    await expect(changePassword("wrong", "new secure password")).rejects.toThrow("Current password is incorrect");
  });
  it("does not silently accept a missing updated user", async () => {
    auth.update.mockResolvedValue({ data: { user: null }, error: null });
    await expect(changePassword("temporary", "new secure password")).rejects.toThrow("did not complete");
  });
});
