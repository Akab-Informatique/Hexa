import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Square } from "lucide-react";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL } from "../../lib/l";
import { errMsg } from "../../components/kit";
import { Modal } from "../../components/ui";

export interface Running { taskId: string; title: string; clientId: string | null; clientName: string | null; startedAt: string }
export interface TimerState { running: Running | null; pendingCount: number; pendingMinutes: number; now: string }
export interface Stopped { segmentId: string; taskId?: string; minutes: number; title: string; clientId: string | null; clientName: string | null }
export interface Pending { id: string; taskId: string; startedAt: string; minutes: number; title: string; clientId: string | null; clientName: string | null }

const AUTO_KEY = "hexa.timer.auto";
export const autoStartPref = (): boolean => { try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; } };
export const setAutoStartPref = (on: boolean) => { try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* ignore */ } };

export const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
export const minLabel = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`);

/** The server owns the timer (it survives closing a task or leaving the page); this reads it and keeps a ticking clock. */
export function useTimerState() {
  const { can } = useAuth();
  const enabled = can("mytools.timesheet.use", "mytools.timesheet.manage") && can("tasks.view", "command.pipeline.view");
  const q = useQuery({ queryKey: ["task-timer"], queryFn: () => api<TimerState>("/api/tasks/timer"), enabled, refetchInterval: 60_000, staleTime: 15_000 });
  const skew = useMemo(() => (q.data ? Date.parse(q.data.now) - Date.now() : 0), [q.data, q.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  return { enabled, state: q.data, loaded: q.isSuccess, skew };
}

export function useElapsed(startedAt: string | undefined, skew: number) {
  const [, tick] = useState(0);
  useEffect(() => { if (!startedAt) return; const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, [startedAt]);
  return startedAt ? (Date.now() + skew - Date.parse(startedAt)) / 1000 : 0;
}

export function useTimerActions() {
  const qc = useQueryClient();
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["task-timer"] }); await qc.invalidateQueries({ queryKey: ["task-segments"] }); await qc.invalidateQueries({ queryKey: ["task-pending"] }); };
  return {
    refresh,
    start: async (taskId: string): Promise<"ok" | "busy"> => {
      try { await api("/api/tasks/timer/start", { body: { taskId } }); await refresh(); await qc.invalidateQueries({ queryKey: ["task", taskId] }); await qc.invalidateQueries({ queryKey: ["tasks"] }); return "ok"; }
      catch (e) { if (e instanceof ApiError && e.message === "timer_running") return "busy"; throw e; }
    },
    stop: async (): Promise<Stopped> => { const r = await api<Stopped>("/api/tasks/timer/stop", { body: {} }); await refresh(); return r; },
    cancel: async () => { await api("/api/tasks/timer/cancel", { body: {} }); await refresh(); },
  };
}

/** After the timer stops: a short description and the time become a billable time entry, or wait for later, or are dropped. */
export function LogTimeDialog({ seg, onClose }: { seg: Stopped; onClose: () => void }) {
  const l = useL();
  const { refresh } = useTimerActions();
  const [desc, setDesc] = useState("");
  const [minutes, setMinutes] = useState(String(Math.min(1440, seg.minutes)));
  const [billable, setBillable] = useState(Boolean(seg.clientId));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const codes: Record<string, [string, string]> = {
    timesheet_locked: ["Votre feuille de temps de cette semaine est déjà envoyée. Le temps reste à saisir.", "This week's timesheet is already sent. The time stays pending."],
    already_logged: ["Ce temps est déjà saisi.", "This time is already logged."],
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      await api(`/api/tasks/segments/${seg.segmentId}/log`, { body: { description: desc.trim(), minutes: Number(minutes), billable: seg.clientId ? billable : false } });
      await refresh(); onClose();
    } catch (e) { const c = errMsg(e, "Error"); setError(codes[c] ? l(...codes[c]!) : c); } finally { setBusy(false); }
  };
  const drop = async () => {
    if (!window.confirm(l("Ne pas saisir ce temps ? Il sera abandonné.", "Do not log this time? It will be dropped."))) return;
    await api(`/api/tasks/segments/${seg.segmentId}`, { method: "DELETE" }); await refresh(); onClose();
  };
  const valid = desc.trim().length > 0 && Number(minutes) >= 1 && Number(minutes) <= 1440;
  return (
    <Modal title={l("Saisir le temps", "Log the time")} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">{seg.title}{seg.clientName ? ` · ${seg.clientName}` : ""} · <b className="text-[var(--fg)]">{minLabel(seg.minutes)}</b></p>
      <label className="mb-3 block"><span className="label">{l("Qu'avez-vous fait ?", "What did you do?")}</span><textarea className="input min-h-[84px]" autoFocus value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={l("Brève description du travail", "Short description of the work")} maxLength={1000} /></label>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <label className="block"><span className="label">{l("Minutes", "Minutes")}</span><input className="input" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={billable && Boolean(seg.clientId)} disabled={!seg.clientId} onChange={(e) => setBillable(e.target.checked)} />{seg.clientId ? l("Facturable au client", "Billable to the client") : l("Aucun client sur la tâche", "No client on the task")}</label>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-between gap-2">
        <button className="btn btn-danger" onClick={() => void drop()}>{l("Ne pas saisir", "Do not log")}</button>
        <div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Plus tard", "Later")}</button><button className="btn btn-primary" disabled={!valid || busy} onClick={() => void save()}>{l("Enregistrer", "Save")}</button></div>
      </div>
    </Modal>
  );
}

/** Every stretch of time still waiting to be logged. */
function PendingDialog({ onClose }: { onClose: () => void }) {
  const l = useL();
  const [seg, setSeg] = useState<Stopped | null>(null);
  const q = useQuery({ queryKey: ["task-pending"], queryFn: () => api<Pending[]>("/api/tasks/segments/pending") });
  return (
    <Modal title={l("Temps à saisir", "Time to log")} onClose={onClose}>
      {!q.data?.length ? <p className="text-sm text-muted">{l("Rien à saisir.", "Nothing to log.")}</p> : (
        <ul className="space-y-2">{q.data.map((p) => (
          <li key={p.id} className="glass-flat flex items-center gap-3 p-3 text-sm"><div className="min-w-0 flex-1"><div className="truncate font-medium">{p.title}</div><div className="text-xs text-muted">{p.clientName ?? "—"} · {minLabel(p.minutes)}</div></div>
            <button className="btn btn-primary !py-1 text-xs" onClick={() => setSeg({ segmentId: p.id, taskId: p.taskId, minutes: p.minutes, title: p.title, clientId: p.clientId, clientName: p.clientName })}>{l("Saisir", "Log")}</button></li>))}</ul>)}
      <div className="mt-4 flex justify-end"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button></div>
      {seg && <LogTimeDialog seg={seg} onClose={() => setSeg(null)} />}
    </Modal>
  );
}

/** Always on screen while a timer runs, wherever you are in the app. */
export function TimerBar() {
  const l = useL();
  const nav = useNavigate();
  const { enabled, state, skew } = useTimerState();
  const { stop } = useTimerActions();
  const run = state?.running ?? null;
  const elapsed = useElapsed(run?.startedAt, skew);
  const [log, setLog] = useState<Stopped | null>(null);
  const [list, setList] = useState(false);
  const [error, setError] = useState("");
  if (!enabled || (!run && !state?.pendingCount && !log)) return null;
  const doStop = async () => { setError(""); try { setLog(await stop()); } catch (e) { setError(errMsg(e, "Error")); } };
  return (
    <>
      <div className="fixed bottom-4 right-4 z-30 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-3 rounded-2xl border border-white/15 p-3 shadow-2xl" style={{ background: "color-mix(in oklab, #0b0a14 82%, var(--brand))", backdropFilter: "blur(14px)" }} role="status">
        {run && (
          <>
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full" style={{ background: "var(--ok)", boxShadow: "0 0 10px var(--ok)" }} />
            <button className="min-w-0 max-w-[220px] truncate text-left text-sm font-medium hover:underline" onClick={() => nav(`/tasks?open=${run.taskId}`)} title={l("Ouvrir la tâche", "Open the task")}>{run.title}</button>
            <span className="font-mono text-base tabular-nums">{clock(elapsed)}</span>
            <button className="btn btn-danger !px-3 !py-1.5 text-xs" onClick={() => void doStop()}><Square size={12} fill="currentColor" />{l("Arrêter", "Stop")}</button>
          </>
        )}
        {!!state?.pendingCount && (
          <button className="btn !py-1.5 text-xs" onClick={() => setList(true)}><Clock size={13} />{l("Temps à saisir", "Time to log")}: {minLabel(state.pendingMinutes)} ({state.pendingCount})</button>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      {log && <LogTimeDialog seg={log} onClose={() => setLog(null)} />}
      {list && <PendingDialog onClose={() => setList(false)} />}
    </>
  );
}
