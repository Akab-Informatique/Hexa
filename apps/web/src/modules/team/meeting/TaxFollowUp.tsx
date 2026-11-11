import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { fmtDate, useL, useLocale } from "../../../lib/l";
import { changeTip } from "../../../lib/changeTip";

type St = "todo" | "done" | "na" | "progress" | "review";
interface Box { status: St; prev: string; by: string | null; at: string | null }
interface Das { clientId: string; name: string; resource: string; filer: string; fed?: Box; prov?: Box; ccq?: Box }
interface Tax extends Box { clientId: string; name: string; resource: string }
interface Month { due: string; period: string; dasDue: string; taxDue: string; das: Das[]; tax: Tax[] }

const NEXT: Record<St, St> = { todo: "done", done: "na", na: "todo", progress: "done", review: "done" };
const open = (s: St) => s === "todo" || s === "progress" || s === "review";

/** Weekly meeting: the DAS and taxes to do this month and next month, from the tax follow-up calendar. */
export function TaxFollowUp() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["meeting-tracking"], queryFn: () => api<{ months: Month[] }>("/api/team/meeting/tracking"), refetchInterval: 60_000 });
  const edit = can("clients.tracking.edit");
  if (!q.data) return null;
  const set = async (clientId: string, kind: "das" | "tax", period: string, item: string, cur: St) => {
    try {
      await api(`/api/tracking/${clientId}/filing`, { method: "PUT", body: { kind, period, item, status: NEXT[cur] } });
    } finally {
      // Always replace local state with server truth, also when the save failed.
      await Promise.all([qc.invalidateQueries({ queryKey: ["meeting-tracking"] }), qc.invalidateQueries({ queryKey: ["tracking"] })]);
    }
  };
  const chip = (s: St) => ({ color: s === "done" ? "var(--ok)" : s === "na" ? "var(--muted)" : "var(--warn)", borderColor: s === "done" ? "var(--ok)" : s === "na" ? "var(--line)" : "var(--warn)" });
  const mark = (s: St) => (s === "done" ? "✓" : s === "na" ? "N/A" : "·");
  const monthName = (due: string) => new Date(`${due}-15T12:00:00`).toLocaleDateString(loc, { month: "long", year: "numeric" });
  return (
    <section className="glass p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{l("Suivi fiscal : ce mois-ci et le mois prochain", "Tax follow-up: this month and next")}</h2>
        <Link to="/tracking" className="text-xs">{l("Ouvrir le calendrier", "Open the calendar")}</Link>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {q.data.months.map((m, idx) => {
          // Only the firm's own DAS: 'us' = fed/prov/ccq, 'them_ccq_us' = ccq; any other label is not ours. The server already sends open boxes only.
          const keysOf = (d: Das) => ((d.filer === "us" ? ["fed", "prov", "ccq"] : d.filer === "them_ccq_us" ? ["ccq"] : []) as ("fed" | "prov" | "ccq")[]).filter((k) => d[k] !== undefined);
          const dasOpen = m.das.filter((d) => keysOf(d).some((k) => open(d[k]?.status ?? "na")));
          const taxOpen = m.tax.filter((t) => open(t.status));
          return (
            <div key={m.due}>
              <h3 className="mb-2 text-sm font-semibold">{idx === 0 ? l("Ce mois-ci", "This month") : l("Le mois prochain", "Next month")} <span className="font-normal normal-case text-muted">· {monthName(m.due)}</span></h3>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">DAS · {l("avant le", "by")} {fmtDate(m.dasDue, loc)} <span className="normal-case">({dasOpen.length} {l("à faire", "to do")})</span></p>
              {dasOpen.length === 0 ? <p className="mb-3 text-sm text-muted">{l("Rien à faire.", "Nothing to do.")}</p> : (
                <ul className="mb-3 space-y-1 text-sm">
                  {dasOpen.map((d) => (
                    <li key={d.clientId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate"><Link to={`/clients/${d.clientId}`} className="no-underline hover:underline">{d.name}</Link>{d.resource && <span className="text-xs text-muted"> · {d.resource}</span>}</span>
                      <span className="flex shrink-0 gap-1">
                        {keysOf(d).map((k) => (
                          <button key={k} type="button" title={changeTip(l, loc, d[k]?.status ?? "todo", d[k]?.by, d[k]?.at)} disabled={!edit} onClick={() => void set(d.clientId, "das", m.period, k, d[k]?.status ?? "todo")} className="h-6 rounded-md border px-1.5 text-[11px]" style={chip(d[k]?.status ?? "todo")}>{k === "fed" ? "Féd" : k === "prov" ? "QC" : "CCQ"} {mark(d[k]?.status ?? "todo")}</button>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{l("Taxes", "Taxes")} · {l("avant le", "by")} {fmtDate(m.taxDue, loc)} <span className="normal-case">({taxOpen.length} {l("à faire", "to do")})</span></p>
              {taxOpen.length === 0 ? <p className="text-sm text-muted">{l("Rien à faire.", "Nothing to do.")}</p> : (
                <ul className="space-y-1 text-sm">
                  {taxOpen.map((t) => (
                    <li key={t.clientId} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate"><Link to={`/clients/${t.clientId}`} className="no-underline hover:underline">{t.name}</Link>{t.resource && <span className="text-xs text-muted"> · {t.resource}</span>}</span>
                      <button type="button" title={changeTip(l, loc, t.status, t.by, t.at)} disabled={!edit} onClick={() => void set(t.clientId, "tax", m.period, "", t.status)} className="h-6 shrink-0 rounded-md border px-2 text-[11px]" style={chip(t.status)}>{l("Fait", "Done")}</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
