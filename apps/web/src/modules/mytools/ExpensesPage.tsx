import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, FolderOpen, Paperclip, Pencil, Plus, Send, Star, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, mondayOf, addDays, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, Stat, Tabs, useClients } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

interface EType { key: string; labelFr: string; labelEn: string; unit: "none" | "km"; billable: boolean }
interface Rep { id: string; title: string; periodStart: string; periodEnd: string; state: string; count: number; totalCents: number; totalKm: number }
interface Item { id: string; spentOn: string; typeKey: string; labelFr: string; labelEn: string; unit: "none" | "km"; description: string; amountCents: number | null; km: number | null; fromPlace: string; toPlace: string; clientId: string | null; clientName: string | null; billable: boolean; hasReceipt: boolean; receiptName: string | null; status: string; rejectReason: string }
interface Detail { id: string; title: string; periodStart: string; periodEnd: string; state: string; editable: boolean; mine: boolean; items: Item[]; totalCents: number; totalKm: number }
interface Fav { id: string; label: string; typeKey: string; description: string; amountCents: number | null; km: number | null; fromPlace: string; toPlace: string; clientId: string | null; billable: boolean }

const stateTone = (s: string) => (s === "paid" || s === "decided" ? "ok" : s === "sent" ? "warn" : "off") as "ok" | "warn" | "off";
const stateText: Record<string, [string, string]> = { empty: ["Vide", "Empty"], open: ["Ouverte", "Open"], sent: ["Envoyée", "Sent"], decided: ["Traitée", "Handled"], paid: ["Payée", "Paid"] };
const itemTone = (s: string) => (s === "approved" || s === "paid" ? "ok" : s === "submitted" ? "warn" : s === "refused" ? "danger" : "off") as "ok" | "warn" | "danger" | "off";
const itemText: Record<string, [string, string]> = { draft: ["Brouillon", "Draft"], submitted: ["Envoyée", "Sent"], approved: ["Approuvée", "Approved"], refused: ["Refusée", "Refused"], paid: ["Payée", "Paid"] };

function codeText(code: string, l: (a: string, b: string) => string) {
  const m: Record<string, [string, string]> = {
    mileage_places_required: ["Indiquez le point de départ et d'arrivée du trajet.", "Enter where the trip starts and ends."], km_required: ["Indiquez les kilomètres.", "Enter the kilometres."],
    amount_required: ["Indiquez le montant.", "Enter the amount."], expense_out_of_period: ["La date doit être dans la période du rapport.", "The date must be within the report's period."],
    client_required: ["Une dépense facturable demande un client.", "A billable expense needs a client."], report_submitted: ["Le rapport est envoyé : il ne peut plus être modifié.", "The report is sent: it can no longer be changed."],
    item_locked: ["Cette dépense est déjà traitée.", "This expense is already handled."], receipt_type: ["Reçu : image (png, jpeg, gif, webp) ou PDF seulement.", "Receipt: image (png, jpeg, gif, webp) or PDF only."],
    report_period_items: ["Des dépenses sortiraient de la période.", "Some expenses would fall outside the period."], nothing_to_submit: ["Rien à envoyer.", "Nothing to send."],
    expense_billed: ["Cette dépense est déjà facturée.", "This expense is already invoiced."], own_expense: ["Vous ne pouvez pas approuver votre propre dépense.", "You cannot approve your own expense."],
  };
  return m[code] ? l(...m[code]!) : code;
}

