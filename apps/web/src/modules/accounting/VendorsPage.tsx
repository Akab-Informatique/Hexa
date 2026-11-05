import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, Stat, Tabs, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import { BillsCalendar } from "./vendors/Calendar";
import { Forecast } from "./vendors/Forecast";
import { Payroll } from "./vendors/Payroll";
import { Recurring } from "./vendors/Recurring";

export interface Vendor { id: string; name: string; contact: string; email: string; phone: string; paymentTerms: string; notes: string; active: boolean; owed: number }
export interface Bill { id: string; vendorId: string; vendorName: string; number: string; billDate: string; dueDate: string | null; amount: number; status: "unpaid" | "scheduled" | "paid"; notes: string }
interface Tile { count: number; amount: number }
interface Bills { bills: Bill[]; today: string; tiles: { late: Tile; today: Tile; next7: Tile; next30: Tile; noDate: Tile; open: Tile } }
type Tab = "calendar" | "bills" | "forecast" | "recurring" | "payroll" | "vendors";

/** Vendor payments: what we have to pay, on a calendar and in a list, a cash forecast, recurring payments and the payroll plan. */
export default function VendorsPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) ?? "calendar";
  const setTab = (t: Tab) => { const n = new URLSearchParams(sp); n.set("tab", t); setSp(n, { replace: true }); };
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [vendorDlg, setVendorDlg] = useState<null | { row?: Vendor }>(null);
  const [billDlg, setBillDlg] = useState<null | { row?: Bill; day?: string }>(null);
  const [error, setError] = useState("");
  const manage = can("accounting.vendors.manage");
  const vendors = useQuery({ queryKey: ["vendors"], queryFn: () => api<Vendor[]>("/api/accounting/vendors") });
  const qs = `status=${status}&q=${encodeURIComponent(q)}${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`;
  const bills = useQuery({ queryKey: ["bills", qs], queryFn: () => api<Bills>(`/api/accounting/bills?${qs}`) });
  const refresh = async () => { for (const k of ["vendors", "bills", "bills-calendar", "vp-forecast", "w-bills"]) await qc.invalidateQueries({ queryKey: [k] }); };
  const setBillStatus = async (b: Bill, st: Bill["status"]) => { try { setError(""); await api(`/api/accounting/bills/${b.id}`, { method: "PATCH", body: { status: st } }); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const t = bills.data?.tiles;
  const today = bills.data?.today ?? "";

  const vendorFields: FieldDef[] = [{ name: "name", label: ["Nom", "Name"], required: true, span: 2 }, { name: "contact", label: ["Contact", "Contact"] }, { name: "email", label: ["Courriel", "Email"], type: "email" }, { name: "phone", label: ["Téléphone", "Phone"] }, { name: "paymentTerms", label: ["Conditions de paiement", "Payment terms"] }, { name: "active", label: ["Actif", "Active"], type: "checkbox" }, { name: "notes", label: ["Notes", "Notes"], type: "textarea" }];
  const billFields: FieldDef[] = [
    { name: "vendorId", label: ["Fournisseur", "Vendor"], type: "select", required: true, options: (vendors.data ?? []).filter((v) => v.active).map((v) => ({ value: v.id, label: v.name })) },
    { name: "number", label: ["# facture fournisseur", "Vendor invoice #"] }, { name: "billDate", label: ["Date de la facture", "Bill date"], type: "date" },
    { name: "dueDate", label: ["Échéance", "Due date"], type: "date", hint: ["Laissez vide s'il n'y a pas de date", "Leave empty if there is no date"] },
    { name: "amount", label: ["Montant", "Amount"], type: "number", step: "0.01", required: true }, { name: "status", label: ["Statut", "Status"], type: "select", required: true, options: [{ value: "unpaid", label: ["À payer", "Unpaid"] }, { value: "scheduled", label: ["Planifié", "Scheduled"] }, { value: "paid", label: ["Payé", "Paid"] }] },
    { name: "notes", label: ["Notes", "Notes"], type: "textarea", rows: 2 },
  ];
  const tile = (label: string, x: Tile | undefined, tone?: "warn" | "danger", go?: () => void) => (
    <button className="text-left" onClick={go} disabled={!go}><Stat label={`${label} · ${x?.count ?? 0}`} value={money(x?.amount, loc)} tone={x?.count ? tone : undefined} /></button>
  );
  const goBills = (st: string, f = "", tt = "") => { setStatus(st); setFrom(f); setTo(tt); setTab("bills"); };

  const tabs: { key: Tab; label: string }[] = [
    { key: "calendar", label: l("Calendrier", "Calendar") }, { key: "bills", label: l("Paiements à faire", "Payments to make") }, { key: "forecast", label: l("Prévision de trésorerie", "Cash forecast") },
    { key: "recurring", label: l("Paiements récurrents", "Recurring payments") }, ...(can("hr.manage") ? [{ key: "payroll" as Tab, label: l("Paie", "Payroll") }] : []), { key: "vendors", label: l("Fournisseurs", "Vendors") },
  ];

  return (
    <>
      <PageHeader title={l("Fournisseurs et paiements", "Vendors and payments")} subtitle={l("Ce que nous devons payer, et quand", "What we have to pay, and when")}
        actions={manage && <div className="flex gap-2"><button className="btn" onClick={() => setVendorDlg({})}><Plus size={15} />{l("Fournisseur", "Vendor")}</button><button className="btn btn-primary" onClick={() => setBillDlg({})}><Plus size={15} />{l("Facture à payer", "Bill to pay")}</button></div>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tile(l("En retard", "Late"), t?.late, "danger", () => goBills("overdue"))}
        {tile(l("Aujourd'hui", "Due today"), t?.today, "warn", () => goBills("open", today, today))}
        {tile(l("7 prochains jours", "Next 7 days"), t?.next7, undefined, () => goBills("open", today, addD(today, 7)))}
        {tile(l("30 prochains jours", "Next 30 days"), t?.next30, undefined, () => goBills("open", today, addD(today, 30)))}
        {tile(l("Sans date", "No date"), t?.noDate, "warn")}
        {tile(l("Tout ce qui est ouvert", "All open"), t?.open, undefined, () => goBills("open"))}
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      {tab === "calendar" && <BillsCalendar manage={manage} onAdd={(day) => setBillDlg({ day })} onOpen={(id) => { const b = bills.data?.bills.find((x) => x.id === id); if (b) setBillDlg({ row: b }); else goBills("all"); }} />}

      {tab === "bills" && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Tabs tabs={[{ key: "open", label: l("Ouvertes", "Open") }, { key: "overdue", label: l("En retard", "Late") }, { key: "scheduled", label: l("Planifiées", "Scheduled") }, { key: "paid", label: l("Payées", "Paid") }, { key: "all", label: l("Toutes", "All") }]} value={status} onChange={setStatus} />
            <div className="relative min-w-[200px] flex-1"><Search size={14} className="pointer-events-none absolute left-3 top-3 text-muted" /><input className="input !pl-8" placeholder={l("Fournisseur, numéro, notes…", "Vendor, number, notes…")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <input className="input !w-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="from" title={l("Échéance à partir du", "Due from")} /><input className="input !w-auto" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="to" title={l("Échéance jusqu'au", "Due until")} />
            {(from || to) && <button className="btn" onClick={() => { setFrom(""); setTo(""); }}>{l("Effacer les dates", "Clear dates")}</button>}
          </div>
          <div className="glass overflow-x-auto p-2">
            {!bills.data?.bills.length ? <Empty>{l("Aucune facture.", "No bills.")}</Empty> : (
              <table className="grid"><thead><tr><th>{l("Fournisseur", "Vendor")}</th><th>#</th><th>{l("Échéance", "Due")}</th><th>{l("Montant", "Amount")}</th><th>{l("Statut", "Status")}</th>{manage && <th />}</tr></thead>
                <tbody>{bills.data.bills.map((b) => (
                  <tr key={b.id}><td className="font-medium">{b.vendorName}</td><td className="text-muted">{b.number || "—"}</td>
                    <td style={{ color: b.status !== "paid" && b.dueDate && b.dueDate < today ? "var(--danger)" : undefined }}>{b.dueDate ? fmtDate(b.dueDate, loc) : <span className="text-warn">{l("Sans date", "No date")}</span>}</td><td>{money(b.amount, loc)}</td>
                    <td><Chip tone={b.status === "paid" ? "ok" : b.status === "scheduled" ? "warn" : "off"}>{b.status === "paid" ? l("Payée", "Paid") : b.status === "scheduled" ? l("Planifiée", "Scheduled") : l("À payer", "Unpaid")}</Chip></td>
                    {manage && <td className="whitespace-nowrap text-right">{b.status !== "paid" && <button className="btn !p-1.5" title={l("Marquer payé", "Mark paid")} onClick={() => void setBillStatus(b, "paid")}><Check size={14} color="var(--ok)" /></button>} <button className="btn !p-1.5" onClick={() => setBillDlg({ row: b })} aria-label="edit"><Pencil size={14} /></button> <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(l("Supprimer cette facture ?", "Delete this bill?"), () => { void api(`/api/accounting/bills/${b.id}`, { method: "DELETE" }).then(refresh); })}><Trash2 size={14} /></button></td>}</tr>))}</tbody></table>)}
          </div>
        </>
      )}

      {tab === "forecast" && <Forecast manage={manage} />}
      {tab === "recurring" && <Recurring manage={manage} vendors={vendors.data ?? []} />}
      {tab === "payroll" && <Payroll />}

      {tab === "vendors" && (
        <div className="glass overflow-x-auto p-2">
          {!vendors.data?.length ? <Empty>{l("Aucun fournisseur.", "No vendors.")}</Empty> : (
            <table className="grid"><thead><tr><th>{l("Fournisseur", "Vendor")}</th><th>Contact</th><th>{l("Conditions", "Terms")}</th><th>{l("Solde dû", "Owed")}</th>{manage && <th />}</tr></thead>
              <tbody>{vendors.data.map((v) => (<tr key={v.id} style={{ opacity: v.active ? 1 : 0.5 }}><td className="font-medium">{v.name}</td><td className="text-muted">{[v.contact, v.email, v.phone].filter(Boolean).join(" · ") || "—"}</td><td className="text-muted">{v.paymentTerms || "—"}</td><td>{money(v.owed, loc)}</td>{manage && <td className="text-right"><button className="btn !p-1.5" onClick={() => setVendorDlg({ row: v })} aria-label="edit"><Pencil size={14} /></button></td>}</tr>))}</tbody></table>)}
        </div>
      )}

      {vendorDlg && <FormDialog title={vendorDlg.row ? l("Modifier le fournisseur", "Edit vendor") : l("Nouveau fournisseur", "New vendor")} fields={vendorFields} initial={vendorDlg.row ? { ...vendorDlg.row } : { active: true }} wide
        onSubmit={async (v) => { const body = { name: v.name, contact: v.contact ?? "", email: v.email ?? "", phone: v.phone ?? "", paymentTerms: v.paymentTerms ?? "", notes: v.notes ?? "", active: Boolean(v.active) }; if (vendorDlg.row) await api(`/api/accounting/vendors/${vendorDlg.row.id}`, { method: "PATCH", body }); else await api("/api/accounting/vendors", { body }); await refresh(); }} onClose={() => setVendorDlg(null)} />}
      {billDlg && <FormDialog title={billDlg.row ? l("Modifier la facture", "Edit bill") : l("Facture à payer", "Bill to pay")} fields={billFields} initial={billDlg.row ? { ...billDlg.row, dueDate: billDlg.row.dueDate ?? "" } : { status: "unpaid", dueDate: billDlg.day ?? "" }} wide
        onSubmit={async (v) => { const body = { vendorId: v.vendorId, number: v.number ?? "", billDate: v.billDate || undefined, dueDate: v.dueDate || null, amount: Number(v.amount), notes: v.notes ?? "", status: v.status }; if (billDlg.row) await api(`/api/accounting/bills/${billDlg.row.id}`, { method: "PATCH", body }); else await api("/api/accounting/bills", { body }); await refresh(); }} onClose={() => setBillDlg(null)} />}
    </>
  );
}

const addD = (s: string, n: number) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
