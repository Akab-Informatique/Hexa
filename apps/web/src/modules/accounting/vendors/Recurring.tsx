import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardPaste, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { fmtDate, money, todayISO, useL, useLocale } from "../../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, type FieldDef } from "../../../components/kit";
import { Modal } from "../../../components/ui";
import type { Vendor } from "../VendorsPage";

interface Rec { id: string; vendorId: string | null; vendorName: string | null; label: string; amount: number; frequency: "weekly" | "monthly" | "yearly"; nextDate: string; upcoming: string | null; active: boolean; inQuickbooks: boolean }
interface Preview { rows: { line: number; vendor: string; label: string; amount: number; frequency: string | null; nextDate: string; inQuickbooks: boolean; vendorExists: boolean; error: string }[]; ok: number; errors: number; newVendors: string[] }

/** Payments that come back every week, month or year (rent, subscriptions, insurance), counted in the cash forecast. */
export function Recurring({ manage, vendors }: { manage: boolean; vendors: Vendor[] }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [dlg, setDlg] = useState<null | { row?: Rec }>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["vp-recurring"], queryFn: () => api<Rec[]>("/api/accounting/recurring") });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["vp-recurring"] }); await qc.invalidateQueries({ queryKey: ["vp-forecast"] }); await qc.invalidateQueries({ queryKey: ["bills-calendar"] }); await qc.invalidateQueries({ queryKey: ["vendors"] }); };
  const freq = (f: string) => (f === "weekly" ? l("Chaque semaine", "Weekly") : f === "monthly" ? l("Chaque mois", "Monthly") : l("Chaque année", "Yearly"));
  const fields: FieldDef[] = [
    { name: "label", label: ["Libellé", "Label"], required: true, span: 2 }, { name: "vendorId", label: ["Fournisseur", "Vendor"], type: "select", options: vendors.filter((v) => v.active).map((v) => ({ value: v.id, label: v.name })) },
    { name: "amount", label: ["Montant", "Amount"], type: "number", step: "0.01", required: true },
    { name: "frequency", label: ["Fréquence", "Frequency"], type: "select", required: true, options: [{ value: "weekly", label: ["Chaque semaine", "Weekly"] }, { value: "monthly", label: ["Chaque mois", "Monthly"] }, { value: "yearly", label: ["Chaque année", "Yearly"] }] },
    { name: "nextDate", label: ["Une date de paiement", "A payment date"], type: "date", required: true, hint: ["Les suivantes suivent la fréquence", "The others follow the frequency"] },
    { name: "inQuickbooks", label: ["Déjà entré dans QuickBooks (ne pas compter deux fois)", "Already in QuickBooks (do not count twice)"], type: "checkbox" }, { name: "active", label: ["Actif", "Active"], type: "checkbox" },
  ];
  return (
    <section className="glass p-3">
      <div className="mb-2 flex justify-end gap-2">{manage && <><button className="btn" onClick={() => setImporting(true)}><ClipboardPaste size={15} />{l("Coller depuis un chiffrier", "Paste from a spreadsheet")}</button><button className="btn btn-primary" onClick={() => setDlg({})}><Plus size={15} />{l("Paiement récurrent", "Recurring payment")}</button></>}</div>
      {error && <p role="alert" className="px-2 pb-2 text-sm text-danger">{error}</p>}
      {!q.data?.length ? <Empty>{l("Aucun paiement récurrent.", "No recurring payments.")}</Empty> : (
        <table className="grid"><thead><tr><th>{l("Libellé", "Label")}</th><th>{l("Fournisseur", "Vendor")}</th><th>{l("Montant", "Amount")}</th><th>{l("Fréquence", "Frequency")}</th><th>{l("Prochain", "Next")}</th>{manage && <th />}</tr></thead>
          <tbody>{q.data.map((r) => (
            <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}><td className="font-medium">{r.label}{r.inQuickbooks && <> <Chip>QuickBooks</Chip></>}</td><td className="text-muted">{r.vendorName ?? "—"}</td><td>{money(r.amount, loc)}</td><td>{freq(r.frequency)}</td><td>{r.upcoming ? fmtDate(r.upcoming, loc) : "—"}</td>
              {manage && <td className="whitespace-nowrap text-right"><button className="btn !p-1.5" onClick={() => setDlg({ row: r })} aria-label="edit"><Pencil size={14} /></button> <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(l("Supprimer ce paiement récurrent ?", "Delete this recurring payment?"), () => { void api(`/api/accounting/recurring/${r.id}`, { method: "DELETE" }).then(refresh).catch((e) => setError(errMsg(e, "Error"))); })}><Trash2 size={14} /></button></td>}</tr>))}</tbody></table>)}
      {dlg && <FormDialog title={dlg.row ? l("Modifier le paiement récurrent", "Edit recurring payment") : l("Paiement récurrent", "Recurring payment")} fields={fields} wide initial={dlg.row ? { ...dlg.row, vendorId: dlg.row.vendorId ?? "" } : { frequency: "monthly", active: true, nextDate: todayISO() }}
        onSubmit={async (v) => { const body = { label: v.label, vendorId: v.vendorId || null, amount: Number(v.amount), frequency: v.frequency, nextDate: v.nextDate, inQuickbooks: Boolean(v.inQuickbooks), active: Boolean(v.active) }; if (dlg.row) await api(`/api/accounting/recurring/${dlg.row.id}`, { method: "PATCH", body }); else await api("/api/accounting/recurring", { body }); await refresh(); }} onClose={() => setDlg(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={refresh} />}
    </section>
  );
}

