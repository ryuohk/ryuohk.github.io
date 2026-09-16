import { useState } from "react";
import { changePassword } from "./auth";

export function PasswordSettings() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function close() {
    setOpen(false); setCurrent(""); setPassword(""); setConfirmation(""); setError(""); setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (password !== confirmation) { setError("The new passwords do not match."); return; }
    setBusy(true);
    try {
      await changePassword(current, password);
      setCurrent(""); setPassword(""); setConfirmation(""); setSaved(true);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally { setBusy(false); }
  }

  return <>
    <button className="secondary" onClick={() => setOpen(true)}>Change password</button>
    {open && <div className="auth-shell password-overlay">
      <section className="auth-card" role="dialog" aria-modal="true" aria-labelledby="password-heading">
        <h1 id="password-heading">Change password</h1>
        {saved ? <p role="status">Your password has been changed.</p> : <>
          <p>Replace the temporary password from the library owner with your own password.</p>
          <form className="auth-form" onSubmit={submit}>
            <label>Current password<input type="password" autoComplete="current-password" autoFocus required disabled={busy} value={current} onChange={(event) => setCurrent(event.target.value)} /></label>
            <label>New password<input type="password" autoComplete="new-password" minLength={12} required disabled={busy} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} required disabled={busy} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
            <button disabled={busy} type="submit">{busy ? "Saving…" : "Save password"}</button>
          </form>
          {error && <p className="auth-error" role="alert">{error}</p>}
        </>}
        <button className="secondary" disabled={busy} onClick={close}>{saved ? "Done" : "Cancel"}</button>
      </section>
    </div>}
  </>;
}
