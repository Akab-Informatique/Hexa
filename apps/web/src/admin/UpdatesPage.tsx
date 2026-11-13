import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import type { UpdaterStatus } from "@hexa/shared";
import { api } from "../lib/api";
import { useL } from "../lib/l";
import { PageHeader } from "../components/ui";
import { Chip, Stat } from "../components/kit";

export interface UpdateStatus {
  current: string;
  target: string | null;
  updateAvailable: boolean;
  updater: UpdaterStatus | null;
  updaterConfigured: boolean;
}

const POLL_MS = 3000;
const RELOAD_MS = 2000;

/** Manual application update. Shown only to the master admin and holders of admin.updates.install. */
export default function UpdatesPage() {
  const l = useL();
  const [polling, setPolling] = useState(false);
  const [from, setFrom] = useState<string | null>(null);
  const [clickedAt, setClickedAt] = useState<number>(0);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["update-status"],
    queryFn: () => api<UpdateStatus>("/api/update/status"),
    refetchInterval: polling ? POLL_MS : false,
  });
  const s = q.data;
  const runState = s?.updater?.state;
  const runningNow = runState === "running";
  // A failure counts only for the run started by this click, not an older one still reported by the updater.
  const failedNow = Boolean(
    (runState === "failed" || runState === "rolled_back") && s?.updater?.startedAt && Date.parse(s.updater.startedAt) >= clickedAt - 5000,
  );

  useEffect(() => {
    if (!polling || !s) return;
    if (from && s.current !== from) {
      setPolling(false);
      setDone(true);
      const t = setTimeout(() => window.location.reload(), RELOAD_MS);
      return () => clearTimeout(t);
    }
    if (failedNow) setPolling(false);
  }, [polling, s, from, failedNow]);

  const install = async () => {
    if (!s?.target) return;
    const ok = window.confirm(l(
      `Installer la version ${s.target} maintenant ? L'application sera brièvement indisponible.`,
      `Install version ${s.target} now? The application will be briefly unavailable.`,
    ));
    if (!ok) return;
    setErr("");
    setBusy(true);
    try {
      setFrom(s.current);
      setClickedAt(Date.now());
      await api("/api/update/apply", { method: "POST" });
      setPolling(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const canInstall = Boolean(s?.updateAvailable && s.updaterConfigured && !runningNow && !polling && !done && !busy);

  type Tone = "ok" | "warn" | "off" | "danger";
  let stateLine: { tone: Tone; label: string; text: string };
  if (done) stateLine = { tone: "ok", label: l("Terminé", "Done"), text: l("Mise à jour installée. Rechargement de la page…", "Update installed. Reloading the page…") };
  else if (polling || runningNow) stateLine = { tone: "warn", label: l("En cours", "Running"), text: l("Mise à jour en cours… ne fermez pas cette page.", "Updating… do not close this page.") };
  else if (failedNow && s?.updater) stateLine = {
    tone: "danger",
    label: l("Erreur", "Error"),
    text: runState === "rolled_back"
      ? l(`Échec de la mise à jour, version précédente restaurée. ${s.updater.error ?? ""}`, `Update failed, previous version restored. ${s.updater.error ?? ""}`)
      : l(`Échec de la mise à jour. ${s.updater.error ?? ""}`, `Update failed. ${s.updater.error ?? ""}`),
  };
  else if (!s?.updaterConfigured) stateLine = { tone: "off", label: l("Indisponible", "Unavailable"), text: l("Le service de mise à jour n'est pas configuré sur cette installation.", "The update service is not configured on this installation.") };
  else if (s?.updateAvailable) stateLine = { tone: "warn", label: l("Disponible", "Available"), text: l(`Mise à jour disponible : ${s.target}.`, `Update available: ${s.target}.`) };
  else stateLine = { tone: "ok", label: l("À jour", "Up to date"), text: l("L'application est à jour.", "The application is up to date.") };

  return (
    <>
      <PageHeader
        title={l("Mises à jour", "Updates")}
        subtitle={l("Les mises à jour sont toujours installées manuellement.", "Updates are always installed manually.")}
      />
      <p className="glass mb-4 p-4 text-sm text-muted">
        {l(
          "Une sauvegarde de l'application est faite automatiquement avant chaque mise à jour, et restaurée si l'installation échoue.",
          "The app is backed up automatically before each update and restored if the installation fails.",
        )}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={l("Version actuelle", "Current version")} value={s?.current ?? "—"} />
        <Stat label={l("Version cible", "Target version")} value={s?.target ?? "—"} />
      </div>

      <div className="glass mt-4 flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Chip tone={stateLine.tone}>{stateLine.label}</Chip>
          <span className="text-sm" role="status" aria-live="polite">{stateLine.text}</span>
        </div>
        <button className="btn btn-primary" disabled={!canInstall} onClick={() => void install()}>
          {polling || runningNow ? <RefreshCw size={15} className="animate-spin" /> : <Download size={15} />}
          {l("Installer la mise à jour", "Install update")}
        </button>
      </div>

      {s?.updater?.step && (polling || runningNow) && <p className="mt-3 text-xs text-muted">{s.updater.step}</p>}
      {err && <p className="mt-3 text-sm" style={{ color: "var(--danger)" }}>{err}</p>}
      {q.isError && !polling && <p className="mt-3 text-sm" style={{ color: "var(--danger)" }}>{l("Impossible de lire l'état des mises à jour.", "Unable to read the update status.")}</p>}
    </>
  );
}
