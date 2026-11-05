import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, Mail, Pencil, Plus, Printer, Trash2 } from "lucide-react";
import { computeInvoice } from "@nexo/shared/billing";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useBranding } from "../../lib/theme";
import { fmtDate, money, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, errMsg, useClients } from "../../components/kit";
import { Modal } from "../../components/ui";

interface Line { description: string; quantity: number; unitPrice: number; taxable: boolean; billingItemId?: string | null; contractName?: string | null; amount?: number }
interface Pay { id: string; paidOn: string; amountCents: number; method: string; reference: string; note: string; byName: string | null }
interface Detail {
  id: string; number: string; clientId: string; clientName: string; status: "draft" | "sent" | "paid" | "void"; view: string; issueDate: string; dueDate: string; sentAt: string | null; total: number; subtotal: number; gst: number; qst: number;
  notes: string; poNumber: string; emailedAt: string | null; paid: number; balance: number; lines: Line[]; payments: Pay[]; rates: { gst: number; qst: number };
  address: string; city: string; province: string; postalCode: string; billingEmail: string; clientEmail: string;
}

export const viewTone = (v: string) => (v === "paid" ? "ok" : v === "overdue" ? "danger" : v === "partial" || v === "open" ? "warn" : "off") as "ok" | "warn" | "danger" | "off";
export const viewLabel = (v: string, l: (a: string, b: string) => string) => ({ draft: l("Brouillon", "Draft"), open: l("Envoyée", "Sent"), overdue: l("En retard", "Overdue"), partial: l("Partielle", "Partial"), paid: l("Payée", "Paid"), voided: l("Annulée", "Voided") }[v] ?? v);

function codeText(code: string, l: (a: string, b: string) => string) {
  const m: Record<string, [string, string]> = {
    invoice_has_payments: ["Une facture avec des paiements ne peut pas être annulée : retirez d'abord les paiements.", "An invoice with payments cannot be voided: remove the payments first."],
    payment_exceeds_balance: ["Le paiement dépasse le solde.", "The payment is more than the balance."], invoice_not_sent: ["Envoyez la facture avant d'enregistrer un paiement.", "Send the invoice before recording a payment."],
  };
  return m[code] ? l(...m[code]!) : code;
}

