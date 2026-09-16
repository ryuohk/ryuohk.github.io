import { useState, type ReactNode } from "react";
import { signInWithPassword, signOut, useAuthState, type AuthState } from "./auth";

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

function SignIn({ initialError = "" }: { initialError?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      await signInWithPassword(email, password);
      setPassword("");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1>Sign in</h1>
      <p>CramBot is invite-only. Sign in with the account provided by the library owner.</p>
      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            disabled={busy}
            value={email}
            placeholder="you@example.com"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" required disabled={busy}
            value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <p>Need an account or forgot your password? Contact the library owner.</p>
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
  if (auth.status === "sign-in-error") return <SignIn key="sign-in-error" initialError={auth.error} />;
  if (auth.status === "unauthorized") return <NotInvited email={auth.email} />;
  if (auth.status === "error") return <MembershipFailed detail={auth.error} email={auth.email} />;

  return <>{children(auth)}</>;
}
