/**
 * Top-bar account control: "Log in" when nobody is logged in, else the username with a menu
 * (change password, users for admins, log out).
 */
import { useEffect, useRef, useState } from "react";
import { navigate } from "../route.js";
import { useAuth } from "./context.js";

export function UserMenu() {
  const { user, showLogin, showPassword, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) {
    return (
      <button className="user-button" onClick={showLogin}>
        Log in
      </button>
    );
  }
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="user-menu" ref={ref}>
      <button className="user-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={user.role === "admin" ? "Admin" : undefined}>
        {user.username}
        {user.role === "admin" && <span className="role-mark">admin</span>}
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={pick(showPassword)}>
            Change password
          </button>
          {user.role === "admin" && (
            <button role="menuitem" onClick={pick(() => navigate("/admin/users"))}>
              Users
            </button>
          )}
          <button role="menuitem" onClick={pick(() => void logout())}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
