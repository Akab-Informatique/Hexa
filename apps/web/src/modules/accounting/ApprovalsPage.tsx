import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronLeft, ChevronRight, FileText, Pencil, Plus, RefreshCw, RotateCcw, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, money, mondayOf, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, FormDialog, Tabs, type FieldDef } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

interface Item { id: string; clientId: string; clientName: string; contractId: string | null; contractName: string | null; source: string; description: string; quantity: number; unitPrice: number; status: string; excludedReason: string; workDate: string | null; createdByName: string | null }
type Summary = Record<"pending" | "approved" | "excluded" | "invoiced", { count: number; total: number }>;
type Period = "day" | "week" | "month" | "custom";
const OPEN_KEY = "hexa.approvals.opened";
const readOpen = (): string[] => { try { return JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "[]"); } catch { return []; } };
const eom = (s: string) => { const d = new Date(`${s.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };

/** The time frame (day, week, month or custom) limits every list and count, and the invoices made from it. */
function useFrame() {
  const [sp, setSp] = useSearchParams();
  const period = (sp.get("period") as Period) ?? "month";
  const anchor = sp.get("at") ?? todayISO();
  const range = period === "day" ? { from: anchor, to: anchor } : period === "week" ? { from: mondayOf(anchor), to: addDays(mondayOf(anchor), 6) }
    : period === "month" ? { from: `${anchor.slice(0, 7)}-01`, to: eom(anchor) } : { from: sp.get("from") ?? `${anchor.slice(0, 7)}-01`, to: sp.get("to") ?? todayISO() };
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v === null) n.delete(k); else n.set(k, v); } setSp(n, { replace: true }); };
  const shift = (dir: number) => {
    if (period === "day") set({ at: addDays(anchor, dir) }); else if (period === "week") set({ at: addDays(anchor, 7 * dir) });
    else if (period === "month") { const d = new Date(`${anchor.slice(0, 7)}-15T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + dir); set({ at: d.toISOString().slice(0, 10) }); }
  };
  return { period, range, set, shift, tab: (sp.get("tab") as "pending" | "approved" | "excluded" | "invoiced") ?? "pending" };
}

