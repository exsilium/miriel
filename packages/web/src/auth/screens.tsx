/**
 * Login and change-password screens. Full page when the gate needs them (AUTH_REQUIRED, temporary password),
 * an overlay otherwise (`onClose` given).
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { changePassword } from "./client.js";
import { useAuth } from "./context.js";

/** Same minimum as the api (PASSWORD_MIN in packages/shared/src/users.ts). */
const PASSWORD_MIN = 10;

function Shell({ onClose, children, title }: { onClose?: (() => void) | undefined; children: ReactNode; title: string }) {
  return (
    <div className={onClose ? "auth-overlay" : "auth-page"} onClick={onClose ? (e) => e.target === e.currentTarget && onClose() : undefined}>
      <div className="auth-card" role="dialog" aria-modal={Boolean(onClose)} aria-labelledby="auth-title">
        <h2 id="auth-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function LoginScreen({ onClose }: { onClose?: () => void }) {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell onClose={onClose} title="Log in to Miriel">
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required autoCapitalize="none" spellCheck={false} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="auth-actions">
          {onClose && (
            <button type="button" onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary" disabled={busy || !username.trim() || !password}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </div>
        <p className="muted small">No account? Ask the admin of this Miriel to create one.</p>
      </form>
    </Shell>
  );
}

/** `forced`: the account has a temporary password; the only other way out is logging out. */
export function PasswordScreen({ forced = false, onClose }: { forced?: boolean; onClose?: () => void }) {
  const { user, setUser, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const problem =
    next && next.length < PASSWORD_MIN ? "At least " + PASSWORD_MIN + " characters." : again && next !== again ? "The two new passwords differ." : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await changePassword(current, next);
      if (onClose) setDone(true);
      setUser(r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (done && onClose) {
    return (
      <Shell onClose={onClose} title="Password changed">
        <p>Your other sessions have been logged out.</p>
        <div className="auth-actions">
          <button className="primary" onClick={onClose}>
            OK
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell onClose={forced ? undefined : onClose} title={forced ? "Choose your password" : "Change password"}>
      {forced && (
        <p className="muted">
          Hi {user?.username}. You logged in with a one-time password; set your own to continue.
        </p>
      )}
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <input type="text" name="username" value={user?.username ?? ""} autoComplete="username" readOnly hidden />
        <label>
          {forced ? "One-time password" : "Current password"}
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus required />
        </label>
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required minLength={PASSWORD_MIN} />
        </label>
        <label>
          New password again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
        </label>
        {(problem || error) && <p className="error-text">{problem ?? error}</p>}
        <div className="auth-actions">
          {forced ? (
            <button type="button" onClick={() => void logout()}>
              Log out
            </button>
          ) : (
            onClose && (
              <button type="button" onClick={onClose}>
                Cancel
              </button>
            )
          )}
          <button type="submit" className="primary" disabled={busy || !current || !next || next !== again || Boolean(problem)}>
            {busy ? "Saving…" : "Save password"}
          </button>
        </div>
      </form>
    </Shell>
  );
}
