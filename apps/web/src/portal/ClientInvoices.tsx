import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtDate, money, useL, useLocale } from "../lib/l";
import { Chip, Empty, Stat, Tabs } from "../components/kit";
import { Modal, PageHeader } from "../components/ui";

interface Row { id: string; number: string; issueDate: string; dueDate: string; poNumber: string; total: string; paid: number; balance: number; view: string }
interface Detail {
  id: string; number: string; clientName: string; issueDate: string; dueDate: string; poNumber: string; notes: string; subtotal: string; gst: string; qst: string; total: string; paid: number; balance: number; view: string;
  address: string; city: string; province: string; postalCode: string;
  lines: { id: string; description: string; quantity: string; unitPrice: string; amount: string }[]; payments: { id: string; paidOn: string; amountCents: string; method: string; reference: string }[];
}
interface Statement { today: string; rows: { id: string; number: string; dueDate: string; total: number; balance: number; daysLate: number }[]; buckets: { notDue: number; d1_30: number; d31_60: number; d61_90: number; d90: number }; total: number; pastDue: number }

const tone = (v: string) => (v === "paid" ? "ok" : v === "overdue" ? "danger" : "warn") as "ok" | "warn" | "danger";

export default function ClientInvoices() {
  const l = useL();
  const loc = useLocale();
  const [tab, setTab] = useState<"open" | "paid">("open");
  const [open, setOpen] = useState<string | null>(null);
  const [stmt, setStmt] = useState(false);
  const q = useQuery({ queryKey: ["portal-invoices", tab], queryFn: () => api<Row[]>(`/api/portal/invoices?status=${tab}`) });
  const rows = q.data ?? [];
  const owed = tab === "open" ? rows.reduce((a, r) => a + r.balance, 0) : 0;
  const label = (v: string) => ({ open: l("À payer", "To pay"), overdue: l("En retard", "Overdue"), partial: l("Partiel", "Partial"), paid: l("Payée", "Paid") })[v] ?? v;
  return (
    <>
      <PageHeader title={l("Factures", "Invoices")} subtitle={l("Vos factures et votre relevé de compte", "Your invoices and account statement")} actions={<button className="btn" onClick={() => setStmt(true)}>{l("Relevé de compte", "Account statement")}</button>} />
      {tab === "open" && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3"><Stat label={l("Factures impayées", "Unpaid invoices")} value={rows.length} /><Stat label={l("Solde total", "Total balance")} value={money(owed, loc)} tone={owed ? "warn" : undefined} /></div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "open", label: l("Impayées", "Unpaid") }, { key: "paid", label: l("Payées", "Paid") }]} />
      <div className="glass mt-3 overflow-x-auto p-2">
        {rows.length === 0 ? <Empty>{tab === "open" ? l("Rien à payer, merci !", "Nothing to pay, thank you!") : l("Aucune facture payée.", "No paid invoices.")}</Empty> : (
          <table className="grid"><thead><tr><th>#</th><th>{l("Bon de commande", "PO")}</th><th>{l("Émise", "Issued")}</th><th>{l("Échéance", "Due")}</th><th>Total</th><th>{l("Solde", "Balance")}</th><th>{l("Statut", "Status")}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="cursor-pointer" onClick={() => setOpen(r.id)}><td className="font-medium">{r.number}</td><td className="text-muted">{r.poNumber || "—"}</td><td className="text-muted">{fmtDate(r.issueDate, loc)}</td>
                <td style={{ color: r.view === "overdue" ? "var(--danger)" : undefined }}>{fmtDate(r.dueDate, loc)}</td><td>{money(Number(r.total), loc)}</td><td>{r.view === "paid" ? "—" : money(r.balance, loc)}</td><td><Chip tone={tone(r.view)}>{label(r.view)}</Chip></td></tr>))}</tbody></table>)}
      </div>
      {open && <InvoiceView id={open} onClose={() => setOpen(null)} />}
      {stmt && <StatementView onClose={() => setStmt(false)} />}
    </>
  );
}