export default function ApprovalsPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const f = useFrame();
  const [sel, setSel] = useState<string[]>([]);
  const [opened, setOpened] = useState<string[]>(readOpen);
  const [adding, setAdding] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const { from, to } = f.range;
  const q = useQuery({ queryKey: ["billing-items", f.tab, from, to], queryFn: () => api<Item[]>(`/api/accounting/billing-items?status=${f.tab}&from=${from}&to=${to}`) });
  const sum = useQuery({ queryKey: ["billing-summary", from, to], queryFn: () => api<Summary>(`/api/accounting/billing-items/summary?from=${from}&to=${to}`) });
  const manage = can("accounting.approvals.manage");
  const rows = q.data ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["billing-items"] }); await qc.invalidateQueries({ queryKey: ["billing-summary"] }); setSel([]); };
  const run = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const decide = (ids: string[], decision: "approve" | "exclude" | "restore", reason?: "billed" | "aside") => run(() => api("/api/accounting/billing-items/decision", { body: { ids, decision, reason } }));
  const patch = (id: string, body: object) => run(() => api(`/api/accounting/billing-items/${id}`, { method: "PATCH", body }));
  const tot = (x: Item) => x.quantity * x.unitPrice;

  // client -> contract -> lines
  const clients = [...new Set(rows.map((r) => r.clientId))].map((id) => {
    const items = rows.filter((r) => r.clientId === id);
    const contracts = [...new Set(items.map((i) => i.contractId ?? ""))].map((cid) => ({ id: cid, name: cid ? items.find((i) => i.contractId === cid)!.contractName ?? "" : "", items: items.filter((i) => (i.contractId ?? "") === cid) }));
    return { id, name: items[0]!.clientName, items, contracts };
  });
  const save = (n: string[]) => { setOpened(n); try { sessionStorage.setItem(OPEN_KEY, JSON.stringify(n)); } catch { /* ignore */ } };
  const toggle = (k: string) => save(opened.includes(k) ? opened.filter((x) => x !== k) : [...opened, k]);
  const pick = (ids: string[], on: boolean) => setSel((s) => (on ? [...new Set([...s, ...ids])] : s.filter((x) => !ids.includes(x))));
  const selTotal = rows.filter((r) => sel.includes(r.id)).reduce((a, r) => a + tot(r), 0);
  const fields: FieldDef[] = [{ name: "clientId", label: ["Client", "Client"], type: "client", required: true }, { name: "description", label: ["Description", "Description"], required: true, span: 2 }, { name: "quantity", label: ["Quantité", "Quantity"], type: "number", step: "0.01", required: true }, { name: "unitPrice", label: ["Prix unitaire", "Unit price"], type: "number", step: "0.01", required: true }, { name: "workDate", label: ["Date du travail", "Work date"], type: "date" }];
  const periodLabel = f.period === "custom" ? `${fmtDate(from, loc)} → ${fmtDate(to, loc)}` : f.period === "day" ? fmtDate(from, loc) : f.period === "week" ? `${fmtDate(from, loc)} → ${fmtDate(to, loc)}` : new Date(`${from}T12:00:00`).toLocaleDateString(loc, { month: "long", year: "numeric" });
  const tabs = (["pending", "approved", "excluded", "invoiced"] as const).map((k) => ({ key: k, label: `${{ pending: l("À approuver", "To approve"), approved: l("Approuvé", "Approved"), excluded: l("Mis de côté", "Set aside"), invoiced: l("Facturé", "Invoiced") }[k]} (${sum.data?.[k].count ?? 0})` }));

  return (
    <>
      <PageHeader title={l("Travail à facturer", "Work to bill")} subtitle={l("Approuvez le travail de la période, puis facturez-le", "Approve the period's work, then invoice it")}
        actions={<div className="flex flex-wrap gap-2">
          {manage && <button className="btn" onClick={() => void run(async () => { const r = await api<{ created: number }>("/api/clients/contracts/refresh-billing", { method: "POST" }); setMsg(l(`${r.created} ligne(s) de contrat ajoutée(s).`, `${r.created} contract line(s) added.`)); })}><RefreshCw size={15} />{l("Rafraîchir", "Refresh")}</button>}
          {manage && <button className="btn" onClick={() => setAdding(true)}><Plus size={15} />{l("Ligne manuelle", "Manual line")}</button>}
          {can("accounting.invoices.edit", "accounting.invoices.manage") && <button className="btn btn-primary" onClick={() => setInvoicing(true)}><FileText size={15} />{l("Facturer le travail approuvé", "Invoice approved work")}</button>}</div>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs tabs={[{ key: "day", label: l("Jour", "Day") }, { key: "week", label: l("Semaine", "Week") }, { key: "month", label: l("Mois", "Month") }, { key: "custom", label: l("Personnalisé", "Custom") }]} value={f.period} onChange={(p) => f.set({ period: p, at: f.period === "custom" ? todayISO() : null, from: null, to: null })} />
        {f.period !== "custom" ? (<><button className="btn !p-2" onClick={() => f.shift(-1)} aria-label="prev"><ChevronLeft size={16} /></button><div className="glass-flat px-4 py-2 text-sm font-medium capitalize">{periodLabel}</div><button className="btn !p-2" onClick={() => f.shift(1)} aria-label="next"><ChevronRight size={16} /></button><button className="btn" onClick={() => f.set({ at: todayISO() })}>{l("Aujourd'hui", "Today")}</button></>)
          : (<><input className="input !w-auto" type="date" value={from} onChange={(e) => f.set({ from: e.target.value, to })} /><span className="text-muted">→</span><input className="input !w-auto" type="date" value={to} onChange={(e) => f.set({ from, to: e.target.value })} /></>)}
      </div>
      <Tabs tabs={tabs} value={f.tab} onChange={(t) => { f.set({ tab: t }); setSel([]); }} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">{l("Total de l'onglet", "Tab total")}: <b className="text-white">{money(sum.data?.[f.tab].total, loc)}</b></span><div className="flex-1" />
        <button className="btn" onClick={() => save(opened.length ? [] : clients.flatMap((c) => [c.id, ...c.contracts.map((k) => `${c.id}:${k.id}`)]))}>{opened.length ? l("Tout réduire", "Collapse all") : l("Tout ouvrir", "Expand all")}</button>
        <button className="btn" onClick={() => pick(rows.map((r) => r.id), sel.length !== rows.length)}>{sel.length === rows.length && rows.length ? l("Tout désélectionner", "Select none") : l("Tout sélectionner", "Select all")}</button>
      </div>
      {msg && <p role="status" className="mb-3 text-sm text-muted">{msg}</p>}
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {manage && sel.length > 0 && f.tab !== "invoiced" && (
        <div className="glass mb-3 flex flex-wrap items-center gap-2 p-3 text-sm"><span>{sel.length} {l("sélectionné(s)", "selected")} · {money(selTotal, loc)}</span>
          {f.tab !== "approved" && <button className="btn" onClick={() => void decide(sel, "approve")}><Check size={14} color="var(--ok)" />{l("Approuver", "Approve")}</button>}
          {f.tab !== "excluded" && <><button className="btn" onClick={() => void decide(sel, "exclude", "billed")}><X size={14} color="var(--danger)" />{l("Exclure : déjà facturé", "Exclude: already invoiced")}</button><button className="btn" onClick={() => void decide(sel, "exclude", "aside")}>{l("Mettre de côté", "Set aside")}</button></>}
          {f.tab !== "pending" && <button className="btn" onClick={() => void decide(sel, "restore")}><RotateCcw size={14} />{l("Remettre à approuver", "Back to approve")}</button>}</div>)}

      {!clients.length ? <div className="glass"><Empty>{l("Rien dans cette période.", "Nothing in this period.")}</Empty></div> : (
        <div className="space-y-3">{clients.map((c) => {
          const open = opened.includes(c.id);
          const ids = c.items.map((i) => i.id);
          return (
            <section key={c.id} className="glass p-2">
              <div className="flex items-center gap-2 px-2 py-2">
                {manage && f.tab !== "invoiced" && <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={ids.every((i) => sel.includes(i))} onChange={(e) => pick(ids, e.target.checked)} aria-label="select client" />}
                <button className="flex flex-1 items-center gap-2 text-left" onClick={() => toggle(c.id)} aria-expanded={open}>{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="font-medium">{c.name}</span></button>
                <span className="text-xs text-muted">{c.items.length} {l("ligne(s)", "line(s)")}</span><span className="text-sm font-medium">{money(c.items.reduce((a, i) => a + tot(i), 0), loc)}</span>
              </div>
              {open && c.contracts.map((k) => {
                const key = `${c.id}:${k.id}`;
                const kopen = !k.id || opened.includes(key);
                return (
                  <div key={key} className="ml-4 border-l border-white/10 pl-3">
                    {k.id && <button className="flex w-full items-center gap-2 py-1.5 text-left text-sm text-muted" onClick={() => toggle(key)}>{kopen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{k.name}<span className="ml-auto text-xs">{k.items.length} · {money(k.items.reduce((a, i) => a + tot(i), 0), loc)}</span></button>}
                    {kopen && (
                      <table className="grid"><thead><tr>{manage && f.tab !== "invoiced" && <th style={{ width: 32 }} />}<th>{l("Date", "Date")}</th><th>{l("Description", "Description")}</th><th>{l("Qté", "Qty")}</th><th>{l("Prix unitaire", "Unit price")}</th><th>{l("Montant", "Amount")}</th><th /></tr></thead>
                        <tbody>{k.items.map((i) => {
                          const editable = manage && f.tab !== "invoiced";
                          return (
                            <tr key={i.id}>{manage && f.tab !== "invoiced" && <td><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={sel.includes(i.id)} onChange={(e) => pick([i.id], e.target.checked)} aria-label="select" /></td>}
                              <td className="whitespace-nowrap text-muted">{fmtDate(i.workDate, loc)}</td>
                              <td><EditCell value={i.description} editable={editable} onSave={(v) => patch(i.id, { description: v })} /> <Chip>{i.source}</Chip>{i.excludedReason && i.status === "excluded" && <> <Chip tone="warn">{i.excludedReason === "billed" ? l("Déjà facturé", "Already invoiced") : l("Mis de côté", "Set aside")}</Chip></>}</td>
                              <td><EditCell value={String(i.quantity)} number editable={editable} onSave={(v) => patch(i.id, { quantity: Number(v) })} /></td>
                              <td><EditCell value={String(i.unitPrice)} number format={(v) => money(Number(v), loc)} editable={editable} onSave={(v) => patch(i.id, { unitPrice: Number(v) })} /></td>
                              <td>{money(tot(i), loc)}</td>
                              <td className="whitespace-nowrap text-right">{editable && <>
                                {f.tab === "pending" && <button className="btn !p-1.5" onClick={() => void decide([i.id], "approve")} aria-label="approve"><Check size={14} color="var(--ok)" /></button>}{" "}
                                {f.tab !== "excluded" && <button className="btn !p-1.5" onClick={() => void decide([i.id], "exclude", "aside")} aria-label="exclude"><X size={14} color="var(--danger)" /></button>}{" "}
                                {f.tab !== "pending" && <button className="btn !p-1.5" onClick={() => void decide([i.id], "restore")} aria-label="restore"><RotateCcw size={14} /></button>}</>}</td></tr>);
                        })}</tbody></table>)}
                  </div>);
              })}
            </section>);
        })}</div>)}

      {adding && <FormDialog title={l("Ligne à facturer", "Line to bill")} fields={fields} initial={{ quantity: 1, unitPrice: 0, workDate: from <= todayISO() && todayISO() <= to ? todayISO() : from }} onSubmit={async (v) => { await api("/api/accounting/billing-items", { body: { clientId: v.clientId, description: v.description, quantity: Number(v.quantity), unitPrice: Number(v.unitPrice), workDate: v.workDate || null } }); await refresh(); }} onClose={() => setAdding(false)} />}
      {invoicing && <ItemsToInvoice from={from} to={to} onClose={() => setInvoicing(false)} onDone={refresh} />}
    </>
  );
}

/** A value edited in place: nothing is applied until the check (or Enter); the cross (or Escape) puts it back. */
function EditCell({ value, editable, number, format, onSave }: { value: string; editable: boolean; number?: boolean; format?: (v: string) => string; onSave: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState<string | null>(null);
  if (v === null) return <span className={editable ? "group inline-flex cursor-text items-center gap-1" : ""} onClick={() => editable && setV(value)}>{format ? format(value) : value}{editable && <Pencil size={11} className="opacity-0 group-hover:opacity-60" />}</span>;
  const commit = async () => { await onSave(v); setV(null); };
  return (
    <span className="inline-flex items-center gap-1">
      <input className="input !w-auto !py-1" autoFocus type={number ? "number" : "text"} step={number ? "0.01" : undefined} value={v} style={{ minWidth: number ? 90 : 220 }} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void commit(); if (e.key === "Escape") setV(null); }} />
      <button className="btn !p-1" onClick={() => void commit()} aria-label="apply"><Check size={13} color="var(--ok)" /></button><button className="btn !p-1" onClick={() => setV(null)} aria-label="cancel"><X size={13} color="var(--danger)" /></button>
    </span>
  );
}

interface Prev { clientId: string; name: string; count: number; subtotal: number; gst: number; qst: number; total: number; dueDate: string; poRequired: boolean; defaultNotes: string }
/** Draft invoices from the approved lines of the time frame: one per client, with date, due day, PO number and notes. */
function ItemsToInvoice({ from, to, onClose, onDone }: { from: string; to: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const l = useL();
  const loc = useLocale();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["invoice-preview", from, to], queryFn: () => api<{ clients: Prev[]; skipped: { clientId: string; name: string; reason: string }[] }>("/api/accounting/invoices/from-items", { body: { from, to, preview: true } }) });
  const [o, setO] = useState<Record<string, { issueDate?: string; dueDate?: string; poNumber?: string; notes?: string }>>({});
  const [error, setError] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const set = (id: string, p: object) => setO({ ...o, [id]: { ...o[id], ...p } });
  const rows = (q.data?.clients ?? []).concat();
  const blocked = (q.data?.skipped ?? []).map((s) => s.clientId);
  const all = [...rows, ...(q.data?.skipped ?? []).map((s) => ({ clientId: s.clientId, name: s.name, count: 0, subtotal: 0, gst: 0, qst: 0, total: 0, dueDate: "", poRequired: true, defaultNotes: "" }))];
  const create = async () => {
    setError("");
    try {
      const r = await api<{ created: string[]; skipped: { name: string }[] }>("/api/accounting/invoices/from-items", { body: { from, to, clients: all.map((c) => ({ clientId: c.clientId, issueDate: o[c.clientId]?.issueDate || undefined, dueDate: o[c.clientId]?.dueDate || undefined, poNumber: o[c.clientId]?.poNumber || undefined, notes: o[c.clientId]?.notes ?? (c.defaultNotes || undefined) })) } });
      await onDone();
      if (r.skipped.length) setSkipped(r.skipped.map((s) => s.name));
      else { onClose(); nav(r.created.length === 1 ? `/accounting/invoices?open=${r.created[0]}` : "/accounting/invoices"); }
    } catch (e) { setError(errMsg(e, "Error")); }
  };
  void blocked;
  return (
    <Modal title={l("Facturer le travail approuvé", "Invoice approved work")} onClose={onClose} wide>
      <p className="mb-3 text-xs text-muted">{l(`Seules les lignes approuvées du ${fmtDate(from, loc)} au ${fmtDate(to, loc)} sont facturées. L'échéance part du jour où la facture est envoyée (+ délai du client + 1 jour).`, `Only approved lines from ${fmtDate(from, loc)} to ${fmtDate(to, loc)} are invoiced. The due day counts from the day the invoice is sent (+ client terms + 1 day).`)}</p>
      {!all.length ? <Empty>{l("Aucune ligne approuvée dans cette période.", "No approved lines in this period.")}</Empty> : (
        <div className="space-y-3">{all.map((c) => (
          <div key={c.clientId} className="glass-flat p-3">
            <div className="mb-2 flex items-center justify-between"><b>{c.name}</b><span className="text-sm">{c.count} {l("ligne(s)", "line(s)")} · <b>{money(c.total, loc)}</b> <span className="text-xs text-muted">({l("taxes incluses", "taxes included")})</span></span></div>
            <div className="grid gap-2 sm:grid-cols-4">
              <label><span className="label">{l("Date de la facture", "Invoice date")}</span><input className="input" type="date" value={o[c.clientId]?.issueDate ?? ""} onChange={(e) => set(c.clientId, { issueDate: e.target.value })} /></label>
              <label><span className="label">{l("Échéance exacte (option)", "Exact due date (optional)")}</span><input className="input" type="date" value={o[c.clientId]?.dueDate ?? ""} onChange={(e) => set(c.clientId, { dueDate: e.target.value })} /></label>
              <label><span className="label">{l("# bon de commande", "PO number")}{c.poRequired && " *"}</span><input className="input" value={o[c.clientId]?.poNumber ?? ""} onChange={(e) => set(c.clientId, { poNumber: e.target.value })} /></label>
              <label><span className="label">{l("Notes", "Notes")}</span><input className="input" value={o[c.clientId]?.notes ?? c.defaultNotes} onChange={(e) => set(c.clientId, { notes: e.target.value })} /></label>
            </div>
            {c.dueDate && <p className="mt-1 text-xs text-muted">{l("Échéance prévue si envoyée aujourd'hui", "Due day if sent today")}: {fmtDate(c.dueDate, loc)}</p>}
          </div>))}</div>)}
      {skipped.length > 0 && <p role="alert" className="mt-3 text-sm text-warn">{l("Sans numéro de bon de commande (requis), non facturé :", "No PO number (required), not invoiced:")} {skipped.join(", ")}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button><button className="btn btn-primary" disabled={!all.length} onClick={() => void create()}>{l("Créer les factures", "Create the invoices")}</button></div>
    </Modal>
  );
}
