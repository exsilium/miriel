/**
 * /admin/users: create accounts, hand out one-time passwords, reset, disable, promote and delete
 * (docs/build-spec-checklist.md §3 decision 10). The api enforces the rules (admins only, not oneself, never the
 * last active admin); the buttons only mirror them.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createUser, deleteUser, listUsers, updateUser, type AdminUser, type Role } from "./client.js";
import { useAuth } from "./context.js";

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "never");

export function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ username: string; password: string; created: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("user");
  const [copied, setCopied] = useState(false);

  const reload = useCallback(() => {
    listUsers()
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(reload, [reload]);

  if (me?.role !== "admin") {
    return (
      <div className="admin">
        <h2>Users</h2>
        <p className="muted">This page is for admins.</p>
      </div>
    );
  }

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void run("create", async () => {
      const r = await createUser(name.trim(), role);
      setSecret({ username: r.user.username, password: r.password, created: true });
      setCopied(false);
      setName("");
      setRole("user");
    });
  };

  const activeAdmins = (users ?? []).filter((u) => u.role === "admin" && !u.disabled).length;

  return (
    <div className="admin">
      <h2>Users</h2>

      <form className="card admin-create" onSubmit={create}>
        <label>
          New username
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="3-32 letters, digits, . _ -" autoCapitalize="none" spellCheck={false} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button type="submit" className="primary" disabled={!name.trim() || busy === "create"}>
          Create
        </button>
      </form>

      {secret && (
        <div className="card secret" role="status">
          <p>
            {secret.created ? "Created " : "New password for "}
            <strong>{secret.username}</strong>. One-time password, shown only now:
          </p>
          <p className="secret-value">
            <code>{secret.password}</code>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(secret.password).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </p>
          <p className="muted small">They log in with it and choose their own password straight away.</p>
          <button onClick={() => setSecret(null)}>Done</button>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}

      {!users ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th title="Characters / playthroughs">Runs</th>
                <th title="Checklist items ticked, all runs">Done</th>
                <th title="Active sessions">Sessions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === me.id;
                const lastAdmin = u.role === "admin" && !u.disabled && activeAdmins <= 1;
                const locked = self || lastAdmin;
                const why = self ? "Not on your own account" : lastAdmin ? "The last active admin" : undefined;
                const b = busy?.startsWith(u.id) ?? false;
                return (
                  <tr key={u.id} className={u.disabled ? "disabled" : undefined}>
                    <td>
                      {u.username}
                      {self && <span className="muted"> (you)</span>}
                    </td>
                    <td>{u.role}</td>
                    <td>{u.disabled ? "disabled" : u.mustChangePassword ? "one-time password" : "active"}</td>
                    <td>{when(u.lastLoginAt)}</td>
                    <td>{u.runs}</td>
                    <td>{u.done}</td>
                    <td>{u.sessions}</td>
                    <td className="row-actions">
                      <button
                        disabled={b}
                        onClick={() =>
                          void run(u.id + ":reset", async () => {
                            const r = await updateUser(u.id, { resetPassword: true });
                            if (r.password) setSecret({ username: u.username, password: r.password, created: false });
                            setCopied(false);
                          })
                        }
                      >
                        Reset password
                      </button>
                      <button
                        disabled={b || (u.role === "admin" ? locked : false)}
                        title={u.role === "admin" ? why : undefined}
                        onClick={() => void run(u.id + ":role", async () => void (await updateUser(u.id, { role: u.role === "admin" ? "user" : "admin" })))}
                      >
                        {u.role === "admin" ? "Make user" : "Make admin"}
                      </button>
                      <button
                        disabled={b || (!u.disabled && locked)}
                        title={!u.disabled ? why : undefined}
                        onClick={() => void run(u.id + ":disable", async () => void (await updateUser(u.id, { disabled: !u.disabled })))}
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                      <button
                        className="danger"
                        disabled={b || locked}
                        title={why}
                        onClick={() => {
                          if (window.confirm("Delete " + u.username + " with all their runs and progress? This cannot be undone.")) {
                            void run(u.id + ":delete", async () => void (await deleteUser(u.id)));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
