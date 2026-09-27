/**
 * Whether retakes are available (the api's RETAKE_ENABLED) and the queue counts for the top-bar badge.
 * config === null: retakes are off and every retake control stays hidden.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth/context.js";
import { fetchRetakeConfig, type RetakeConfig } from "./client.js";

interface RetakeState {
  config: RetakeConfig | null;
  /** Re-read counts after an action (or on a timer). */
  refresh: () => void;
}

const Ctx = createContext<RetakeState>({ config: null, refresh: () => undefined });

const COUNTS_POLL_MS = 60_000;

export function RetakeProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RetakeConfig | null>(null);
  // what the viewer may do depends on who is logged in
  const { user } = useAuth();
  const refresh = useCallback(() => {
    fetchRetakeConfig()
      .then(setConfig)
      .catch(() => undefined); // keep the last known state if the api is briefly unreachable
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, COUNTS_POLL_MS);
    return () => clearInterval(t);
  }, [refresh, user?.id, user?.role]);
  const value = useMemo(() => ({ config, refresh }), [config, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRetakes(): RetakeState {
  return useContext(Ctx);
}

/** Pages that still need a photo: flagged ones and those still flagged after a retake. */
export function openCount(config: RetakeConfig | null): number {
  return config ? config.counts.flagged + config.counts.still_flagged : 0;
}