function InvoiceView({ id, onClose }: { id: string; onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const q = useQuery({ queryKey: ["portal-invoice", id], queryFn: () => api<Detail>(`/api/portal/invoices/${id}`) });
  const d = q.data;
  return (
    <Modal title={d ? `${l("Facture", "Invoice")} ${d.number}` : l("Facture", "Invoice")} onClose={onClose} wide>
      {d && (
        <div id="print-area">
          <div className="mb-4 flex flex-wrap justify-between gap-3 text-sm">
            <div><div className="font-semibold">{d.clientName}</div><div className="text-muted">{[d.address, d.city, d.province, d.postalCode].filter(Boolean).join(", ")}</div>{d.poNumber && <div className="text-muted">{l("Bon de commande", "PO")}: {d.poNumber}</div>}</div>
            <div className="text-right"><div>{l("Émise", "Issued")}: {fmtDate(d.issueDate, loc)}</div><div>{l("Échéance", "Due")}: {fmtDate(d.dueDate, loc)}</div><Chip tone={tone(d.view)}>{d.view === "paid" ? l("Payée", "Paid") : d.view === "overdue" ? l("En retard", "Overdue") : d.view === "partial" ? l("Partiel", "Partial") : l("À payer", "To pay")}</Chip></div>
          </div>
          <table className="grid"><thead><tr><th>{l("Description", "Description")}</th><th>{l("Qté", "Qty")}</th><th>{l("Prix", "Price")}</th><th>{l("Montant", "Amount")}</th></tr></thead>
            <tbody>{d.lines.map((x) => <tr key={x.id}><td>{x.description}</td><td>{x.quantity}</td><td>{money(Number(x.unitPrice), loc)}</td><td>{money(Number(x.amount), loc)}</td></tr>)}</tbody></table>
          <div className="ml-auto mt-3 max-w-xs space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted">{l("Sous-total", "Subtotal")}</span>{money(Number(d.subtotal), loc)}</div>
            <div className="flex justify-between"><span className="text-muted">TPS / GST</span>{money(Number(d.gst), loc)}</div>
            <div className="flex justify-between"><span className="text-muted">TVQ / QST</span>{money(Number(d.qst), loc)}</div>
            <div className="flex justify-between font-semibold"><span>Total</span>{money(Number(d.total), loc)}</div>
            {d.paid > 0 && <div className="flex justify-between"><span className="text-muted">{l("Payé", "Paid")}</span>{money(d.paid, loc)}</div>}
            <div className="flex justify-between font-semibold"><span>{l("Solde", "Balance")}</span>{money(d.balance, loc)}</div>
          </div>
          {d.payments.length > 0 && <div className="mt-4 text-sm"><div className="mb-1 text-xs uppercase tracking-wide text-muted">{l("Paiements reçus", "Payments received")}</div>{d.payments.map((p) => <div key={p.id} className="flex justify-between"><span>{fmtDate(p.paidOn, loc)}{p.method ? ` · ${p.method}` : ""}{p.reference ? ` · ${p.reference}` : ""}</span><span>{money(Number(p.amountCents) / 100, loc)}</span></div>)}</div>}
          {d.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-muted">{d.notes}</p>}
        </div>)}
      <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={() => window.print()}>{l("Imprimer / PDF", "Print / PDF")}</button><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button></div>
    </Modal>
  );
}

function StatementView({ onClose }: { onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const q = useQuery({ queryKey: ["portal-statement"], queryFn: () => api<Statement>("/api/portal/statement") });
  const s = q.data;
  return (
    <Modal title={l("Relevé de compte", "Account statement")} onClose={onClose} wide>
      {s && (
        <div id="print-area">
          <div className="mb-3 text-sm text-muted">{l("Au", "As of")} {fmtDate(s.today, loc)}</div>
          {!s.rows.length ? <Empty>{l("Rien à payer : votre compte est à jour.", "Nothing owed: your account is up to date.")}</Empty> : (
            <table className="grid"><thead><tr><th>#</th><th>{l("Échéance", "Due")}</th><th>{l("Retard", "Late")}</th><th>Total</th><th>{l("Solde", "Balance")}</th></tr></thead>
              <tbody>{s.rows.map((r) => <tr key={r.id}><td className="font-medium">{r.number}</td><td>{fmtDate(r.dueDate, loc)}</td><td style={{ color: r.daysLate ? "var(--danger)" : undefined }}>{r.daysLate ? `${r.daysLate} ${l("j", "d")}` : "—"}</td><td>{money(r.total, loc)}</td><td className="font-medium">{money(r.balance, loc)}</td></tr>)}</tbody></table>)}
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Stat label={l("Pas échu", "Not due")} value={money(s.buckets.notDue, loc)} /><Stat label="1–30 j" value={money(s.buckets.d1_30, loc)} /><Stat label="31–60 j" value={money(s.buckets.d31_60, loc)} /><Stat label="61–90 j" value={money(s.buckets.d61_90, loc)} /><Stat label="90+ j" value={money(s.buckets.d90, loc)} tone={s.buckets.d90 ? "danger" : undefined} /><Stat label={l("Total dû", "Total owed")} value={money(s.total, loc)} tone={s.pastDue ? "warn" : undefined} />
          </div>
        </div>)}
      <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={() => window.print()}>{l("Imprimer / PDF", "Print / PDF")}</button><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button></div>
    </Modal>
  );
}
