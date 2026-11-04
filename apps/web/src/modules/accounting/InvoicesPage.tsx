import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Printer, Trash2 } from "lucide-react";
import { computeInvoice } from "@nexo/shared/billing";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, Toolbar, useClients } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

interface Inv { id: string; number: string; clientId: string; clientName: string; status: "draft" | "sent" | "paid" | "void"; issueDate: string; dueDate: string; total: number }
interface Line { description: string; quantity: number; unitPrice: number; taxable: boolean; billingItemId?: string | null }
interface Detail extends Inv { notes: string; subtotal: number; gst: number; qst: number; lines: Line[]; rates: { gst: number; qst: number }; address: string; city: string; province: string; postalCode: string }

const tone = (s: string) => (s === "paid" ? "ok" : s === "void" ? "off" : s === "sent" ? "warn" : "off") as "ok" | "warn" | "off";

export default function InvoicesPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | "new" | null>(null);
  const [params, setParams] = useSearchParams();
  const list = useQuery({ queryKey: ["invoices", status], queryFn: () => api<Inv[]>(`/api/accounting/invoices${status ? `?status=${status}` : ""}`) });
  useEffect(() => { const o = params.get("open"); if (o) { setOpen(o); setParams({}, { replace: true }); } }, [params, setParams]);
  const statusLabel = (s: string) => ({ draft: l("Brouillon", "Draft"), sent: l("Envoyée", "Sent"), paid: l("Payée", "Paid"), void: l("Annulée", "Void") }[s] ?? s);
  const sum = (xs: Inv[]) => xs.reduce((a, i) => a + i.total, 0);
  const rows = list.data ?? [];

  return (
    <>
      <PageHeader title={l("Factures", "Invoices")} subtitle={l("Factures aux clients", "Customer invoices")}
        actions={can("accounting.invoices.edit", "accounting.invoices.manage") && <button className="btn btn-primary" onClick={() => setOpen("new")}><Plus size={16} />{l("Nouvelle facture", "New invoice")}</button>} />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="glass p-4"><div className="text-xs text-muted">{l("À recevoir (envoyées)", "Receivable (sent)")}</div><div className="mt-1 text-2xl font-semibold">{money(sum(rows.filter((i) => i.status === "sent")), loc)}</div></div>
        <div className="glass p-4"><div className="text-xs text-muted">{l("En retard", "Overdue")}</div><div className="mt-1 text-2xl font-semibold text-danger">{money(sum(rows.filter((i) => i.status === "sent" && i.dueDate < todayISO())), loc)}</div></div>
        <div className="glass p-4"><div className="text-xs text-muted">{l("Brouillons", "Drafts")}</div><div className="mt-1 text-2xl font-semibold">{rows.filter((i) => i.status === "draft").length}</div></div>
      </div>
      <Toolbar><select className="input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="status"><option value="">{l("Tous les statuts", "All statuses")}</option><option value="draft">{l("Brouillons", "Drafts")}</option><option value="sent">{l("Envoyées", "Sent")}</option><option value="paid">{l("Payées", "Paid")}</option><option value="void">{l("Annulées", "Void")}</option></select></Toolbar>
      <div className="glass overflow-x-auto p-2">
        {rows.length === 0 ? <Empty>{l("Aucune facture.", "No invoices.")}</Empty> : (
          <table className="grid"><thead><tr><th>#</th><th>Client</th><th>{l("Émise", "Issued")}</th><th>{l("Échéance", "Due")}</th><th>Total</th><th>{l("Statut", "Status")}</th></tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id} className="cursor-pointer" onClick={() => setOpen(i.id)}><td className="font-medium">{i.number}</td><td>{i.clientName}</td><td className="text-muted">{fmtDate(i.issueDate, loc)}</td>
                <td style={{ color: i.status === "sent" && i.dueDate < todayISO() ? "var(--danger)" : undefined }}>{fmtDate(i.dueDate, loc)}</td><td>{money(i.total, loc)}</td><td><Chip tone={tone(i.status)}>{statusLabel(i.status)}</Chip></td></tr>))}</tbody></table>)}
      </div>
      {open && <InvoiceDialog id={open === "new" ? null : open} onClose={() => setOpen(null)} onChanged={async () => { await qc.invalidateQueries({ queryKey: ["invoices"] }); await qc.invalidateQueries({ queryKey: ["billing-items"] }); }} />}
    </>
  );
}

function InvoiceDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => Promise<void> }) {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const clients = useClients();
  const detail = useQuery({ queryKey: ["invoice", id], queryFn: () => api<Detail>(`/api/accounting/invoices/${id}`), enabled: Boolean(id) });
  const settings = useQuery({ queryKey: ["acct-settings"], queryFn: () => api<{ gst: number; qst: number }>("/api/accounting/settings") });
  const [clientId, setClientId] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [issueDate, setIssueDate] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState("");
  const d = detail.data;
  useEffect(() => { setLines(null); }, [id]);
  if (id && !d) return null;

  const draft = !d || d.status === "draft";
  const rows = lines ?? d?.lines ?? [{ description: "", quantity: 1, unitPrice: 0, taxable: true }];
  const calc = computeInvoice(rows.map((r) => ({ quantity: Number(r.quantity) || 0, unitPrice: Number(r.unitPrice) || 0, taxable: r.taxable })), d?.rates ?? settings.data ?? { gst: 5, qst: 9.975 });
  const setRow = (i: number, patch: Partial<Line>) => setLines(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const manage = can("accounting.invoices.manage");

  const save = async () => {
    try {
      const payload = { lines: rows.filter((r) => r.description.trim()).map((r) => ({ description: r.description, quantity: Number(r.quantity), unitPrice: Number(r.unitPrice), taxable: r.taxable, billingItemId: r.billingItemId ?? null })), issueDate: issueDate ?? d?.issueDate, dueDate: dueDate ?? d?.dueDate, notes: notes ?? d?.notes };
      if (id) await api(`/api/accounting/invoices/${id}`, { method: "PUT", body: payload }); else await api("/api/accounting/invoices", { body: { clientId, ...payload } });
      await onChanged(); onClose();
    } catch (e) { setError(errMsg(e, "Error")); }
  };
  const action = async (a: "send" | "pay" | "void") => { try { await api(`/api/accounting/invoices/${id}/action`, { body: { action: a } }); await onChanged(); onClose(); } catch (e) { setError(errMsg(e, "Error")); } };

  return (
    <Modal title={d ? `${l("Facture", "Invoice")} ${d.number}` : l("Nouvelle facture", "New invoice")} onClose={onClose} wide>
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <label className="mb-3"><span className="label">Client</span>{d ? <div className="py-2 text-sm font-medium">{d.clientName}</div> : <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</label>
        <label className="mb-3"><span className="label">{l("Date d'émission", "Issue date")}</span><input className="input" type="date" disabled={!draft} value={issueDate ?? d?.issueDate ?? todayISO()} onChange={(e) => setIssueDate(e.target.value)} /></label>
        <label className="mb-3"><span className="label">{l("Échéance", "Due date")}</span><input className="input" type="date" disabled={!draft} value={dueDate ?? d?.dueDate ?? ""} onChange={(e) => setDueDate(e.target.value)} /></label>
      </div>
      <div className="overflow-x-auto"><table className="grid"><thead><tr><th>{l("Description", "Description")}</th><th style={{ width: 80 }}>{l("Qté", "Qty")}</th><th style={{ width: 110 }}>{l("Prix unitaire", "Unit price")}</th><th style={{ width: 60 }}>{l("Taxable", "Tax")}</th><th style={{ width: 100 }} className="text-right">{l("Montant", "Amount")}</th><th style={{ width: 36 }} /></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>
            <td><input className="input" disabled={!draft} value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} /></td>
            <td><input className="input" type="number" step="0.01" disabled={!draft} value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value as unknown as number })} /></td>
            <td><input className="input" type="number" step="0.01" disabled={!draft} value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: e.target.value as unknown as number })} /></td>
            <td className="text-center"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={!draft} checked={r.taxable} onChange={(e) => setRow(i, { taxable: e.target.checked })} /></td>
            <td className="text-right">{money(calc.lines[i]?.amount, loc)}</td>
            <td>{draft && rows.length > 1 && <button className="text-muted hover:text-danger" onClick={() => setLines(rows.filter((_, j) => j !== i))} aria-label="remove"><Trash2 size={14} /></button>}</td>
          </tr>))}</tbody></table></div>
      {draft && <button className="btn mt-2" onClick={() => setLines([...rows, { description: "", quantity: 1, unitPrice: 0, taxable: true }])}><Plus size={14} />{l("Ligne", "Line")}</button>}
      <div className="mt-4 ml-auto w-full max-w-xs space-y-1 text-sm">
        <div className="flex justify-between"><span className="text-muted">{l("Sous-total", "Subtotal")}</span><span>{money(calc.subtotal, loc)}</span></div>
        <div className="flex justify-between"><span className="text-muted">TPS/GST ({(d?.rates ?? settings.data)?.gst}%)</span><span>{money(calc.gst, loc)}</span></div>
        <div className="flex justify-between"><span className="text-muted">TVQ/QST ({(d?.rates ?? settings.data)?.qst}%)</span><span>{money(calc.qst, loc)}</span></div>
        <div className="flex justify-between border-t border-white/15 pt-1 text-base font-semibold"><span>Total</span><span>{money(calc.total, loc)}</span></div>
      </div>
      <label className="mb-4 mt-4 block"><span className="label">Notes</span><textarea className="input" rows={2} disabled={!draft} value={notes ?? d?.notes ?? ""} onChange={(e) => setNotes(e.target.value)} /></label>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {d && <button className="btn" onClick={() => window.print()}><Printer size={15} />{l("Imprimer / PDF", "Print / PDF")}</button>}
          {d && manage && d.status === "sent" && <button className="btn" onClick={() => void action("pay")}>{l("Marquer payée", "Mark paid")}</button>}
          {d && manage && (d.status === "draft" || d.status === "sent") && <button className="btn btn-danger" onClick={() => { if (window.confirm(l("Annuler cette facture ? Le travail sera remis à facturer.", "Void this invoice? The work goes back to be billed."))) void action("void"); }}>{l("Annuler la facture", "Void")}</button>}
        </div>
        <div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button>
          {draft && <button className="btn" disabled={!d && !clientId} onClick={() => void save()}>{l("Enregistrer", "Save")}</button>}
          {d && manage && d.status === "draft" && <button className="btn btn-primary" onClick={() => void action("send")}>{l("Envoyer (finaliser)", "Send (finalize)")}</button>}</div>
      </div>
      <p className="mt-3 text-xs text-muted">{l("L'envoi par courriel et la synchronisation QuickBooks arrivent avec les intégrations Mailjet et QuickBooks.", "Emailing and QuickBooks sync arrive with the Mailjet and QuickBooks integrations.")}</p>
    </Modal>
  );
}
