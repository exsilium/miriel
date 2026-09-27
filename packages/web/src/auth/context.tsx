/**
 * The logged-in user (GET /api/auth/me) and the gate in front of the app: with AUTH_REQUIRED nothing but the login
 * screen shows until someone logs in, and a temporary password must be changed before anything else. Without
 * AUTH_REQUIRED the reader stays open and "Log in" opens the same screen as an overlay.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { UNAUTHORIZED_EVENT } from "../api.js";
import { fetchMe, login as apiLogin, logout as apiLogout, type Me, type User } from "./client.js";
import { LoginScreen, PasswordScreen } from "./screens.js";

interface AuthState {
  user: User | null;
  authRequired: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
  /** Open the login overlay (when login is optional) or the change-password dialog. */
  showLogin: () => void;
  showPassword: () => void;
}

const Ctx = createContext<AuthState>({
  user: null,
  authRequired: false,
  login: async () => undefined,
  logout: async () => undefined,
  setUser: () => undefined,
  showLogin: () => undefined,
  showPassword: () => undefined,
});

export function useAuth(): AuthState {
  return useContext(Ctx);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<"login" | "password" | null>(null);

  const refresh = useCallback(() => {
    fetchMe()
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh, attempt]);
  useEffect(() => {
    window.addEventListener(UNAUTHORIZED_EVENT, refresh);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, refresh);
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await apiLogin(username, password);
    setMe((m) => ({ authRequired: m?.authRequired ?? false, user }));
    setDialog(null);
  }, []);
  const logout = useCallback(async () => {
    await apiLogout().catch(() => undefined);
    setMe((m) => ({ authRequired: m?.authRequired ?? false, user: null }));
    setDialog(null);
  }, []);
  const setUser = useCallback((user: User) => setMe((m) => ({ authRequired: m?.authRequired ?? false, user })), []);

  const value = useMemo<AuthState>(
    () => ({
      user: me?.user ?? null,
      authRequired: me?.authRequired ?? false,
      login,
      logout,
      setUser,
      showLogin: () => setDialog("login"),
      showPassword: () => setDialog("password"),
    }),
    [me, login, logout, setUser],
  );

  if (!me) {
    return error ? (
      <div className="centered">
        <div>
          <p>Could not reach the Miriel API.</p>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <button onClick={() => setAttempt((n) => n + 1)}>Retry</button>
        </div>
      </div>
    ) : (
      <div className="centered">Loading…</div>
    );
  }
  const user = me.user;
  let gate: ReactNode = null;
  if (me.authRequired && !user) gate = <LoginScreen />;
  else if (user?.mustChangePassword) gate = <PasswordScreen forced />;

  return (
    <Ctx.Provider value={value}>
      {gate ?? (
        <>
          {children}
          {dialog === "login" && !user && <LoginScreen onClose={() => setDialog(null)} />}
          {dialog === "password" && user && <PasswordScreen onClose={() => setDialog(null)} />}
        </>
      )}
    </Ctx.Provider>
  );
}
