import { useState, type ReactNode } from "react";
import { sendSignInLink, signOut, useAuthState, type AuthState } from "./auth";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">CB</span>
          <span>CramBot</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setState("sending");
    setError("");
    try {
      await sendSignInLink(email);
      setState("sent");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <Shell>
        <h1>Check your email</h1>
        <p>
          If <strong>{email.trim().toLowerCase()}</strong> is on the invite list, a sign-in link is on its way. Open it
          on this device. The link expires shortly.
        </p>
        <button className="secondary" onClick={() => setState("idle")}>
          Use a different address
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1>Sign in</h1>
      <p>CramBot is invite-only. Enter your address and we will email you a one-time sign-in link. No password needed.</p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            placeholder="you@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <button type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Email me a link"}
        </button>
      </form>
      {error && <p className="auth-error">{error}</p>}
    </Shell>
  );
}

function NotInvited({ email }: { email: string | null }) {
  return (
    <Shell>
      <h1>Not on the invite list</h1>
      <p>
        {email ? <strong>{email}</strong> : "This account"} is signed in but has no access to this library. Ask the
        owner to add the address, then sign in again.
      </p>
      <button className="secondary" onClick={() => void signOut()}>
        Sign out
      </button>
    </Shell>
  );
}

/**
 * Deliberately distinct from "not invited". Reporting a failed lookup as a missing
 * invitation sends people to check a list that was never the problem.
 */
function MembershipFailed({ detail, email }: { detail?: string; email: string | null }) {
  return (
    <Shell>
      <h1>Could not check your access</h1>
      <p>
        {email ? <strong>{email}</strong> : "You"} signed in successfully, but CramBot could not confirm your library
        membership. This is a fault on the library side, not a problem with your invitation.
      </p>
      {detail && <p className="auth-error">{detail}</p>}
      <button className="secondary" onClick={() => window.location.reload()}>
        Try again
      </button>
    </Shell>
  );
}

export function AuthGate({ children }: { children: (auth: AuthState) => ReactNode }) {
  const auth = useAuthState();

  if (auth.status === "loading") {
    return (
      <Shell>
        <p className="auth-loading">Checking your session…</p>
      </Shell>
    );
  }
  if (auth.status === "signed-out") return <SignIn />;
  if (auth.status === "unauthorized") return <NotInvited email={auth.email} />;
  if (auth.status === "error") return <MembershipFailed detail={auth.error} email={auth.email} />;

  return <>{children(auth)}</>;
}