export default function ExpensesPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const approver = can("mytools.expenses.approve");
  const [tab, setTab] = useState<"reports" | "approvals">("reports");
  const [openId, setOpenId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [newRep, setNewRep] = useState(false);
  const reps = useQuery({ queryKey: ["exp-reports", all], queryFn: () => api<Rep[]>(`/api/expenses/reports${all ? "?status=all" : ""}`) });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["exp-reports"] }); await qc.invalidateQueries({ queryKey: ["exp-report"] }); await qc.invalidateQueries({ queryKey: ["exp-approvals"] }); };

  if (openId) return <ReportView id={openId} onBack={() => { setOpenId(null); void refresh(); }} />;
  return (
    <>
      <PageHeader title={l("Dépenses", "Expenses")} subtitle={l("Un rapport par période; chaque dépense est approuvée à part", "One report per period; each expense is approved on its own")}
        actions={tab === "reports" && can("mytools.expenses.use") && <button className="btn btn-primary" onClick={() => setNewRep(true)}><Plus size={16} />{l("Nouveau rapport", "New report")}</button>} />
      {approver && <Tabs tabs={[{ key: "reports", label: l("Mes rapports", "My reports") }, { key: "approvals", label: l("À approuver", "To approve") }]} value={tab} onChange={setTab} />}
      {tab === "reports" && (
        <>
          <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={all} onChange={(e) => setAll(e.target.checked)} />{l("Afficher aussi les rapports traités et payés", "Also show handled and paid reports")}</label>
          {!reps.data?.length ? <div className="glass"><Empty>{l("Aucun rapport. Créez-en un pour la période de vos dépenses.", "No report. Create one for the period of your expenses.")}</Empty></div> : (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{reps.data.map((r) => (
              <button key={r.id} onClick={() => setOpenId(r.id)} className="glass p-4 text-left transition hover:brightness-110">
                <div className="flex items-start gap-3"><FolderOpen className="mt-0.5 shrink-0 text-brand" size={20} /><div className="min-w-0 flex-1"><div className="truncate font-medium">{r.title}</div><div className="text-xs text-muted">{fmtDate(r.periodStart, loc)} → {fmtDate(r.periodEnd, loc)}</div></div><Chip tone={stateTone(r.state)}>{l(...stateText[r.state]!)}</Chip></div>
                <div className="mt-3 text-sm text-muted">{r.count} {l("dépense(s)", "expense(s)")} · {total(r.totalCents, r.totalKm, loc, l)}</div>
              </button>))}</div>)}
        </>)}
      {tab === "approvals" && <Approvals />}
      {newRep && <NewReport onClose={() => setNewRep(false)} onDone={async (id) => { await refresh(); setOpenId(id); }} />}
    </>
  );
}

/** Dollars apart from kilometres: a trip's money is never shown to the employee. */
const total = (cents: number, km: number, loc: string, l: (a: string, b: string) => string) => [cents ? money(cents / 100, loc) : "", km ? `${km} km ${l("payés", "paid")}` : ""].filter(Boolean).join(" + ") || "0 $";

function NewReport({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => Promise<unknown> }) {
  const l = useL();
  const m = todayISO().slice(0, 7);
  const [title, setTitle] = useState(l("Dépenses ", "Expenses ") + m);
  const [from, setFrom] = useState(`${m}-01`);
  const [to, setTo] = useState(addDays(mondayOf(todayISO()), 6) > `${m}-28` ? todayISO() : `${m}-28`);
  const [error, setError] = useState("");
  return (
    <Modal title={l("Nouveau rapport de dépenses", "New expense report")} onClose={onClose}>
      <label className="mb-4 block"><span className="label">{l("Titre", "Title")}</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="grid gap-x-4 sm:grid-cols-2"><label className="mb-4 block"><span className="label">{l("Du", "From")}</span><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="mb-4 block"><span className="label">{l("Au", "To")}</span><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label></div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button>
        <button className="btn btn-primary" disabled={!title.trim()} onClick={async () => { try { const r = await api<{ id: string }>("/api/expenses/reports", { body: { title, periodStart: from, periodEnd: to } }); onClose(); await onDone(r.id); } catch (e) { setError(codeText(errMsg(e, "Error"), l)); } }}>{l("Créer", "Create")}</button></div>
    </Modal>
  );
}

