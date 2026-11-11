import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { lineTotalCents, parseCents, quantityHundredths } from "@hexa/shared/productSale";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg } from "../../components/kit";
import { Modal } from "../../components/ui";
import { codeText } from "./ContractWindow";

interface Svc { id: string; name: string; type: "recurring" | "product"; period: string | null; priceCents: number; active: boolean }
interface Sold { id: string; description: string; quantity: number; unitPriceCents: number; totalCents: number; status: "pending" | "approved" | "excluded" | "invoiced"; workDate: string | null; createdAt: string; soldBy: string | null; invoiceNumber: string | null }

/** "Produits" section of the client page: one-time sales (each one line of work to bill) and the fixed recurring services. */
export function ClientProducts({ clientId, onChanged }: { clientId: string; onChanged: () => Promise<unknown> | void }) {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const [dialog, setDialog] = useState<null | "sell" | "attach">(null);
  const sold = useQuery({ queryKey: ["client-products", clientId], queryFn: () => api<Sold[]>(`/api/clients/${clientId}/products`), enabled: can("clients.billing.manage", "clients.contracts.view") });
  const cat = useQuery({ queryKey: ["svc-catalogue"], queryFn: () => api<Svc[]>("/api/services"), enabled: dialog !== null });
  const status = (s: Sold["status"]) => (s === "pending" ? <Chip tone="warn">{l("À approuver", "To approve")}</Chip> : s === "approved" ? <Chip tone="ok">{l("Approuvé", "Approved")}</Chip> : s === "invoiced" ? <Chip tone="ok">{l("Facturé", "Invoiced")}</Chip> : <Chip tone="off">{l("Exclu", "Excluded")}</Chip>);
  const done = async () => { await sold.refetch(); await onChanged(); };
  return (
    <div className="glass mt-4 p-2">
      <div className="flex items-center justify-between p-2"><div className="font-medium">{l("Produits vendus", "Products sold")}</div>
        <div className="flex gap-2">
          {can("clients.contracts.edit") && <button className="btn" onClick={() => setDialog("attach")}><Plus size={15} />{l("Service à prix fixe", "Fixed service")}</button>}
          {can("clients.billing.manage") && <button className="btn btn-primary" onClick={() => setDialog("sell")}><Plus size={15} />{l("Vendre un produit", "Sell a product")}</button>}
        </div></div>
      {!sold.data?.length ? <Empty>{l("Aucun produit vendu.", "No products sold.")}</Empty> : (
        <table className="grid"><thead><tr><th>{l("Produit", "Product")}</th><th>{l("Qté", "Qty")}</th><th>{l("Total", "Total")}</th><th>{l("Date", "Date")}</th><th>{l("État", "Status")}</th></tr></thead>
          <tbody>{sold.data.map((s) => (
            <tr key={s.id}><td><div className="font-medium">{s.description}</div>{s.soldBy && <div className="text-xs text-muted">{s.soldBy}</div>}</td><td>{s.quantity}</td><td>{money(s.totalCents / 100, loc)}</td><td className="text-muted">{fmtDate(s.workDate ?? s.createdAt, loc)}</td>
              <td>{status(s.status)}{s.invoiceNumber && <span className="ml-1 text-xs text-muted">{s.invoiceNumber}</span>}</td></tr>))}</tbody></table>)}
      {dialog === "sell" && <SaleDialog clientId={clientId} products={(cat.data ?? []).filter((s) => s.type === "product" && s.active)} onDone={done} onClose={() => setDialog(null)} />}
      {dialog === "attach" && <AttachDialog clientId={clientId} services={(cat.data ?? []).filter((s) => s.type === "recurring" && s.active)} onDone={done} onClose={() => setDialog(null)} />}
    </div>
  );
}

