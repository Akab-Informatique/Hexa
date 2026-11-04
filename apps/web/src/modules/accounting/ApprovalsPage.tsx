import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Plus, RotateCcw, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, FormDialog, Tabs, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

interface Item { id: string; clientId: string; clientName: string; source: string; description: string; quantity: number; unitPrice: number; status: string; workDate: string | null; createdByName: string | null }

/** Approve work to bill: time and manual lines are approved, edited or excluded here, then invoiced. */
export default function ApprovalsPage() {
  const l = useL();
  const loc = useLocale();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"pending" | "approved" | "excluded" | "invoiced">("pending");
  const [sel, setSel] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["billing-items", tab], queryFn: () => api<Item[]>(`/api/accounting/billing-items?status=${tab}`) });
  const manage = can("accounting.approvals.manage");
  const rows = q.data ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["billing-items"] }); setSel([]); };
  const decide = async (ids: string[], decision: "approve" | "exclude" | "restore") => { try { setError(""); await api("/api/accounting/billing-items/decision", { body: { ids, decision } }); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const edit = async (it: Item) => {
    const qty = window.prompt(l("Quantité", "Quantity"), String(it.quantity)); if (qty === null) return;
    const price = window.prompt(l("Prix unitaire", "Unit price"), String(it.unitPrice)); if (price === null) return;
    try { await api(`/api/accounting/billing-items/${it.id}`, { method: "PATCH", body: { quantity: Number(qty), unitPrice: Number(price) } }); await refresh(); } catch (e) { setError(errMsg(e, "Error")); }
  };
  const makeInvoices = async () => { try { const r = await api<{ created: string[] }>("/api/accounting/invoices/from-items", { body: {} }); await refresh(); nav(r.created.length === 1 ? `/accounting/invoices?open=${r.created[0]}` : "/accounting/invoices"); } catch (e) { setError(errMsg(e, "Error")); } };
  const total = rows.filter((i) => sel.includes(i.id)).reduce((a, i) => a + i.quantity * i.unitPrice, 0);
  const fields: FieldDef[] = [{ name: "clientId", label: ["Client", "Client"], type: "client", required: true }, { name: "description", label: ["Description", "Description"], required: true, span: 2 }, { name: "quantity", label: ["Quantité", "Quantity"], type: "number", step: "0.01", required: true }, { name: "unitPrice", label: ["Prix unitaire", "Unit price"], type: "number", step: "0.01", required: true }, { name: "workDate", label: ["Date du travail", "Work date"], type: "date" }];

  return (
    <>
      <PageHeader title={l("Travail à facturer", "Work to bill")} subtitle={l("Approuvez le travail avant de le facturer", "Approve work before billing it")}
        actions={<div className="flex gap-2">{manage && <button className="btn" onClick={() => setAdding(true)}><Plus size={15} />{l("Ligne manuelle", "Manual line")}</button>}{can("accounting.invoices.edit", "accounting.invoices.manage") && <button className="btn btn-primary" onClick={() => void makeInvoices()}><FileText size={15} />{l("Facturer le travail approuvé", "Invoice approved work")}</button>}</div>} />
      <Tabs tabs={[{ key: "pending", label: l("À approuver", "To approve") }, { key: "approved", label: l("Approuvé", "Approved") }, { key: "excluded", label: l("Exclu", "Excluded") }, { key: "invoiced", label: l("Facturé", "Invoiced") }]} value={tab} onChange={(t) => { setTab(t); setSel([]); }} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {manage && tab === "pending" && sel.length > 0 && (
        <div className="glass mb-3 flex flex-wrap items-center gap-3 p-3 text-sm"><span>{sel.length} {l("sélectionné(s)", "selected")} · {money(total, loc)}</span><button className="btn" onClick={() => void decide(sel, "approve")}><Check size={14} color="var(--ok)" />{l("Approuver", "Approve")}</button><button className="btn" onClick={() => void decide(sel, "exclude")}><X size={14} color="var(--danger)" />{l("Exclure", "Exclude")}</button></div>)}
      <div className="glass overflow-x-auto p-2">
        {rows.length === 0 ? <Empty>{l("Rien ici.", "Nothing here.")}</Empty> : (
          <table className="grid"><thead><tr>{manage && tab === "pending" && <th style={{ width: 36 }}><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={sel.length === rows.length} onChange={(e) => setSel(e.target.checked ? rows.map((r) => r.id) : [])} aria-label="all" /></th>}<th>Client</th><th>{l("Description", "Description")}</th><th>{l("Qté", "Qty")}</th><th>{l("Prix", "Price")}</th><th>Total</th><th>{l("Source", "Source")}</th>{manage && tab !== "invoiced" && <th />}</tr></thead>
            <tbody>{rows.map((i) => (
              <tr key={i.id}>{manage && tab === "pending" && <td><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={sel.includes(i.id)} onChange={() => setSel((s) => (s.includes(i.id) ? s.filter((x) => x !== i.id) : [...s, i.id]))} aria-label="select" /></td>}
                <td className="font-medium">{i.clientName}</td><td>{i.description}<div className="text-xs text-muted">{fmtDate(i.workDate, loc)}{i.createdByName ? ` · ${i.createdByName}` : ""}</div></td><td>{i.quantity}</td><td>{money(i.unitPrice, loc)}</td><td>{money(i.quantity * i.unitPrice, loc)}</td><td><Chip>{i.source}</Chip></td>
                {manage && tab !== "invoiced" && <td className="whitespace-nowrap text-right"><button className="btn !px-2 !py-1 text-xs" onClick={() => void edit(i)}>{l("Modifier", "Edit")}</button>{tab === "pending" && <> <button className="btn !p-1.5" onClick={() => void decide([i.id], "approve")} aria-label="approve"><Check size={14} color="var(--ok)" /></button> <button className="btn !p-1.5" onClick={() => void decide([i.id], "exclude")} aria-label="exclude"><X size={14} color="var(--danger)" /></button></>}{tab === "approved" && <> <button className="btn !p-1.5" onClick={() => void decide([i.id], "restore")} aria-label="back"><RotateCcw size={14} /></button></>}{tab === "excluded" && <> <button className="btn !p-1.5" onClick={() => void decide([i.id], "restore")} aria-label="restore"><RotateCcw size={14} /></button></>}</td>}</tr>))}</tbody></table>)}
      </div>
      {adding && <FormDialog title={l("Ligne à facturer", "Line to bill")} fields={fields} initial={{ quantity: 1, unitPrice: 0 }} onSubmit={async (v) => { await api("/api/accounting/billing-items", { body: { clientId: v.clientId, description: v.description, quantity: Number(v.quantity), unitPrice: Number(v.unitPrice), workDate: v.workDate || null } }); await refresh(); }} onClose={() => setAdding(false)} />}
    </>
  );
}