function ReportView({ id, onBack }: { id: string; onBack: () => void }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["exp-report", id], queryFn: () => api<Detail>(`/api/expenses/reports/${id}`) });
  const [dlg, setDlg] = useState<null | { item?: Item; fav?: Fav }>(null);
  const [error, setError] = useState("");
  const favs = useQuery({ queryKey: ["exp-favs"], queryFn: () => api<Fav[]>("/api/expenses/favorites") });
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["exp-report", id] });
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { setError(codeText(errMsg(e, "Error"), l)); } };
  if (!d) return null;
  const groups = [...new Set(d.items.map((i) => i.typeKey))];
  const canSend = d.mine && d.items.some((i) => i.status === "draft" || i.status === "refused");

  return (
    <>
      <PageHeader title={d.title} subtitle={`${fmtDate(d.periodStart, loc)} → ${fmtDate(d.periodEnd, loc)} · ${total(d.totalCents, d.totalKm, loc, l)}`}
        actions={<div className="flex gap-2"><button className="btn" onClick={onBack}><ArrowLeft size={15} />{l("Retour", "Back")}</button>
          {d.editable && <button className="btn" onClick={() => setDlg({})}><Plus size={15} />{l("Dépense", "Expense")}</button>}
          {canSend && <button className="btn btn-primary" onClick={() => confirmDo(l("Envoyer ce rapport pour approbation ?", "Send this report for approval?"), () => void run(() => api(`/api/expenses/reports/${id}/submit`, { method: "POST" })))}><Send size={15} />{l("Envoyer", "Send")}</button>}
          {d.mine && d.state !== "paid" && <button className="btn btn-danger !p-2" aria-label="delete" onClick={() => confirmDo(l("Supprimer ce rapport et ses dépenses ?", "Delete this report and its expenses?"), () => void api(`/api/expenses/reports/${id}`, { method: "DELETE" }).then(onBack).catch((e) => setError(codeText(errMsg(e, "Error"), l))))}><Trash2 size={15} /></button>}</div>} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {d.editable && favs.data && favs.data.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2"><Star size={14} className="text-warn" />{favs.data.map((f) => <button key={f.id} className="chip hover:brightness-125" onClick={() => setDlg({ fav: f })}>{f.label}</button>)}</div>)}
      {!d.items.length && <div className="glass"><Empty>{l("Aucune dépense dans ce rapport.", "No expenses in this report.")}</Empty></div>}
      <div className="space-y-4">
        {groups.map((g) => {
          const its = d.items.filter((i) => i.typeKey === g);
          const dollars = its.filter((i) => i.unit !== "km").reduce((a, i) => a + (i.amountCents ?? 0), 0), km = its.reduce((a, i) => a + (i.unit === "km" ? i.km ?? 0 : 0), 0);
          return (
            <section key={g} className="glass p-3">
              <div className="mb-1 flex items-center justify-between px-2"><h2 className="font-semibold">{l(its[0]!.labelFr, its[0]!.labelEn)}</h2><span className="text-sm text-muted">{its.length} · {total(dollars, km, loc, l)}</span></div>
              <table className="grid"><tbody>{its.map((i) => (
                <tr key={i.id}><td className="whitespace-nowrap">{fmtDate(i.spentOn, loc)}</td>
                  <td>{i.unit === "km" ? `${i.fromPlace} → ${i.toPlace}` : i.description || "—"}{i.clientName && <span className="text-xs text-muted"> · {i.clientName}{i.billable ? ` (${l("facturable", "billable")})` : ""}</span>}{i.rejectReason && <div className="text-xs text-danger">{i.rejectReason}</div>}</td>
                  <td className="text-right font-medium">{i.unit === "km" ? `${i.km} km` : money((i.amountCents ?? 0) / 100, loc)}</td>
                  <td><Chip tone={itemTone(i.status)}>{l(...itemText[i.status]!)}</Chip></td>
                  <td className="whitespace-nowrap text-right">{i.hasReceipt && <a className="btn !p-1.5 no-underline" href={`/api/expenses/items/${i.id}/receipt`} target="_blank" rel="noopener noreferrer" aria-label="receipt"><Paperclip size={13} /></a>}{" "}
                    {d.editable && (i.status === "draft" || i.status === "refused") && <><button className="btn !p-1.5" onClick={() => setDlg({ item: i })} aria-label="edit"><Pencil size={13} /></button> <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(l("Supprimer cette dépense ?", "Delete this expense?"), () => void run(() => api(`/api/expenses/items/${i.id}`, { method: "DELETE" })))}><Trash2 size={13} /></button></>}</td></tr>))}</tbody></table>
            </section>);
        })}
      </div>
      {dlg && <ItemDialog report={d} item={dlg.item} fav={dlg.fav} onDone={async () => { await refresh(); await qc.invalidateQueries({ queryKey: ["exp-favs"] }); }} onClose={() => setDlg(null)} />}
    </>
  );
}

const readB64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(new Error("read")); r.readAsDataURL(f); });

