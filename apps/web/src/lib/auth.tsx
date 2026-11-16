import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export type Stage = "anonymous" | "mfa" | "mfa-setup" | "password" | "ready";
export interface User {
  id: string; email: string; name: string; kind: "staff" | "client"; locale: "fr" | "en";
  isMaster: boolean; totpEnabled: boolean; clientId: string | null;
}
interface Me { stage: Stage; user?: User; rights?: string[]; mfaRequired?: boolean }
interface Ctx {
  me: Me;
  refresh: () => Promise<void>;
  can: (...keys: string[]) => boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: (ctx: Ctx) => ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/auth/me"), staleTime: 30_000, retry: false });
  const me: Me = q.data ?? { stage: "anonymous" };
  const ctx: Ctx = {
    me,
    refresh: async () => { await qc.invalidateQueries({ queryKey: ["me"] }); },
    can: (...keys) => keys.some((k) => me.rights?.includes(k)),
    logout: async () => {
      try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch { /* the session may already be gone: still show the sign-in screen */ }
      // Signed out is set directly: clearing the cache and waiting for "me" to refetch left the app on screen.
      qc.setQueryData(["me"], { stage: "anonymous" });
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    },
  };
  if (q.isLoading) return null;
  return <AuthContext.Provider value={ctx}>{children(ctx)}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
