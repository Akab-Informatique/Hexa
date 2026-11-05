import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Mail, Plus, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, Stat, Toolbar, useClients } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import { InvoiceDialog, viewLabel, viewTone } from "./InvoiceDialog";
import { StatementDialog } from "./Statement";

interface Inv { id: string; number: string; clientId: string; clientName: string; status: string; view: string; issueDate: string; dueDate: string; total: number; paid: number; balance: number; poNumber: string; emailedAt: string | null }
interface Page { rows: Inv[]; total: number; page: number; size: number; totals: { amount: number; balance: number } }

/** All invoices: filters, sorts and paging kept in the address (so a view can be shared or bookmarked). */
export default function InvoicesPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const clients = useClients();
  const [sp, setSp] = useSearchParams();
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [statementFor, setStatementFor] = useState<string | null>(null);
  const get = (k: string, d = "") => sp.get(k) ?? d;
  const set = (patch: Record<string, string | null>, keepPage = false) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") n.delete(k); else n.set(k, v); } if (!keepPage) n.delete("page"); setSp(n, { replace: true }); };
  const status = get("istatus", "open"), client = get("iclient"), from = get("ifrom"), to = get("ito"), q = get("iq"), emailed = get("iemailed");
  const sort = get("isort", "number"), dir = get("idir", "desc"), page = Number(get("ipage", "1")), size = Number(get("isize", "25"));
  const qs = `page=${page}&size=${size}&sort=${sort}&dir=${dir}&status=${status === "all" ? "" : status}${client ? `&client=${client}` : ""}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}${emailed ? `&emailed=${emailed}` : ""}`;
  const list = useQuery({ queryKey: ["invoices", qs], queryFn: () => api<Page>(`/api/accounting/invoices?${qs}`) });
  // `open=<id>` links (from a client file or the approvals page) open that invoice.
  useEffect(() => { const o = sp.get("open"); if (o) { setOpen(o); set({ open: null }, true); } }); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / size));
  const today = todayISO();
  const sortBy = (k: string) => set(sort === k ? { idir: dir === "asc" ? "desc" : "asc" } : { isort: k, idir: k === "client" ? "asc" : "desc" });
  const th = (k: string, label: string) => <th><button className="inline-flex items-center gap-1" onClick={() => sortBy(k)}>{label}{sort === k && (dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>;
  const statuses: [string, string][] = [["open", l("Impayées", "Unpaid")], ["overdue", l("En retard", "Overdue")], ["due", l("Dues aujourd'hui", "Due today")], ["partial", l("Partielles", "Partial")], ["paid", l("Payées", "Paid")], ["draft", l("Brouillons", "Drafts")], ["voided", l("Annulées", "Voided")], ["all", l("Toutes", "All")]];

  return (
    <>
      <PageHeader title={l("Factures", "Invoices")} subtitle={l("Toutes les factures aux clients", "All customer invoices")}
        actions={<div className="flex gap-2">{client && <button className="btn" onClick={() => setStatementFor(client)}>{l("Relevé de compte", "Account statement")}</button>}{can("accounting.invoices.edit", "accounting.invoices.manage") && <button className="btn btn-primary" onClick={() => setOpen("new")}><Plus size={16} />{l("Nouvelle facture", "New invoice")}</button>}</div>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={l("Factures (filtre)", "Invoices (filter)")} value={list.data?.total ?? 0} /><Stat label={l("Montant", "Amount")} value={money(list.data?.totals.amount, loc)} />
        <Stat label={l("Solde à recevoir", "Balance receivable")} value={money(list.data?.totals.balance, loc)} tone={list.data?.totals.balance ? "warn" : undefined} />
      </div>
      <Toolbar>
        <div className="relative min-w-[200px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" /><input className="input !pl-9" placeholder={l("# facture ou bon de commande…", "Invoice # or PO number…")} value={q} onChange={(e) => set({ iq: e.target.value })} /></div>
        <select className="input !w-auto" value={status} onChange={(e) => set({ istatus: e.target.value === "open" ? null : e.target.value })} aria-label="status">{statuses.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>
        <select className="input !w-auto" value={client} onChange={(e) => set({ iclient: e.target.value })} aria-label="client"><option value="">{l("Tous les clients", "All clients")}</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input className="input !w-auto" type="date" value={from} onChange={(e) => set({ ifrom: e.target.value })} aria-label="from" title={l("Émise à partir du", "Issued from")} /><input className="input !w-auto" type="date" value={to} onChange={(e) => set({ ito: e.target.value })} aria-label="to" title={l("Émise jusqu'au", "Issued to")} />
        <select className="input !w-auto" value={emailed} onChange={(e) => set({ iemailed: e.target.value })} aria-label="emailed"><option value="">{l("Courriel : tous", "Emailed: any")}</option><option value="yes">{l("Envoyées par courriel", "Emailed")}</option><option value="no">{l("Pas envoyées", "Not emailed")}</option></select>
      </Toolbar>
      <div className="glass overflow-x-auto p-2">
        {rows.length === 0 ? <Empty>{l("Aucune facture pour ce filtre.", "No invoices for this filter.")}</Empty> : (
          <table className="grid"><thead><tr>{th("number", "#")}{th("client", l("Client", "Client"))}<th>{l("Bon de commande", "PO")}</th>{th("issued", l("Émise", "Issued"))}{th("due", l("Échéance", "Due"))}{th("total", "Total")}{th("balance", l("Solde", "Balance"))}<th>{l("Statut", "Status")}</th><th /></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id} className="cursor-pointer" onClick={() => setOpen(i.id)}><td className="font-medium">{i.number}</td><td>{i.clientName}</td><td className="text-muted">{i.poNumber || "—"}</td><td className="text-muted">{fmtDate(i.issueDate, loc)}</td>
                <td style={{ color: i.view === "overdue" ? "var(--danger)" : undefined }}>{fmtDate(i.dueDate, loc)}{i.view === "overdue" && <span className="ml-1 text-xs">({Math.round((Date.parse(today) - Date.parse(String(i.dueDate).slice(0, 10))) / 86_400_000)} j)</span>}</td>
                <td>{money(i.total, loc)}</td><td>{i.view === "paid" || i.view === "voided" || i.view === "draft" ? "—" : money(i.balance, loc)}</td>
                <td><Chip tone={viewTone(i.view)}>{viewLabel(i.view, l)}</Chip></td>
                <td title={i.emailedAt ? l("Envoyée par courriel", "Emailed") : l("Pas envoyée par courriel", "Not emailed")}><Mail size={14} color={i.emailedAt ? "var(--ok)" : undefined} className={i.emailedAt ? "" : "opacity-30"} /></td></tr>))}</tbody></table>)}
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs text-muted">
          <span>{list.data?.total ?? 0} {l("facture(s)", "invoice(s)")}</span>
          <div className="flex items-center gap-2">
            <select className="input !w-auto !py-1" value={size} onChange={(e) => set({ isize: e.target.value })} aria-label="page size">{[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <button className="btn !p-1.5" disabled={page <= 1} onClick={() => set({ ipage: String(page - 1) }, true)} aria-label="prev"><ChevronLeft size={14} /></button><span>{page} / {pages}</span><button className="btn !p-1.5" disabled={page >= pages} onClick={() => set({ ipage: String(page + 1) }, true)} aria-label="next"><ChevronRight size={14} /></button>
          </div>
        </div>
      </div>
      {open && <InvoiceDialog id={open === "new" ? null : open} onClose={() => setOpen(null)} onStatement={(cid) => { setOpen(null); setStatementFor(cid); }} onChanged={async () => { await qc.invalidateQueries({ queryKey: ["invoices"] }); await qc.invalidateQueries({ queryKey: ["billing-items"] }); await qc.invalidateQueries({ queryKey: ["billing-summary"] }); await qc.invalidateQueries({ queryKey: ["invoice"] }); }} />}
      {statementFor && <StatementDialog clientId={statementFor} onClose={() => setStatementFor(null)} />}
    </>
  );
}
