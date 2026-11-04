import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, Stat, Tabs, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

interface Vendor { id: string; name: string; contact: string; email: string; phone: string; paymentTerms: string; notes: string; active: boolean; owed: number }
interface Bill { id: string; vendorId: string; vendorName: string; number: string; billDate: string; dueDate: string; amount: number; status: "unpaid" | "scheduled" | "paid"; notes: string }
interface Bills { bills: Bill[]; today: string; totals: { open: number; overdue: number; dueThisWeek: number } }

/** Vendors and the payments we have to make: unpaid bills by due date with overdue / due-this-week totals. */
export default function VendorsPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"bills" | "vendors">("bills");
  const [show, setShow] = useState<"open" | "paid">("open");
  const [vendorDlg, setVendorDlg] = useState<null | { row?: Vendor }>(null);
  const [billDlg, setBillDlg] = useState<null | { row?: Bill }>(null);
  const [error, setError] = useState("");
  const manage = can("accounting.vendors.manage");
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => api<Vendor[]>("/api/accounting/vendors") });
  const bills = useQuery({ queryKey: ["bills", show], queryFn: () => api<Bills>(`/api/accounting/bills?status=${show}`) });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["vendors"] }); await qc.invalidateQueries({ queryKey: ["bills"] }); await qc.invalidateQueries({ queryKey: ["w-bills"] }); };
  const setStatus = async (b: Bill, status: Bill["status"]) => { try { setError(""); await api(`/api/accounting/bills/${b.id}`, { method: "PATCH", body: { status } }); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };

  const vendorFields: FieldDef[] = [{ name: "name", label: ["Nom", "Name"], required: true, span: 2 }, { name: "contact", label: ["Contact", "Contact"] }, { name: "email", label: ["Courriel", "Email"], type: "email" }, { name: "phone", label: ["Téléphone", "Phone"] }, { name: "paymentTerms", label: ["Conditions de paiement", "Payment terms"] }, { name: "active", label: ["Actif", "Active"], type: "checkbox" }, { name: "notes", label: ["Notes", "Notes"], type: "textarea" }];
  const billFields: FieldDef[] = [
    { name: "vendorId", label: ["Fournisseur", "Vendor"], type: "select", required: true, options: (vendors.data ?? []).filter((v) => v.active).map((v) => ({ value: v.id, label: v.name })) },
    { name: "number", label: ["# facture fournisseur", "Vendor invoice #"] }, { name: "billDate", label: ["Date de la facture", "Bill date"], type: "date" }, { name: "dueDate", label: ["Échéance", "Due date"], type: "date", required: true },
    { name: "amount", label: ["Montant", "Amount"], type: "number", step: "0.01", required: true }, { name: "status", label: ["Statut", "Status"], type: "select", required: true, options: [{ value: "unpaid", label: ["À payer", "Unpaid"] }, { value: "scheduled", label: ["Planifié", "Scheduled"] }, { value: "paid", label: ["Payé", "Paid"] }] },
    { name: "notes", label: ["Notes", "Notes"], type: "textarea", rows: 2 },
  ];
  const t = bills.data?.totals;

  return (
    <>
      <PageHeader title={l("Fournisseurs et paiements", "Vendors and payments")} subtitle={l("Ce que nous devons payer", "What we have to pay")}
        actions={manage && <div className="flex gap-2"><button className="btn" onClick={() => setVendorDlg({})}><Plus size={15} />{l("Fournisseur", "Vendor")}</button><button className="btn btn-primary" onClick={() => setBillDlg({})}><Plus size={15} />{l("Facture à payer", "Bill to pay")}</button></div>} />
      <div className="mb-4 grid grid-cols-3 gap-3"><Stat label={l("Total à payer", "Total owed")} value={money(t?.open, loc)} /><Stat label={l("Cette semaine", "Due this week")} value={money(t?.dueThisWeek, loc)} tone={t?.dueThisWeek ? "warn" : undefined} /><Stat label={l("En retard", "Overdue")} value={money(t?.overdue, loc)} tone={t?.overdue ? "danger" : undefined} /></div>
      <Tabs tabs={[{ key: "bills", label: l("Paiements à faire", "Payments to make") }, { key: "vendors", label: l("Fournisseurs", "Vendors") }]} value={tab} onChange={setTab} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      {tab === "bills" && (
        <>
          <div className="mb-3"><Tabs tabs={[{ key: "open", label: l("Ouvertes", "Open") }, { key: "paid", label: l("Payées", "Paid") }]} value={show} onChange={setShow} /></div>
          <div className="glass overflow-x-auto p-2">
            {!bills.data?.bills.length ? <Empty>{l("Aucune facture.", "No bills.")}</Empty> : (
              <table className="grid"><thead><tr><th>{l("Fournisseur", "Vendor")}</th><th>#</th><th>{l("Échéance", "Due")}</th><th>{l("Montant", "Amount")}</th><th>{l("Statut", "Status")}</th>{manage && <th />}</tr></thead>
                <tbody>{bills.data.bills.map((b) => (
                  <tr key={b.id}><td className="font-medium">{b.vendorName}</td><td className="text-muted">{b.number || "—"}</td>
                    <td style={{ color: b.status !== "paid" && b.dueDate < bills.data.today ? "var(--danger)" : undefined }}>{fmtDate(b.dueDate, loc)}</td><td>{money(b.amount, loc)}</td>
                    <td><Chip tone={b.status === "paid" ? "ok" : b.status === "scheduled" ? "warn" : "off"}>{b.status}</Chip></td>
                    {manage && <td className="whitespace-nowrap text-right">{b.status !== "paid" && <button className="btn !p-1.5" title={l("Marquer payé", "Mark paid")} onClick={() => void setStatus(b, "paid")}><Check size={14} color="var(--ok)" /></button>} <button className="btn !p-1.5" onClick={() => setBillDlg({ row: b })} aria-label="edit"><Pencil size={14} /></button> <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(l("Supprimer cette facture ?", "Delete this bill?"), () => { void api(`/api/accounting/bills/${b.id}`, { method: "DELETE" }).then(refresh); })}><Trash2 size={14} /></button></td>}</tr>))}</tbody></table>)}
          </div>
        </>
      )}

      {tab === "vendors" && (
        <div className="glass overflow-x-auto p-2">
          {!vendors.data?.length ? <Empty>{l("Aucun fournisseur.", "No vendors.")}</Empty> : (
            <table className="grid"><thead><tr><th>{l("Fournisseur", "Vendor")}</th><th>Contact</th><th>{l("Conditions", "Terms")}</th><th>{l("Solde dû", "Owed")}</th>{manage && <th />}</tr></thead>
              <tbody>{vendors.data.map((v) => (<tr key={v.id} style={{ opacity: v.active ? 1 : 0.5 }}><td className="font-medium">{v.name}</td><td className="text-muted">{[v.contact, v.email, v.phone].filter(Boolean).join(" · ") || "—"}</td><td className="text-muted">{v.paymentTerms || "—"}</td><td>{money(v.owed, loc)}</td>{manage && <td className="text-right"><button className="btn !p-1.5" onClick={() => setVendorDlg({ row: v })} aria-label="edit"><Pencil size={14} /></button></td>}</tr>))}</tbody></table>)}
        </div>
      )}

      {vendorDlg && <FormDialog title={vendorDlg.row ? l("Modifier le fournisseur", "Edit vendor") : l("Nouveau fournisseur", "New vendor")} fields={vendorFields} initial={vendorDlg.row ? { ...vendorDlg.row } : { active: true }} wide
        onSubmit={async (v) => { const body = { name: v.name, contact: v.contact ?? "", email: v.email ?? "", phone: v.phone ?? "", paymentTerms: v.paymentTerms ?? "", notes: v.notes ?? "", active: Boolean(v.active) }; if (vendorDlg.row) await api(`/api/accounting/vendors/${vendorDlg.row.id}`, { method: "PATCH", body }); else await api("/api/accounting/vendors", { body }); await refresh(); }} onClose={() => setVendorDlg(null)} />}
      {billDlg && <FormDialog title={billDlg.row ? l("Modifier la facture", "Edit bill") : l("Facture à payer", "Bill to pay")} fields={billFields} initial={billDlg.row ? { ...billDlg.row } : { status: "unpaid" }} wide
        onSubmit={async (v) => { const body = { vendorId: v.vendorId, number: v.number ?? "", billDate: v.billDate || undefined, dueDate: v.dueDate, amount: Number(v.amount), notes: v.notes ?? "", status: v.status }; if (billDlg.row) await api(`/api/accounting/bills/${billDlg.row.id}`, { method: "PATCH", body }); else await api("/api/accounting/bills", { body }); await refresh(); }} onClose={() => setBillDlg(null)} />}
    </>
  );
}