function SaleDialog({ clientId, products, onDone, onClose }: { clientId: string; products: Svc[]; onDone: () => Promise<unknown>; onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const key = useRef(crypto.randomUUID());   // one key per open dialog: a double click or a retry cannot sell twice
  const [sel, setSel] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [day, setDay] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chosen = products.find((p) => p.id === sel);
  const priceCents = price === "" ? (chosen?.priceCents ?? null) : parseCents(price);
  const q = quantityHundredths(Number(qty));
  const total = priceCents != null && q != null ? lineTotalCents(priceCents, q) : null;
  const ok = Boolean(chosen) && total != null && total > 0 && !busy;
  return (
    <Modal title={l("Vendre un produit", "Sell a product")} onClose={onClose}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault(); if (!ok) return; setBusy(true); setErr("");
        try { await api(`/api/clients/${clientId}/products`, { body: { serviceId: sel, quantity: Number(qty), priceCents: price === "" ? undefined : priceCents, note: note.trim() || undefined, date: day, idempotencyKey: key.current } }); await onDone(); onClose(); }
        catch (x) { setErr(codeText(errMsg(x, "Error"), l)); setBusy(false); }
      }}>
        <label className="sm:col-span-2"><span className="label">{l("Produit", "Product")} *</span><select className="input" value={sel} onChange={(e) => { setSel(e.target.value); setPrice(""); }}><option value="">—</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name} ({money(p.priceCents / 100, loc)})</option>)}</select></label>
        <label><span className="label">{l("Quantité", "Quantity")}</span><input className="input" type="number" step="0.01" min="0.01" max="1000" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label><span className="label">{l("Prix unitaire ($)", "Unit price ($)")}</span><input className="input" inputMode="decimal" disabled={!can("clients.billing.manage")} placeholder={chosen ? String(chosen.priceCents / 100) : ""} value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label><span className="label">{l("Date", "Date")}</span><input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
        <label><span className="label">{l("Note", "Note")}</span><input className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={l("Ex. année 2025", "E.g. year 2025")} /></label>
        <div className="text-sm text-muted sm:col-span-2">{total != null ? <>{l("Total avant taxes", "Total before tax")}: <b>{money(total / 100, loc)}</b> · {l("Ira dans les approbations.", "Goes to approvals.")}</> : l("Montant ou quantité invalide.", "Invalid amount or quantity.")}</div>
        {err && <p role="alert" className="text-sm text-danger sm:col-span-2">{err}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" disabled={!ok}>{l("Vendre", "Sell")}</button></div>
      </form>
    </Modal>
  );
}

function AttachDialog({ clientId, services, onDone, onClose }: { clientId: string; services: Svc[]; onDone: () => Promise<unknown>; onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const [sel, setSel] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const chosen = services.find((s) => s.id === sel);
  const priceCents = price === "" ? null : parseCents(price);
  const per = (p: string | null) => (p === "monthly" ? l("/ mois", "/ month") : p === "quarterly" ? l("/ trimestre", "/ quarter") : l("/ an", "/ year"));
  const ok = Boolean(chosen) && (price === "" || priceCents != null) && Number(qty) > 0 && !busy && (!end || end >= start);
  return (
    <Modal title={l("Service à prix fixe", "Fixed-price service")} onClose={onClose}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault(); if (!ok) return; setBusy(true); setErr("");
        try { await api(`/api/clients/${clientId}/services`, { body: { serviceId: sel, priceCents: can("clients.billing.manage") && priceCents != null ? priceCents : undefined, quantity: Number(qty), startsOn: start, endsOn: end || null } }); await onDone(); onClose(); }
        catch (x) { setErr(codeText(errMsg(x, "Error"), l)); setBusy(false); }
      }}>
        <label className="sm:col-span-2"><span className="label">{l("Service", "Service")} *</span><select className="input" value={sel} onChange={(e) => { setSel(e.target.value); setPrice(""); }}><option value="">—</option>{services.map((s) => <option key={s.id} value={s.id}>{s.name} ({money(s.priceCents / 100, loc)} {per(s.period)})</option>)}</select></label>
        {can("clients.billing.manage") && <label><span className="label">{l("Prix pour ce client ($)", "Price for this client ($)")}</span><input className="input" inputMode="decimal" placeholder={chosen ? String(chosen.priceCents / 100) : ""} value={price} onChange={(e) => setPrice(e.target.value)} /></label>}
        <label><span className="label">{l("Quantité", "Quantity")}</span><input className="input" type="number" step="0.01" min="0.01" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label><span className="label">{l("Début", "Start")} *</span><input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label><span className="label">{l("Fin (facultatif)", "End (optional)")}</span><input className="input" type="date" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
        <p className="text-xs text-muted sm:col-span-2">{l("Le premier mois ou trimestre partiel est calculé au prorata des jours. Les lignes arrivent dans les approbations.", "A part first month or quarter is prorated by days. Lines go to approvals.")}</p>
        {err && <p role="alert" className="text-sm text-danger sm:col-span-2">{err}</p>}
        <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" disabled={!ok}>{l("Ajouter", "Add")}</button></div>
      </form>
    </Modal>
  );
}
