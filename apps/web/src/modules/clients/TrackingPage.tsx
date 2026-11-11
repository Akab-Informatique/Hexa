import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL, useLocale } from "../../lib/l";
import { changeTip } from "../../lib/changeTip";
import { Empty, Toolbar, useUsers } from "../../components/kit";
import { PageHeader } from "../../components/ui";

type Status = "todo" | "done" | "na" | "progress" | "review";
type Kind = "das" | "tax" | "payroll" | "yearend" | "t4rl1" | "rl31" | "t5" | "verify";
interface TClient {
  id: string; name: string; status: string; taxFrequency: string; dasFrequency: string; software: string;
  resourceId: string | null; resourceName: string | null; resourceLabel: string; fiscalMonth: number | null; booksThrough: string | null; checkFrequency: string; dasFiler: string;
  payrollPeriod: string; payrollSystem: string; payrollNote: string; t4On: boolean; rl1On: boolean; t4aOn: boolean;
}
interface Filing { clientId: string; kind: Kind; period: string; item: string; status: Status; prevStatus?: string; amount: string | number | null; note: string; updatedByName?: string | null; updatedAt?: string | null }
interface Data { year: number; clients: TClient[]; filings: Filing[] }
type View = "clients" | "das" | "tax" | "payroll" | "yearend" | "t4rl1" | "rl31" | "t5";

const MONTHS: [string, string][] = [["Jan", "Jan"], ["Fév", "Feb"], ["Mars", "Mar"], ["Avr", "Apr"], ["Mai", "May"], ["Juin", "Jun"], ["Juill", "Jul"], ["Août", "Aug"], ["Sept", "Sep"], ["Oct", "Oct"], ["Nov", "Nov"], ["Déc", "Dec"]];
const pad = (n: number) => String(n).padStart(2, "0");
// Quebec dividend factors from the firm's T5 sheet: taxable amount, federal credit, Quebec credit.
const T5_TAXABLE = 1.15, T5_FED = 0.1038455, T5_QC = 0.03933;

const NEXT: Record<Status, Status> = { todo: "done", done: "na", na: "todo", progress: "review", review: "done" };
const NEXT_YEAREND: Record<Status, Status> = { todo: "progress", progress: "review", review: "done", done: "todo", na: "todo" };

// Memoized with primitive props only. Clicks are handled once on <tbody> (see onGridClick), which reads the data-* ids below.
const Cell = memo(function Cell({ st, label, disabled, dim, tip, c, k, p, i }: { st: Status; label?: string; disabled?: boolean; dim?: boolean; tip?: string; c: string; k: Kind; p: string; i: string }) {
  const l = useL();
  const txt = st === "done" ? "✓" : st === "na" ? "N/A" : st === "progress" ? l("en cours", "in progress") : st === "review" ? l("à vérifier", "to review") : "";
  const color = st === "done" ? "var(--ok)" : st === "progress" ? "var(--warn)" : st === "review" ? "var(--brand)" : "var(--muted)";
  return (
    <button type="button" aria-label={label} title={tip} disabled={disabled} data-c={c} data-k={k} data-p={p} data-i={i}
      className={`h-7 min-w-[34px] whitespace-nowrap rounded-md border px-1 text-[11px] ${dim ? "opacity-40" : ""}`}
      style={{ color, borderColor: st === "todo" ? "var(--line)" : color, background: st === "todo" ? "transparent" : "rgb(255 255 255 / .05)" }}>{txt || "·"}</button>
  );
});