function ItemDialog({ report, item, fav, onDone, onClose }: { report: Detail; item?: Item; fav?: Fav; onDone: () => Promise<unknown>; onClose: () => void }) {
  const l = useL();
  const clients = useClients();
  const types = useQuery({ queryKey: ["exp-types"], queryFn: () => api<EType[]>("/api/expenses/types") });
  const today = todayISO();
  const [typeKey, setTypeKey] = useState(item?.typeKey ?? fav?.typeKey ?? "");
  const [spentOn, setSpentOn] = useState(item?.spentOn ?? (today >= report.periodStart && today <= report.periodEnd ? today : report.periodStart));
  const [desc, setDesc] = useState(item?.description ?? fav?.description ?? "");
  const [amount, setAmount] = useState(item?.amountCents != null && item.unit !== "km" ? String(item.amountCents / 100) : fav?.amountCents ? String(fav.amountCents / 100) : "");
  const [km, setKm] = useState(item?.km != null ? String(item.km) : fav?.km != null ? String(fav.km) : "");
  const [from, setFrom] = useState(item?.fromPlace ?? fav?.fromPlace ?? "");
  const [to, setTo] = useState(item?.toPlace ?? fav?.toPlace ?? "");
  const [clientId, setClientId] = useState(item?.clientId ?? fav?.clientId ?? "");
  const [billable, setBillable] = useState(item?.billable ?? fav?.billable ?? false);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const t = types.data?.find((x) => x.key === (typeKey || types.data?.[0]?.key));
  const trip = t?.unit === "km";
  const tk = t?.key ?? "";

  const body = async () => {
    const b: Record<string, unknown> = { spentOn, typeKey: tk, clientId: clientId || null, billable };
    if (trip) { b.km = Number(km); b.fromPlace = from; b.toPlace = to; if (desc) b.description = desc; } else { b.amount = Number(amount); b.description = desc; }
    if (file) {
      if (file.size > 5 * 1024 * 1024) throw new Error(l("Le reçu dépasse 5 Mo.", "The receipt is over 5 MB."));
      b.receipt = { name: file.name, type: file.type, data: await readB64(file) };
    }
    return b;
  };
  const save = async (asFavorite = false) => {
    setError("");
    try {
      const b = await body();
      if (item) await api(`/api/expenses/items/${item.id}`, { method: "PATCH", body: b });
      else await api(`/api/expenses/reports/${report.id}/items`, { body: b });
      if (asFavorite) {
        const label = window.prompt(l("Nom du favori", "Favourite name"), desc || t?.labelFr);
        if (label?.trim()) await api("/api/expenses/favorites", { body: { label: label.trim(), typeKey: tk, description: desc, amount: trip ? undefined : Number(amount), km: trip ? Number(km) : undefined, fromPlace: from, toPlace: to, clientId: clientId || null, billable } });
      }
      await onDone(); onClose();
    } catch (e) { setError(codeText(errMsg(e, "Error"), l)); }
  };

  return (
    <Modal title={item ? l("Modifier la dépense", "Edit expense") : l("Nouvelle dépense", "New expense")} onClose={onClose} wide>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <label className="mb-4 block"><span className="label">{l("Type", "Type")}</span><select className="input" disabled={Boolean(item)} value={tk} onChange={(e) => { setTypeKey(e.target.value); setBillable(types.data?.find((x) => x.key === e.target.value)?.billable ?? false); }}>{types.data?.map((x) => <option key={x.key} value={x.key}>{l(x.labelFr, x.labelEn)}</option>)}</select></label>
        <label className="mb-4 block"><span className="label">{l("Date", "Date")}</span><input className="input" type="date" min={report.periodStart} max={report.periodEnd} value={spentOn} onChange={(e) => setSpentOn(e.target.value)} /></label>
        {trip ? (<>
          <label className="mb-4 block"><span className="label">{l("Départ", "From")} *</span><input className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="mb-4 block"><span className="label">{l("Arrivée", "To")} *</span><input className="input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="mb-4 block"><span className="label">{l("Kilomètres", "Kilometres")} *</span><input className="input" type="number" step="0.1" min="0" value={km} onChange={(e) => setKm(e.target.value)} /></label>
        </>) : <label className="mb-4 block"><span className="label">{l("Montant ($)", "Amount ($)")} *</span><input className="input" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
        <label className="mb-4 block sm:col-span-2"><span className="label">{l("Description", "Description")}{trip && <span className="text-muted"> ({l("optionnelle", "optional")})</span>}</span><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
        <label className="mb-4 block"><span className="label">{l("Client (refacturation)", "Client (bill back)")}</span><select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="mb-4 flex items-center gap-2 pt-6 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={billable} onChange={(e) => setBillable(e.target.checked)} />{l("Facturable au client", "Billable to the client")}</label>
        <label className="mb-4 block sm:col-span-2"><span className="label">{l("Reçu (image ou PDF, 5 Mo max)", "Receipt (image or PDF, 5 MB max)")}{item?.hasReceipt && !file && <span className="text-muted"> · {item.receiptName}</span>}</span><input className="input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button>
        {!item && <button className="btn" onClick={() => void save(true)}><Star size={14} />{l("Enregistrer et garder en favori", "Save and keep as favourite")}</button>}
        <button className="btn btn-primary" onClick={() => void save()}>{l("Enregistrer", "Save")}</button></div>
    </Modal>
  );
}

interface Group { reportId: string; title: string; userId: string; userName: string; items: Item[] }
function Approvals() {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"submitted" | "approved">("submitted");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["exp-approvals", status], queryFn: () => api<Group[]>(`/api/expenses/approvals?status=${status}`) });
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); setPicked([]); await qc.invalidateQueries({ queryKey: ["exp-approvals"] }); } catch (e) { setError(codeText(errMsg(e, "Error"), l)); } };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allIds = (q.data ?? []).flatMap((g) => g.items.map((i) => i.id));
  return (
    <>
      <Tabs tabs={[{ key: "submitted", label: l("En attente", "Waiting") }, { key: "approved", label: l("Approuvées (à rembourser)", "Approved (to repay)") }]} value={status} onChange={(s) => { setStatus(s); setPicked([]); }} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => setPicked(picked.length === allIds.length ? [] : allIds)}>{picked.length === allIds.length && allIds.length ? l("Tout désélectionner", "Select none") : l("Tout sélectionner", "Select all")}</button>
        {status === "submitted" ? (<>
          <button className="btn" disabled={!picked.length} onClick={() => void run(() => api("/api/expenses/approvals/decision", { body: { ids: picked, decision: "approve" } }))}><Check size={14} color="var(--ok)" />{l("Approuver", "Approve")} ({picked.length})</button>
          <button className="btn" disabled={!picked.length} onClick={() => { const reason = window.prompt(l("Raison du refus", "Reason for the refusal")); if (reason?.trim()) void run(() => api("/api/expenses/approvals/decision", { body: { ids: picked, decision: "refuse", reason } })); }}><X size={14} color="var(--danger)" />{l("Refuser", "Refuse")}</button>
        </>) : <button className="btn" disabled={!picked.length} onClick={() => void run(() => api("/api/expenses/approvals/paid", { body: { ids: picked, paid: true } }))}>{l("Marquer remboursées", "Mark repaid")} ({picked.length})</button>}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {!q.data?.length ? <div className="glass"><Empty>{l("Rien à traiter.", "Nothing to handle.")}</Empty></div> : q.data.map((g) => (
        <section key={g.reportId} className="glass mb-3 p-3">
          <div className="mb-1 px-2 text-sm"><b>{g.userName}</b> <span className="text-muted">· {g.title}</span></div>
          <table className="grid"><tbody>{g.items.map((i) => (
            <tr key={i.id}><td className="w-8"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={picked.includes(i.id)} onChange={() => toggle(i.id)} /></td>
              <td className="whitespace-nowrap">{fmtDate(i.spentOn, loc)}</td><td>{l(i.labelFr, i.labelEn)}</td>
              <td className="text-muted">{i.unit === "km" ? `${i.fromPlace} → ${i.toPlace}` : i.description}{i.clientName && i.billable ? ` · ${i.clientName} (${l("facturable", "billable")})` : ""}</td>
              <td className="text-right font-medium">{i.unit === "km" ? <>{i.km} km <span className="text-xs text-muted">({money((i.amountCents ?? 0) / 100, loc)})</span></> : money((i.amountCents ?? 0) / 100, loc)}</td>
              <td>{i.hasReceipt && <a className="btn !p-1.5 no-underline" href={`/api/expenses/items/${i.id}/receipt`} target="_blank" rel="noopener noreferrer" aria-label="receipt"><Paperclip size={13} /></a>}</td></tr>))}</tbody></table>
        </section>))}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label={l("Lignes", "Lines")} value={allIds.length} /></div>
    </>
  );
}