const ERR: Record<string, [string, string]> = { amount: ["montant invalide", "invalid amount"], frequency: ["fréquence inconnue (hebdo, mensuel, annuel)", "unknown frequency (weekly, monthly, yearly)"], date: ["date invalide (AAAA-MM-JJ)", "invalid date (YYYY-MM-DD)"], empty: ["ligne vide", "empty line"] };

/** Paste rows copied from Excel, check them in a preview, then create them. */
function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<unknown> }) {
  const l = useL();
  const loc = useLocale();
  const [text, setText] = useState("");
  const [prev, setPrev] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const check = async () => { setError(""); try { setPrev(await api<Preview>("/api/accounting/recurring/import", { body: { text } })); } catch (e) { setError(errMsg(e, "Error")); } };
  const create = async () => { setError(""); try { await api("/api/accounting/recurring/import", { body: { text, commit: true } }); await onDone(); onClose(); } catch (e) { setError(errMsg(e, "Error")); } };
  return (
    <Modal title={l("Importer des paiements récurrents", "Import recurring payments")} onClose={onClose} wide>
      <p className="mb-2 text-xs text-muted">{l("Collez des lignes avec les colonnes : fournisseur, libellé, montant, fréquence (hebdo / mensuel / annuel), une date (AAAA-MM-JJ), déjà dans QuickBooks (oui/non). Une ligne d'en-tête est ignorée.", "Paste rows with the columns: vendor, label, amount, frequency (weekly / monthly / yearly), a date (YYYY-MM-DD), already in QuickBooks (yes/no). A header row is skipped.")}</p>
      <textarea className="input font-mono text-xs" rows={7} value={text} onChange={(e) => { setText(e.target.value); setPrev(null); }} placeholder={"Hydro-Québec\tÉlectricité\t320.50\tmensuel\t2026-12-05\tnon"} />
      {prev && (
        <div className="mt-3 max-h-60 overflow-auto"><table className="grid"><thead><tr><th>#</th><th>{l("Fournisseur", "Vendor")}</th><th>{l("Libellé", "Label")}</th><th>{l("Montant", "Amount")}</th><th>{l("Fréquence", "Frequency")}</th><th>{l("Date", "Date")}</th><th /></tr></thead>
          <tbody>{prev.rows.map((r) => <tr key={r.line} style={{ background: r.error ? "color-mix(in oklab, var(--danger) 14%, transparent)" : undefined }}><td>{r.line}</td><td>{r.vendor}{!r.vendorExists && r.vendor && !r.error && <span className="ml-1 text-xs text-warn">({l("nouveau", "new")})</span>}</td><td>{r.label}</td><td>{Number.isFinite(r.amount) ? money(r.amount, loc) : "—"}</td><td>{r.frequency ?? "—"}</td><td>{r.nextDate && fmtDate(r.nextDate, loc)}</td><td className="text-xs text-danger">{r.error && l(...ERR[r.error]!)}</td></tr>)}</tbody></table></div>)}
      {prev && <p className="mt-2 text-sm">{prev.ok} {l("ligne(s) valide(s)", "valid line(s)")}{prev.errors > 0 && <span className="text-danger"> · {prev.errors} {l("avec erreur : corrigez avant de créer", "with errors: fix them before creating")}</span>}{prev.newVendors.length > 0 && <span className="text-muted"> · {l("nouveaux fournisseurs", "new vendors")}: {prev.newVendors.join(", ")}</span>}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button><button className="btn" disabled={!text.trim()} onClick={() => void check()}>{l("Vérifier", "Check")}</button><button className="btn btn-primary" disabled={!prev || prev.errors > 0 || prev.ok === 0} onClick={() => void create()}>{l("Créer", "Create")}</button></div>
    </Modal>
  );
}