export function InvoiceDialog({ id, onClose, onChanged, onStatement }: { id: string | null; onClose: () => void; onChanged: () => Promise<void>; onStatement: (clientId: string) => void }) {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const brand = useBranding();
  const clients = useClients();
  const detail = useQuery({ queryKey: ["invoice", id], queryFn: () => api<Detail>(`/api/accounting/invoices/${id}`), enabled: Boolean(id) });
  const settings = useQuery({ queryKey: ["acct-settings"], queryFn: () => api<{ gst: number; qst: number }>("/api/accounting/settings") });
  const [clientId, setClientId] = useState("");
  const [lines, setLines] = useState<Line[] | null>(null);
  const [issueDate, setIssueDate] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [po, setPo] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [pay, setPay] = useState<null | { amount: string; method: string; reference: string; paidOn: string }>(null);
  const [error, setError] = useState("");
  const d = detail.data;
  useEffect(() => { setLines(null); setSheet(false); }, [id]);
  if (id && !d) return null;

  const draft = !d || d.status === "draft";
  const rows = lines ?? d?.lines ?? [{ description: "", quantity: 1, unitPrice: 0, taxable: true }];
  const rates = d?.rates ?? settings.data ?? { gst: 5, qst: 9.975 };
  const calc = computeInvoice(rows.map((r) => ({ quantity: Number(r.quantity) || 0, unitPrice: Number(r.unitPrice) || 0, taxable: r.taxable })), rates);
  const setRow = (i: number, patch: Partial<Line>) => setLines(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const manage = can("accounting.invoices.manage");
  const showSheet = sheet || (d && d.status !== "draft");
  const refreshAll = async () => { await onChanged(); await detail.refetch(); };
  const run = async (fn: () => Promise<unknown>, close = false) => { setError(""); try { await fn(); await refreshAll(); if (close) onClose(); } catch (e) { setError(codeText(errMsg(e, "Error"), l)); } };

  const save = () => run(async () => {
    const payload = { lines: rows.filter((r) => r.description.trim()).map((r) => ({ description: r.description, quantity: Number(r.quantity), unitPrice: Number(r.unitPrice), taxable: r.taxable, billingItemId: r.billingItemId ?? null })), issueDate: issueDate ?? d?.issueDate, dueDate: dueDate ?? d?.dueDate, poNumber: po ?? d?.poNumber ?? "", notes: notes ?? d?.notes };
    if (id) await api(`/api/accounting/invoices/${id}`, { method: "PUT", body: payload }); else await api("/api/accounting/invoices", { body: { clientId, ...payload } });
  }, true);
  const action = (a: "send" | "pay" | "void") => run(() => api(`/api/accounting/invoices/${id}/action`, { body: { action: a } }), a === "void");

  return (
    <Modal title={d ? `${l("Facture", "Invoice")} ${d.number}` : l("Nouvelle facture", "New invoice")} onClose={onClose} wide>
      {d && <div className="mb-3 flex flex-wrap items-center gap-2"><Chip tone={viewTone(d.view)}>{viewLabel(d.view, l)}</Chip>{d.status !== "draft" && d.view !== "paid" && d.view !== "voided" && <span className="text-sm">{l("Solde", "Balance")}: <b>{money(d.balance, loc)}</b></span>}
        <div className="flex-1" />
        {d.status === "draft" && <button className="btn !py-1 text-xs" onClick={() => setSheet(!sheet)}>{sheet ? <><Pencil size={13} />{l("Modifier", "Edit")}</> : <><Eye size={13} />{l("Aperçu", "Preview")}</>}</button>}
        {manage && d.status !== "draft" && d.status !== "void" && <button className="btn !py-1 text-xs" onClick={() => void run(() => api(`/api/accounting/invoices/${id}/emailed`, { body: { emailed: !d.emailedAt } }))}><Mail size={13} color={d.emailedAt ? "var(--ok)" : undefined} />{d.emailedAt ? l("Marquée envoyée par courriel", "Marked as emailed") : l("Marquer envoyée par courriel", "Mark as emailed")}</button>}
        <button className="btn !py-1 text-xs" onClick={() => onStatement(d.clientId)}>{l("Relevé du client", "Client statement")}</button></div>}

      {showSheet && d ? (
        <div id="print-area" className="invoice-sheet rounded-xl bg-white p-6 text-sm text-neutral-900">
          <div className="mb-4 flex items-start justify-between">
            <div><div className="text-xl font-bold">{brand.appName}</div><div className="text-xs text-neutral-500">{l("Facture", "Invoice")}</div></div>
            <div className="rounded-lg border border-neutral-300 p-3 text-right text-xs"><div className="text-neutral-500">{l("Date", "Date")}</div><div className="font-semibold">{fmtDate(d.issueDate, loc)}</div><div className="mt-1 text-neutral-500"># {l("facture", "invoice")}</div><div className="font-semibold">{d.number}</div></div>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-neutral-300 p-3"><div className="mb-1 text-xs text-neutral-500">{l("Facturé à", "Bill to")}</div><div className="font-semibold">{d.clientName}</div><div className="text-xs">{[d.address, d.city, d.province, d.postalCode].filter(Boolean).join(", ")}</div></div>
            <div className="rounded-lg border border-neutral-300 p-3 text-xs"><div className="flex justify-between"><span className="text-neutral-500">{l("Paiement dû", "Payment due")}</span><b>{fmtDate(d.dueDate, loc)}</b></div>{d.poNumber && <div className="flex justify-between"><span className="text-neutral-500">{l("Bon de commande", "PO number")}</span><b>{d.poNumber}</b></div>}</div>
          </div>
          <table className="w-full border-collapse text-xs"><thead><tr className="border-b-2 border-neutral-800 text-left"><th className="py-1.5">{l("Description", "Description")}</th><th className="text-right">{l("Qté", "Qty")}</th><th className="text-right">{l("Taux", "Rate")}</th><th className="text-right">{l("Montant", "Amount")}</th></tr></thead>
            <tbody>{d.lines.map((r, i) => <tr key={i} className="border-b border-neutral-200"><td className="py-1.5">{r.description}{r.contractName && <div className="text-neutral-500">{r.contractName}</div>}</td><td className="text-right">{r.quantity}</td><td className="text-right">{money(r.unitPrice, loc)}</td><td className="text-right">{money(r.amount, loc)}</td></tr>)}</tbody></table>
          <div className="ml-auto mt-3 w-64 space-y-1 text-xs">
            <div className="flex justify-between"><span>{l("Sous-total", "Subtotal")}</span><span>{money(d.subtotal, loc)}</span></div><div className="flex justify-between"><span>TPS/GST ({d.rates.gst}%)</span><span>{money(d.gst, loc)}</span></div><div className="flex justify-between"><span>TVQ/QST ({d.rates.qst}%)</span><span>{money(d.qst, loc)}</span></div>
            <div className="flex justify-between border-t border-neutral-800 pt-1 text-sm font-bold"><span>Total</span><span>{money(d.total, loc)}</span></div>
            {d.paid > 0 && <div className="flex justify-between"><span>{l("Payé", "Paid")}</span><span>−{money(d.paid, loc)}</span></div>}
            {d.paid > 0 && <div className="flex justify-between font-bold"><span>{l("Solde dû", "Balance due")}</span><span>{money(d.balance, loc)}</span></div>}
          </div>
          {d.notes && <p className="mt-4 whitespace-pre-wrap text-xs text-neutral-600">{d.notes}</p>}
        </div>
      ) : (
        <>
          <div className="mb-4 grid gap-x-4 sm:grid-cols-4">
            <label className="mb-3"><span className="label">Client</span>{d ? <div className="py-2 text-sm font-medium">{d.clientName}</div> : <select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</label>
            <label className="mb-3"><span className="label">{l("Date d'émission", "Issue date")}</span><input className="input" type="date" value={issueDate ?? d?.issueDate ?? todayISO()} onChange={(e) => setIssueDate(e.target.value)} /></label>
            <label className="mb-3"><span className="label">{l("Échéance", "Due date")}</span><input className="input" type="date" value={dueDate ?? d?.dueDate ?? ""} onChange={(e) => setDueDate(e.target.value)} /></label>
            <label className="mb-3"><span className="label">{l("# bon de commande", "PO number")}</span><input className="input" value={po ?? d?.poNumber ?? ""} onChange={(e) => setPo(e.target.value)} /></label>
          </div>
          {d && <p className="-mt-2 mb-3 text-xs text-muted">{l("L'échéance se recalcule à l'envoi (jour d'envoi + délai du client + 1 jour), sauf si vous la modifiez ici.", "The due day is recalculated on sending (send day + client terms + 1 day), unless you change it here.")}</p>}
          <div className="overflow-x-auto"><table className="grid"><thead><tr><th>{l("Description", "Description")}</th><th style={{ width: 80 }}>{l("Qté", "Qty")}</th><th style={{ width: 110 }}>{l("Prix unitaire", "Unit price")}</th><th style={{ width: 60 }}>{l("Taxable", "Tax")}</th><th style={{ width: 100 }} className="text-right">{l("Montant", "Amount")}</th><th style={{ width: 36 }} /></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}>
                <td><input className="input" value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} /></td>
                <td><input className="input" type="number" step="0.01" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value as unknown as number })} /></td>
                <td><input className="input" type="number" step="0.01" value={r.unitPrice} onChange={(e) => setRow(i, { unitPrice: e.target.value as unknown as number })} /></td>
                <td className="text-center"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={r.taxable} onChange={(e) => setRow(i, { taxable: e.target.checked })} /></td>
                <td className="text-right">{money(calc.lines[i]?.amount, loc)}</td>
                <td>{rows.length > 1 && <button className="text-muted hover:text-danger" onClick={() => setLines(rows.filter((_, j) => j !== i))} aria-label="remove"><Trash2 size={14} /></button>}</td>
              </tr>))}</tbody></table></div>
          <button className="btn mt-2" onClick={() => setLines([...rows, { description: "", quantity: 1, unitPrice: 0, taxable: true }])}><Plus size={14} />{l("Ligne", "Line")}</button>
          <div className="ml-auto mt-4 w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted">{l("Sous-total", "Subtotal")}</span><span>{money(calc.subtotal, loc)}</span></div>
            <div className="flex justify-between"><span className="text-muted">TPS/GST ({rates.gst}%)</span><span>{money(calc.gst, loc)}</span></div>
            <div className="flex justify-between"><span className="text-muted">TVQ/QST ({rates.qst}%)</span><span>{money(calc.qst, loc)}</span></div>
            <div className="flex justify-between border-t border-white/15 pt-1 text-base font-semibold"><span>Total</span><span>{money(calc.total, loc)}</span></div>
          </div>
          <label className="mb-4 mt-4 block"><span className="label">Notes</span><textarea className="input" rows={2} value={notes ?? d?.notes ?? ""} onChange={(e) => setNotes(e.target.value)} /></label>
        </>
      )}

      {d && d.status !== "draft" && d.status !== "void" && (
        <section className="glass-flat mt-4 p-3">
          <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">{l("Paiements", "Payments")}</h3>
            {manage && d.balance > 0 && <button className="btn !py-1 text-xs" onClick={() => setPay({ amount: String(d.balance), method: "cheque", reference: "", paidOn: todayISO() })}><Plus size={13} />{l("Paiement", "Payment")}</button>}</div>
          {!d.payments.length ? <p className="text-xs text-muted">{l("Aucun paiement.", "No payments.")}</p> : (
            <table className="grid"><tbody>{d.payments.map((p) => (
              <tr key={p.id}><td>{fmtDate(p.paidOn, loc)}</td><td>{money(p.amountCents / 100, loc)}</td><td className="text-muted">{p.method}{p.reference ? ` · ${p.reference}` : ""}</td><td className="text-xs text-muted">{p.byName}</td>
                <td className="text-right">{manage && <button className="btn btn-danger !p-1.5" aria-label="remove payment" onClick={() => { if (window.confirm(l("Retirer ce paiement ?", "Remove this payment?"))) void run(() => api(`/api/accounting/invoices/${d.id}/payments/${p.id}`, { method: "DELETE" })); }}><Trash2 size={13} /></button>}</td></tr>))}</tbody></table>)}
          {pay && (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label><span className="label">{l("Montant", "Amount")}</span><input className="input !w-28" type="number" step="0.01" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></label>
              <label><span className="label">{l("Date", "Date")}</span><input className="input" type="date" value={pay.paidOn} onChange={(e) => setPay({ ...pay, paidOn: e.target.value })} /></label>
              <label><span className="label">{l("Mode", "Method")}</span><select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="cheque">{l("Chèque", "Cheque")}</option><option value="transfer">{l("Virement", "Transfer")}</option><option value="card">{l("Carte", "Card")}</option><option value="cash">{l("Comptant", "Cash")}</option><option value="other">{l("Autre", "Other")}</option></select></label>
              <label className="min-w-[140px] flex-1"><span className="label">{l("Référence", "Reference")}</span><input className="input" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></label>
              <button className="btn btn-primary" onClick={() => void run(async () => { await api(`/api/accounting/invoices/${d.id}/payments`, { body: { amount: Number(pay.amount), paidOn: pay.paidOn, method: pay.method, reference: pay.reference } }); setPay(null); })}>{l("Enregistrer", "Record")}</button>
              <button className="btn" onClick={() => setPay(null)}>{l("Annuler", "Cancel")}</button>
            </div>)}
        </section>)}

      {error && <p role="alert" className="mb-3 mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {d && <button className="btn" onClick={() => window.print()}><Printer size={15} />{l("Imprimer / PDF", "Print / PDF")}</button>}
          {d && manage && d.paid === 0 && (d.status === "draft" || d.status === "sent") && <button className="btn btn-danger" onClick={() => { if (window.confirm(l("Annuler cette facture ? Le travail sera remis à facturer.", "Void this invoice? The work goes back to be billed."))) void action("void"); }}>{l("Annuler la facture", "Void")}</button>}
        </div>
        <div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button>
          {draft && !sheet && <button className="btn" disabled={!d && !clientId} onClick={() => void save()}>{l("Enregistrer", "Save")}</button>}
          {d && manage && d.status === "draft" && <button className="btn btn-primary" onClick={() => void action("send")}>{l("Envoyer (finaliser)", "Send (finalize)")}</button>}</div>
      </div>
      <p className="mt-3 text-xs text-muted">{l("L'envoi par courriel, le PDF serveur et la synchronisation QuickBooks arrivent avec les intégrations Mailjet et QuickBooks.", "Emailing, server PDF and QuickBooks sync arrive with the Mailjet and QuickBooks integrations.")}</p>
    </Modal>
  );
}