/** The calendar: used on the Suivi fiscal page (all clients) and, with `clientId`, as a client's own tab. */
export function TrackingView({ clientId }: { clientId?: string }) {
  const l = useL();
  const { can, me } = useAuth();
  const loc = useLocale();
  const qc = useQueryClient();
  const users = useUsers();
  const edit = can("clients.tracking.edit");
  const [year, setYear] = useState(new Date().getFullYear());
  const [view, setView] = useState<View>(clientId ? "das" : "clients");
  const [running, setRunning] = useState(false);
  const [autoMsg, setAutoMsg] = useState("");
  const runAuto = async () => {
    setRunning(true);
    try { const r = await api<{ count: number }>("/api/tracking/auto-tasks/run", { method: "POST", body: {} }); setAutoMsg(r.count ? l(`${r.count} tâche(s) créée(s).`, `${r.count} task(s) created.`) : l("Rien de nouveau à créer.", "Nothing new to create.")); await qc.invalidateQueries({ queryKey: ["tasks"] }); }
    catch { setAutoMsg(l("Échec de la création.", "Could not create.")); } finally { setRunning(false); }
  };
  const [other, setOther] = useState<string | null>(null); // client whose "Qui déclare" is being typed ("Autre")
  const [q, setQ] = useState("");
  const [resource, setResource] = useState("");
  const kinds = view === "clients" ? "verify" : view;   // each view reads one kind of filing; its name is the kind
  const key = ["tracking", year, clientId ?? "all", kinds];
  const data = useQuery({ queryKey: key, queryFn: () => api<Data>(`/api/tracking?year=${year}&kinds=${kinds}${clientId ? `&client=${clientId}` : ""}`) });
  const dq = useDeferredValue(q);
  const rows = useMemo(() => (data.data?.clients ?? []).filter((c) => (!dq || c.name.toLowerCase().includes(dq.toLowerCase())) && (!resource || (c.resourceName ?? c.resourceLabel) === resource)), [data.data, dq, resource]);
  const map = useMemo(() => {
    const m = new Map<string, Filing>();
    for (const f of data.data?.filings ?? []) m.set(`${f.clientId}|${f.kind}|${f.period}|${f.item}`, f);
    return m;
  }, [data.data]);
  const get = (c: string, kind: Kind, period: string, item = "") => map.get(`${c}|${kind}|${period}|${item}`);
  const tipOf = (c: string, kind: Kind, period: string, item = "") => { const f = get(c, kind, period, item); return f ? changeTip(l, loc, f.status, f.updatedByName, f.updatedAt) : undefined; };
  const stOf = (c: string, kind: Kind, period: string, item = ""): Status => get(c, kind, period, item)?.status ?? "todo";

  const patchCache = (fn: (d: Data) => Data) => qc.setQueryData<Data>(key, (d) => (d ? fn(d) : d));
  const setFiling = async (c: string, kind: Kind, period: string, item: string, status: Status, amount?: number | null) => {
    const prev = get(c, kind, period, item);
    const next: Filing = { clientId: c, kind, period, item, status, prevStatus: prev?.status ?? "todo", amount: amount !== undefined ? amount : prev?.amount ?? null, note: prev?.note ?? "", updatedByName: me.user?.name ?? null, updatedAt: new Date().toISOString() };
    patchCache((d) => ({ ...d, filings: [...d.filings.filter((f) => !(f.clientId === c && f.kind === kind && f.period === period && f.item === item)), next] }));
    try { await api(`/api/tracking/${c}/filing`, { method: "PUT", body: { kind, period, item, status, amount: next.amount === null ? null : Number(next.amount), note: next.note } }); }
    catch { await qc.invalidateQueries({ queryKey: key }); }
  };
  const cycle = (c: string, kind: Kind, period: string, item = "", table = NEXT) => setFiling(c, kind, period, item, table[stOf(c, kind, period, item)]);
  // One stable click handler for the whole grid; the ref always points at the latest cycle(), so cells never need a new closure.
  const cycleRef = useRef(cycle);
  cycleRef.current = cycle;
  const onGridClick = useCallback((e: React.MouseEvent<HTMLTableSectionElement>) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-k]");
    if (!b || b.disabled || !e.currentTarget.contains(b)) return;
    const { c, k, p, i } = b.dataset as { c: string; k: Kind; p: string; i: string };
    void cycleRef.current(c, k, p, i, k === "yearend" ? NEXT_YEAREND : NEXT);
  }, []);
  const setSettings = async (c: string, patch: Record<string, unknown>) => {
    patchCache((d) => ({ ...d, clients: d.clients.map((x) => (x.id === c ? { ...x, ...patch, resourceName: "resourceId" in patch ? users.data?.find((u) => u.id === patch.resourceId)?.name ?? null : x.resourceName } : x)) }));
    try { await api(`/api/tracking/${c}/settings`, { method: "PUT", body: patch }); } catch { await qc.invalidateQueries({ queryKey: key }); }
  };

  const BUILTIN_FILERS = ["", "us", "them", "them_ccq_us"];
  const customFilers = [...new Set((data.data?.clients ?? []).map((c) => c.dasFiler).filter((f) => !BUILTIN_FILERS.includes(f)))].sort();
  const monthDue = (c: TClient, m: number) => c.taxFrequency !== "quarterly" || [1, 4, 7, 10].includes(m);
  const views: [View, string][] = [["clients", l("Dossiers", "Files")], ["das", "DAS"], ["tax", l("Taxes", "Taxes")], ["payroll", l("Paie", "Payroll")], ["yearend", l("Fin d'année", "Year-end")], ["t4rl1", "T4 / RL-1"], ["rl31", "RL-31"], ["t5", "T5"]];
  const sel = "input !w-auto !py-1 text-xs";
  const th = "px-2 py-2 text-left text-[13px] font-semibold text-fg border-b border-white/10 whitespace-nowrap";
  const num = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(v));
  const amount = (c: string, kind: Kind, period: string, item: string) => (
    <input className="input !w-24 !py-1 text-right text-xs" title={tipOf(c, kind, period, item)} inputMode="decimal" disabled={!edit} defaultValue={num(get(c, kind, period, item)?.amount)} key={`${c}${kind}${period}${item}${num(get(c, kind, period, item)?.amount)}`}
      onBlur={(e) => { const v = e.target.value.trim().replace(",", "."); const n = v === "" ? null : Number(v); if (n !== null && Number.isNaN(n)) return; if ((n ?? null) !== (get(c, kind, period, item)?.amount == null ? null : Number(get(c, kind, period, item)?.amount))) void setFiling(c, kind, period, item, n === null ? "todo" : stOf(c, kind, period, item) === "todo" ? "progress" : stOf(c, kind, period, item), n); }} />
  );
  const nameCell = (c: TClient) => (clientId ? null : <td className="whitespace-nowrap px-2 py-1 font-medium"><Link to={`/clients/${c.id}`} className="no-underline hover:underline">{c.name}</Link></td>);
  const head = (children: React.ReactNode) => <tr>{!clientId && <th className={th}>{l("Client", "Client")}</th>}{children}</tr>;
  const ym = (m: number) => `${year}-${pad(m)}`;

  return (
    <>
      <Toolbar>
        <div className="flex items-center gap-1">
          <button className="btn !p-1.5" onClick={() => setYear(year - 1)} aria-label="prev"><ChevronLeft size={14} /></button>
          <span className="w-12 text-center font-semibold">{year}</span>
          <button className="btn !p-1.5" onClick={() => setYear(year + 1)} aria-label="next"><ChevronRight size={14} /></button>
        </div>
        {!clientId && <>
          <div className="relative min-w-[200px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" />
            <input className="input !pl-9" placeholder={l("Rechercher un client…", "Search clients…")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="input !w-auto" value={resource} onChange={(e) => setResource(e.target.value)} aria-label={l("Ressource", "Resource")}>
            <option value="">{l("Toutes les ressources", "All resources")}</option>{[...new Set((data.data?.clients ?? []).map((c) => c.resourceName ?? c.resourceLabel).filter(Boolean))].sort().map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </>}
      </Toolbar>
      {!clientId && edit && (
        <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted">
          <button type="button" className="btn !py-1.5 text-xs" disabled={running} onClick={() => void runAuto()}>{l("Créer les tâches automatiques maintenant", "Create the automatic tasks now")}</button>
          <span>{autoMsg || l("Créées seules : taxes, DAS, paie, fin d'année, T4/RL-1 (vérifié chaque heure).", "Created automatically: taxes, DAS, payroll, year-end, T4/RL-1 (checked hourly).")}</span>
        </div>
      )}
      <div className="glass-flat mb-3 inline-flex flex-wrap p-0.5 text-sm" role="tablist">
        {views.map(([k, label]) => <button key={k} role="tab" aria-selected={view === k} className={`rounded-lg px-3 py-1.5 ${view === k ? "bg-white/10 font-medium" : "text-muted"}`} onClick={() => setView(k)}>{label}</button>)}
      </div>

      <div className="glass overflow-x-auto p-2">
        {rows.length === 0 ? <Empty>{l("Aucun client.", "No clients.")}</Empty> : (
          <table className="grid trk">
            <thead>
              {view === "clients" && head(<><th className={th}>{l("Ressource", "Resource")}</th><th className={th}>{l("Fin d'année", "Year-end")}</th><th className={th}>{l("Tenue de livres faite jusqu'au", "Books done through")}</th><th className={th}>{l("Fréquence de vérification", "Check frequency")}</th><th className={th}>{l("Vérifié", "Checked")} {year}</th><th className={`${th} text-center`}>T4</th><th className={`${th} text-center`}>RL-1</th><th className={`${th} text-center`}>T4A</th></>)}
              {view === "das" && <><tr>{!clientId && <th className={th} rowSpan={2}>{l("Client", "Client")}</th>}<th className={th} rowSpan={2}>{l("Qui déclare", "Filed by")}</th>{MONTHS.map((m, i) => <th key={i} colSpan={3} className="border-l border-white/10 border-b px-2 py-2 text-center text-[13px] font-semibold text-fg">{l(...m)}</th>)}</tr>
                <tr>{MONTHS.flatMap((_, i) => ["Féd", "QC", "CCQ"].map((s) => <th key={`${i}${s}`} className={`${s === "Féd" ? "border-l border-white/10 " : ""}px-1 pb-1 text-center text-[11px] font-medium text-fg/80`}>{s}</th>))}</tr></>}
              {view === "tax" && head(<>{MONTHS.map((m, i) => <th key={i} className={`${th} text-center`}>{l(...m)}</th>)}<th className={th}>{l("Fréquence", "Frequency")}</th></>)}
              {view === "payroll" && head(<><th className={th}>{l("Période", "Period")}</th><th className={`${th} text-center`}>{l("Paies", "Payroll")}</th><th className={th}>{l("Système", "System")}</th><th className={th}>{l("Info / spécification", "Info / notes")}</th></>)}
              {view === "yearend" && head(<><th className={th}>{l("Fin d'année", "Year-end")}</th>{[year - 1, year, year + 1].map((y) => <th key={y} className={`${th} text-center`}>{y}</th>)}</>)}
              {view === "t4rl1" && head(<>{["T4", l("Sommaire T4", "T4 summary"), "RL-1", "T4A", l("Sommaire RL-1", "RL-1 summary"), l("Avantage auto", "Car benefit"), "CNESST"].map((h) => <th key={h} className={`${th} text-center`}>{h}</th>)}</>)}
              {view === "rl31" && head(<><th className={`${th} text-center`}>RL-31</th></>)}
              {view === "t5" && head(<><th className={th}>T5</th><th className={th}>{l("Imposable", "Taxable")}</th><th className={th}>{l("Crédit féd.", "Fed. credit")}</th><th className={th}>{l("Crédit QC", "QC credit")}</th><th className={`${th} text-center`}>{l("Sommaire", "Summary")}</th></>)}
            </thead>
            <tbody onClick={onGridClick}>
              {rows.map((c) => {
                const cell = (kind: Kind, period: string, item = "", dim = false) => <Cell st={stOf(c.id, kind, period, item)} tip={tipOf(c.id, kind, period, item)} disabled={!edit} dim={dim} label={`${c.name} ${period} ${item}`} c={c.id} k={kind} p={period} i={item} />;
                return (
                  <tr key={c.id}>
                    {nameCell(c)}
                    {view === "clients" && <>
                      <td><div className="flex items-center gap-1"><select className={sel} disabled={!edit} value={c.resourceId ?? ""} onChange={(e) => void setSettings(c.id, { resourceId: e.target.value || null })}><option value="">—</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>{!c.resourceId && <input className="input !w-24 !py-1 text-xs" placeholder={l("Nom", "Name")} disabled={!edit} defaultValue={c.resourceLabel} key={`r${c.id}${c.resourceLabel}`} onBlur={(e) => e.target.value !== c.resourceLabel && void setSettings(c.id, { resourceLabel: e.target.value })} />}</div></td>
                      <td><select className={sel} disabled={!edit} value={c.fiscalMonth ?? ""} onChange={(e) => void setSettings(c.id, { fiscalMonth: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{MONTHS.map((m, i) => <option key={i} value={i + 1}>{l(...m)}</option>)}</select></td>
                      <td><input type="date" className={sel} disabled={!edit} value={c.booksThrough?.slice(0, 10) ?? ""} onChange={(e) => void setSettings(c.id, { booksThrough: e.target.value || null })} /></td>
                      <td><select className={sel} disabled={!edit} value={c.checkFrequency} onChange={(e) => void setSettings(c.id, { checkFrequency: e.target.value })}><option value="">{l("Aucun", "None")}</option><option value="monthly">{l("1 mois", "1 month")}</option><option value="quarterly">{l("Trimestriel", "Quarterly")}</option><option value="semiannual">{l("6 mois", "6 months")}</option><option value="annual">{l("Annuel", "Annual")}</option></select></td>
                      <td className="text-center">{cell("verify", String(year))}</td>
                      {(["t4On", "rl1On", "t4aOn"] as const).map((k) => <td key={k} className="text-center"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={!edit} checked={c[k]} aria-label={`${c.name} ${k}`} onChange={(e) => void setSettings(c.id, { [k]: e.target.checked })} /></td>)}
                    </>}
                    {view === "das" && <>
                      <td>{other === c.id ? (
                        <input autoFocus className="input !w-36 !py-1 text-xs" placeholder={l("Nouvelle option…", "New option…")} onKeyDown={(e) => { if (e.key === "Escape") setOther(null); if (e.key === "Enter") e.currentTarget.blur(); }}
                          onBlur={(e) => { const v = e.target.value.trim(); setOther(null); if (v) void setSettings(c.id, { dasFiler: v }); }} />
                      ) : (
                        <select className={sel} disabled={!edit} value={c.dasFiler} onChange={(e) => { if (e.target.value === "__other") setOther(c.id); else void setSettings(c.id, { dasFiler: e.target.value }); }}>
                          <option value="">—</option><option value="us">{l("Nous", "Us")}</option><option value="them">{l("Eux", "Them")}</option><option value="them_ccq_us">{l("Eux – CCQ nous", "Them – CCQ us")}</option>
                          {customFilers.map((f) => <option key={f} value={f}>{f}</option>)}
                          {edit && <option value="__other">{l("Autre…", "Other…")}</option>}
                        </select>
                      )}</td>
                      {MONTHS.flatMap((_, i) => ["fed", "prov", "ccq"].map((it) => <td key={`${i}${it}`} className={`${it === "fed" ? "border-l border-white/10 " : ""}px-0.5 text-center`}>{cell("das", ym(i + 1), it)}</td>))}
                    </>}
                    {view === "tax" && <>
                      {MONTHS.map((_, i) => <td key={i} className="px-0.5 text-center">{cell("tax", ym(i + 1), "", !monthDue(c, i + 1))}</td>)}
                      <td className="text-xs text-muted">{c.taxFrequency === "monthly" ? l("Mensuelle", "Monthly") : c.taxFrequency === "quarterly" ? l("Trimestrielle", "Quarterly") : c.taxFrequency === "annual" ? l("Annuelle", "Annual") : "—"}</td>
                    </>}
                    {view === "payroll" && <>
                      <td><select className={sel} disabled={!edit} value={c.payrollPeriod} onChange={(e) => void setSettings(c.id, { payrollPeriod: e.target.value })}><option value="">—</option><option value="weekly">{l("Hebdomadaire", "Weekly")}</option><option value="biweekly">{l("Aux 2 semaines", "Biweekly")}</option><option value="semimonthly">{l("Bimensuelle", "Semi-monthly")}</option><option value="monthly">{l("Mensuelle", "Monthly")}</option></select></td>
                      <td className="text-center">{cell("payroll", String(year), "paies")}</td>
                      <td><input className="input !py-1 text-xs" disabled={!edit} defaultValue={c.payrollSystem} key={`s${c.id}${c.payrollSystem}`} onBlur={(e) => e.target.value !== c.payrollSystem && void setSettings(c.id, { payrollSystem: e.target.value })} /></td>
                      <td><input className="input !min-w-[260px] !py-1 text-xs" disabled={!edit} defaultValue={c.payrollNote} key={`n${c.id}${c.payrollNote}`} onBlur={(e) => e.target.value !== c.payrollNote && void setSettings(c.id, { payrollNote: e.target.value })} /></td>
                    </>}
                    {view === "yearend" && <>
                      <td className="text-xs text-muted">{c.fiscalMonth ? l(...MONTHS[c.fiscalMonth - 1]!) : "—"}</td>
                      {[year - 1, year, year + 1].map((y) => <td key={y} className="text-center">{cell("yearend", String(y))}</td>)}
                    </>}
                    {view === "t4rl1" && ["t4", "t4sum", "rl1", "t4a", "rl1sum", "car", "cnesst"].map((it) => <td key={it} className="text-center">
                      {it === "t4sum" || it === "rl1sum" ? amount(c.id, "t4rl1", String(year - 1), it) : cell("t4rl1", String(year - 1), it)}</td>)}
                    {view === "rl31" && <td className="text-center">{cell("rl31", String(year - 1))}</td>}
                    {view === "t5" && (() => {
                      const div = Number(get(c.id, "t5", String(year - 1), "t5")?.amount ?? 0);
                      const f = (n: number) => (div ? n.toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—");
                      return <>
                        <td>{amount(c.id, "t5", String(year - 1), "t5")}</td>
                        <td className="text-right text-xs">{f(div * T5_TAXABLE)}</td><td className="text-right text-xs">{f(div * T5_FED)}</td><td className="text-right text-xs">{f(div * T5_QC)}</td>
                        <td className="text-center">{cell("t5", String(year - 1), "sum")}</td>
                      </>;
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        {view === "yearend" ? l("Cliquer fait passer : à faire → en cours → à vérifier → fait.", "Click cycles: to do → in progress → to review → done.")
          : view === "t4rl1" || view === "rl31" || view === "t5" ? l(`Année d'imposition ${year - 1}. Cliquer fait passer : à faire → fait → N/A.`, `Tax year ${year - 1}. Click cycles: to do → done → N/A.`)
            : view === "clients" ? l("Les changements sont enregistrés automatiquement.", "Changes save automatically.") : l("Cliquer fait passer : à faire → fait → N/A.", "Click cycles: to do → done → N/A.")}
      </p>
    </>
  );
}

export default function TrackingPage() {
  const l = useL();
  return (
    <>
      <PageHeader title={l("Suivi fiscal", "Tax follow-up")} subtitle={l("DAS, taxes, paie, fin d'année et feuillets de tous les clients", "Payroll remittances, taxes, payroll, year-end and slips for all clients")} />
      <TrackingView />
    </>
  );
}
