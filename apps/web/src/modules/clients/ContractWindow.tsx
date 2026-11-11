import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { chargesFor } from "@hexa/shared/contractCharges";
import { parseCents } from "@hexa/shared/productSale";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, Stat, Tabs, type FieldDef } from "../../components/kit";
import { Modal } from "../../components/ui";

interface Line { id: string; serviceId: string | null; name: string; kind: "monthly" | "quarterly" | "yearly" | "one_time"; unitPriceCents: number; quantity: number; addedOn: string; endsOn: string | null }
interface Charge { lineId: string; name: string; date: string; periodStart: string; periodEnd: string; cents: number; days: number; periodDays: number; prorated: boolean; description: string; billed: boolean; due: boolean }
interface Detail {
  id: string; clientId: string; clientName: string; name: string; kind: "recurring" | "hourly" | "fixed" | "hours_bank"; amount: number; hourlyRate: number | null; cycle: string;
  startsOn: string; endsOn: string | null; status: "active" | "paused" | "ended"; notes: string; billingPeriod: "monthly" | "yearly"; billedThrough: string | null; supportDefault: boolean; bankHours: number | null;
  services: Line[]; charges: Charge[]; events: { kind: string; detail: string; createdAt: string; userName: string | null }[]; monthlyCents: number; dueCents: number; nextCharge: Charge | null; invoicedLines: number;
}
interface Svc { id: string; name: string; kind: "monthly" | "quarterly" | "yearly" | "one_time"; priceCents: number; active: boolean }

const KINDS = [
  { value: "recurring", label: ["Services récurrents", "Recurring services"] }, { value: "hourly", label: ["Taux horaire", "Hourly"] },
  { value: "hours_bank", label: ["Banque d'heures", "Hours bank"] }, { value: "fixed", label: ["Prix fixe", "Fixed price"] },
] as { value: string; label: [string, string] }[];
const kindLabel = (k: string, l: (a: string, b: string) => string) => { const x = KINDS.find((y) => y.value === k); return x ? l(...x.label) : k; };
const eventText: Record<string, [string, string]> = { created: ["Contrat créé", "Contract created"], updated: ["Contrat modifié", "Contract updated"], stopped: ["Contrat arrêté", "Contract stopped"], resumed: ["Contrat réactivé", "Contract resumed"], service_added: ["Service ajouté", "Service added"], service_changed: ["Service modifié", "Service changed"], service_removed: ["Service retiré", "Service removed"] };

export function codeText(code: string, l: (a: string, b: string) => string) {
  const m: Record<string, [string, string]> = {
    contract_dates: ["La fin doit être après le début.", "The end must be after the start."], contract_dates_services: ["Un service sortirait de la durée du contrat.", "A service would fall outside the contract term."],
    service_outside_term: ["La date du service doit être dans la durée du contrat.", "The service date must be within the contract term."], contract_billed: ["Ce contrat a déjà généré de la facturation : arrêtez-le plutôt que de le supprimer.", "This contract has already billed: stop it instead of deleting it."],
    contract_not_recurring: ["Seul un contrat de services récurrents a des services.", "Only a recurring-services contract has services."], forbidden: ["Vous n'avez pas le droit de modifier la facturation.", "You are not allowed to change billing."],
    service_inactive: ["Ce service est désactivé : il ne peut plus être ajouté.", "This service is turned off: it can no longer be added."], service_is_product: ["Ce service est un produit (vente unique), pas un service récurrent.", "This service is a product (one-time sale), not a recurring service."],
    not_a_product: ["Ce service n'est pas un produit.", "This service is not a product."], client_inactive: ["Ce client est inactif.", "This client is inactive."], service_not_found: ["Service introuvable.", "Service not found."], service_dates: ["La date de fin doit être après le début.", "The end must be after the start."],
    price_invalid: ["Prix invalide (0 à 1 000 000 $).", "Invalid price (0 to 1,000,000 $)."], quantity_invalid: ["Quantité invalide (0,01 à 1000, 2 décimales).", "Invalid quantity (0.01 to 1000, 2 decimals)."], total_zero: ["Le total ne peut pas être 0 $.", "The total cannot be $0."], total_too_large: ["Le total dépasse 1 000 000 $.", "The total is over $1,000,000."],
    duplicate_recent: ["Cette vente vient d'être enregistrée.", "This sale was just recorded."], date_invalid: ["Date invalide.", "Invalid date."],
    contact_no_email: ["Ce contact n'a pas de courriel.", "This contact has no email."], client_has_history: ["Ce client a un historique : désactivez-le.", "This client has history: deactivate it."],
  };
  return m[code] ? l(...m[code]!) : code;
}

export function NewContractDialog({ clientId, onDone, onClose }: { clientId: string; onDone: (id: string) => Promise<unknown>; onClose: () => void }) {
  const l = useL();
  const { can } = useAuth();
  const billing = can("clients.billing.manage");
  const billingFields: FieldDef[] = billing ? [
    { name: "hourlyRate", label: ["Taux horaire ($)", "Hourly rate ($)"], type: "number", step: "0.01", hint: ["0 = heures incluses (non facturées)", "0 = hours included (not billed)"] },
    { name: "bankHours", label: ["Heures de la banque", "Bank hours"], type: "number", step: "0.25" },
    { name: "amount", label: ["Montant fixe ($)", "Fixed amount ($)"], type: "number", step: "0.01" },
  ] : [];
  const fields: FieldDef[] = [
    { name: "name", label: ["Nom du contrat", "Contract name"], required: true, span: 2 },
    { name: "kind", label: ["Type", "Type"], type: "select", required: true, options: KINDS },
    { name: "billingPeriod", label: ["Facturé", "Charged"], type: "select", options: [{ value: "monthly", label: ["Chaque mois", "Monthly"] }, { value: "yearly", label: ["Chaque année", "Yearly"] }], hint: ["Pour un contrat de services récurrents", "For a recurring-services contract"] },
    { name: "startsOn", label: ["Début", "Start"], type: "date", required: true }, { name: "endsOn", label: ["Fin", "End"], type: "date" },
    ...billingFields,
    { name: "supportDefault", label: ["Contrat par défaut du client", "Client's default contract"], type: "checkbox" },
    { name: "notes", label: ["Notes", "Notes"], type: "textarea" },
  ];
  const num = (v: unknown) => (v === "" || v === undefined || v === null ? undefined : Number(v));
  return (
    <FormDialog title={l("Nouveau contrat", "New contract")} fields={fields} wide initial={{ kind: "recurring", billingPeriod: "monthly", startsOn: todayISO() }}
      onSubmit={async (v) => {
        const body: Record<string, unknown> = { name: v.name, kind: v.kind, startsOn: v.startsOn, endsOn: v.endsOn || null, supportDefault: Boolean(v.supportDefault), notes: v.notes ?? "" };
        if (billing) { body.billingPeriod = v.billingPeriod; const h = num(v.hourlyRate); if (h !== undefined) body.hourlyRate = h; const b = num(v.bankHours); if (b !== undefined) body.bankHours = b; const a = num(v.amount); if (a !== undefined) body.amount = a; }
        const r = await api<{ id: string }>(`/api/clients/${clientId}/contracts`, { body });
        await onDone(r.id);
      }} onClose={onClose} />
  );
}

/** One contract: its services, the schedule of charges (with prorata), its terms and its history. */
export function ContractWindow({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const billing = can("clients.billing.manage");
  const edit = can("clients.contracts.edit");
  const q = useQuery({ queryKey: ["contract", id], queryFn: () => api<Detail>(`/api/clients/contracts/${id}`) });
  const k = q.data;
  const [tab, setTab] = useState<"services" | "charges" | "contract" | "activity">("services");
  const [error, setError] = useState("");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["contract", id] }); await onChanged(); };
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { setError(codeText(errMsg(e, "Error"), l)); } };
  if (!k) return null;
  const recurring = k.kind === "recurring";
  const tabs = [...(recurring ? [{ key: "services" as const, label: l("Services", "Services") }, { key: "charges" as const, label: l("Charges", "Charges") }] : []), { key: "contract" as const, label: l("Contrat", "Contract") }, { key: "activity" as const, label: l("Activité", "Activity") }];
  const cur = recurring ? tab : tab === "services" || tab === "charges" ? "contract" : tab;

  return (
    <Modal title={`${k.name} · ${k.clientName}`} onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip tone={k.status === "active" ? "ok" : "off"}>{k.status === "active" ? l("Actif", "Active") : k.status === "paused" ? l("En pause", "Paused") : l("Terminé", "Ended")}</Chip>
        <Chip>{kindLabel(k.kind, l)}</Chip>{k.supportDefault && <Chip tone="warn">{l("Contrat par défaut", "Default contract")}</Chip>}
        <span className="text-xs text-muted">{fmtDate(k.startsOn, loc)}{k.endsOn ? ` → ${fmtDate(k.endsOn, loc)}` : ""}</span>
      </div>
      {recurring && <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={l("Par mois", "Per month")} value={money(k.monthlyCents / 100, loc)} /><Stat label={l("Dû (à facturer)", "Due (to bill)")} value={money(k.dueCents / 100, loc)} tone={k.dueCents ? "warn" : undefined} />
        <Stat label={l("Prochaine charge", "Next charge")} value={k.nextCharge ? money(k.nextCharge.cents / 100, loc) : "—"} /><Stat label={l("Prochaine date", "Next date")} value={k.nextCharge ? fmtDate(k.nextCharge.date, loc) : "—"} />
      </div>}
      <Tabs tabs={tabs} value={cur as typeof tab} onChange={setTab} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      {cur === "services" && <Services k={k} edit={edit} billing={billing} run={run} />}
      {cur === "charges" && (
        <div className="glass-flat overflow-x-auto p-1">
          {!k.charges.length ? <Empty>{l("Ajoutez des services pour voir le calendrier des charges.", "Add services to see the charge schedule.")}</Empty> : (
            <table className="grid"><thead><tr><th>{l("Date", "Date")}</th><th>{l("Description", "Description")}</th><th>{l("Montant", "Amount")}</th><th>{l("État", "State")}</th></tr></thead>
              <tbody>{k.charges.slice(0, 80).map((ch, i) => (
                <tr key={i} style={{ opacity: ch.billed ? 0.55 : 1 }}><td className="whitespace-nowrap">{fmtDate(ch.date, loc)}</td>
                  <td>{ch.description}{ch.prorated && <span className="ml-2 text-xs text-warn">{l("prorata", "prorated")} {ch.days}/{ch.periodDays} j</span>}</td><td>{money(ch.cents / 100, loc)}</td>
                  <td>{ch.billed ? <Chip>{l("Déjà facturé", "Already invoiced")}</Chip> : ch.due ? <Chip tone="warn">{l("Dû", "Due")}</Chip> : <Chip tone="off">{l("À venir", "Upcoming")}</Chip>}</td></tr>))}</tbody></table>)}
          <p className="p-3 text-xs text-muted">{l("Le travail à facturer se génère à partir de cette liste (bouton « Générer » de la page Contrats). Les charges jusqu'à « Facturé jusqu'au » sont ignorées.", "Work to bill is made from this list (the \"Generate\" button on the Contracts page). Charges up to \"Billed through\" are skipped.")}</p>
        </div>)}
      {cur === "contract" && <Terms k={k} edit={edit} billing={billing} run={run} onClose={onClose} />}
      {cur === "activity" && (
        <div className="glass-flat p-3">
          {!k.events.length ? <Empty>—</Empty> : k.events.map((e, i) => (
            <div key={i} className="flex gap-3 border-b border-white/5 py-2 text-sm last:border-0"><span className="w-36 shrink-0 text-xs text-muted">{new Date(e.createdAt).toLocaleString(loc)}</span><span><b>{l(...(eventText[e.kind] ?? [e.kind, e.kind]))}</b> {e.detail && <span className="text-muted">· {e.detail}</span>} {e.userName && <span className="text-xs text-muted">({e.userName})</span>}</span></div>))}
        </div>)}
    </Modal>
  );
}

function Services({ k, edit, billing, run }: { k: Detail; edit: boolean; billing: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const l = useL();
  const loc = useLocale();
  const cat = useQuery({ queryKey: ["svc-catalogue"], queryFn: () => api<Svc[]>("/api/services") });
  const [sel, setSel] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"monthly" | "quarterly" | "yearly" | "one_time">("monthly");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [day, setDay] = useState(todayISO() < k.startsOn ? k.startsOn : todayISO());
  const chosen = cat.data?.find((s) => s.id === sel);
  const priceCents = price === "" ? null : parseCents(price);
  const unit = billing && priceCents != null ? priceCents : chosen?.priceCents ?? 0;
  const [endDay, setEndDay] = useState("");
  const eff = chosen?.kind ?? kind;
  // The prorata of the first charge, worked out by the same function the server uses.
  const preview = (name || chosen) && day ? chargesFor({ billingPeriod: k.billingPeriod, startsOn: k.startsOn, endsOn: k.endsOn }, [{ id: "p", name: chosen?.name ?? name, kind: eff, priceCents: unit, quantity: Number(qty) || 1, addedOn: day, endsOn: endDay || null }], day.slice(0, 4) + "-12-31")[0] : null;
  return (
    <>
      <div className="glass-flat mb-4 overflow-x-auto p-1">
        {!k.services.length ? <Empty>{l("Aucun service sur ce contrat.", "No services on this contract.")}</Empty> : (
          <table className="grid"><thead><tr><th>{l("Service", "Service")}</th><th>{l("Quantité", "Qty")}</th><th>{l("Prix", "Price")}</th><th>{l("Période", "Period")}</th><th /></tr></thead>
            <tbody>{k.services.map((s) => (
              <tr key={s.id}><td className="font-medium">{s.name} <span className="text-xs text-muted">· {s.kind === "monthly" ? l("mensuel", "monthly") : s.kind === "quarterly" ? l("trimestriel", "quarterly") : s.kind === "yearly" ? l("annuel", "yearly") : l("ponctuel", "one time")}</span></td><td>× {s.quantity}</td><td>{money(s.unitPriceCents / 100, loc)}</td><td>{fmtDate(s.addedOn, loc)}{s.endsOn && <> → {fmtDate(s.endsOn, loc)}</>}</td>
                <td className="text-right">{edit && <button className="btn btn-danger !p-1.5" aria-label="remove" onClick={() => confirmDo(l("Retirer ce service du contrat ?", "Remove this service from the contract?"), () => void run(() => api(`/api/clients/contracts/${k.id}/services/${s.id}`, { method: "DELETE" })))}><Trash2 size={13} /></button>}</td></tr>))}</tbody></table>)}
      </div>
      {edit && (
        <div className="glass-flat p-3">
          <div className="mb-2 text-sm font-medium">{l("Ajouter un service", "Add a service")}</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-[200px] flex-1"><span className="label">{l("Du catalogue", "From the catalogue")}</span><select className="input" value={sel} onChange={(e) => { setSel(e.target.value); setPrice(""); }}><option value="">{l("— un service sur mesure —", "— a custom service —")}</option>{cat.data?.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name} ({money(s.priceCents / 100, loc)})</option>)}</select></label>
            {!sel && <><label><span className="label">{l("Nom", "Name")}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label><span className="label">{l("Type", "Type")}</span><select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="monthly">{l("Mensuel", "Monthly")}</option><option value="quarterly">{l("Trimestriel", "Quarterly")}</option><option value="yearly">{l("Annuel", "Yearly")}</option><option value="one_time">{l("Ponctuel", "One time")}</option></select></label></>}
            {billing && <label><span className="label">{l("Prix ($)", "Price ($)")}</span><input className="input !w-28" type="text" inputMode="decimal" placeholder={chosen ? String(chosen.priceCents / 100) : "0"} value={price} onChange={(e) => setPrice(e.target.value)} /></label>}
            <label><span className="label">{l("Quantité", "Qty")}</span><input className="input !w-20" type="number" step="0.01" min="0.01" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
            <label><span className="label">{l("Commence le", "Starts")}</span><input className="input" type="date" min={k.startsOn} max={k.endsOn ?? undefined} value={day} onChange={(e) => setDay(e.target.value)} /></label>
            <label><span className="label">{l("Se termine le", "Ends")}</span><input className="input" type="date" min={day} max={k.endsOn ?? undefined} value={endDay} onChange={(e) => setEndDay(e.target.value)} /></label>
            <button className="btn btn-primary" disabled={(!sel && !name.trim()) || (price !== "" && priceCents == null)} onClick={() => void run(async () => { await api(`/api/clients/contracts/${k.id}/services`, { body: { serviceId: sel || undefined, name: sel ? undefined : name, kind: sel ? undefined : kind, priceCents: billing && priceCents != null ? priceCents : undefined, quantity: Number(qty) || 1, addedOn: day, endsOn: endDay || null } }); setSel(""); setName(""); setPrice(""); setEndDay(""); })}><Plus size={15} />{l("Ajouter", "Add")}</button>
          </div>
          {preview && <p className="mt-2 text-xs text-muted">{l("Première charge", "First charge")}: <b>{money(preview.cents / 100, loc)}</b> {preview.prorated ? `(${l("prorata", "prorated")} ${preview.days}/${preview.periodDays} ${l("jours", "days")})` : `(${l("période complète", "full period")})`} · {fmtDate(preview.date, loc)}</p>}
        </div>)}
    </>
  );
}

function Terms({ k, edit, billing, run, onClose }: { k: Detail; edit: boolean; billing: boolean; run: (fn: () => Promise<unknown>) => Promise<void>; onClose: () => void }) {
  const l = useL();
  const { can } = useAuth();
  const [v, setV] = useState({ name: k.name, startsOn: k.startsOn, endsOn: k.endsOn ?? "", billingPeriod: k.billingPeriod, hourlyRate: k.hourlyRate != null ? String(k.hourlyRate) : "", amount: String(k.amount ?? 0), bankHours: k.bankHours != null ? String(k.bankHours) : "", billedThrough: k.billedThrough ?? "", supportDefault: k.supportDefault, notes: k.notes });
  const set = (p: Partial<typeof v>) => setV({ ...v, ...p });
  const dis = !edit;
  const save = () => run(() => api(`/api/clients/contracts/${k.id}`, { method: "PATCH", body: {
    name: v.name, startsOn: v.startsOn, endsOn: v.endsOn || null, supportDefault: v.supportDefault, notes: v.notes,
    ...(billing ? { billingPeriod: v.billingPeriod, hourlyRate: v.hourlyRate === "" ? null : Number(v.hourlyRate), amount: Number(v.amount) || 0, bankHours: v.bankHours === "" ? null : Number(v.bankHours), billedThrough: v.billedThrough || null } : {}),
  } }));
  return (
    <>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <label className="mb-4 block sm:col-span-2"><span className="label">{l("Nom", "Name")}</span><input className="input" disabled={dis} value={v.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="mb-4 block"><span className="label">{l("Début", "Start")}</span><input className="input" type="date" disabled={dis} value={v.startsOn} onChange={(e) => set({ startsOn: e.target.value })} /></label>
        <label className="mb-4 block"><span className="label">{l("Fin", "End")}</span><input className="input" type="date" disabled={dis} value={v.endsOn} onChange={(e) => set({ endsOn: e.target.value })} /></label>
        {k.kind === "recurring" && <label className="mb-4 block"><span className="label">{l("Facturé", "Charged")}</span><select className="input" disabled={!billing} value={v.billingPeriod} onChange={(e) => set({ billingPeriod: e.target.value as "monthly" | "yearly" })}><option value="monthly">{l("Chaque mois", "Monthly")}</option><option value="yearly">{l("Chaque année", "Yearly")}</option></select></label>}
        {k.kind === "recurring" && <label className="mb-4 block"><span className="label">{l("Facturé jusqu'au", "Billed through")}</span><input className="input" type="date" disabled={!billing} value={v.billedThrough} onChange={(e) => set({ billedThrough: e.target.value })} /><span className="mt-1 block text-xs text-muted">{l("Les charges jusqu'à cette date sont déjà facturées ailleurs.", "Charges up to this day were already invoiced elsewhere.")}</span></label>}
        {(k.kind === "hourly" || k.kind === "hours_bank") && <label className="mb-4 block"><span className="label">{l("Taux horaire ($)", "Hourly rate ($)")}</span><input className="input" type="number" step="0.01" disabled={!billing} value={v.hourlyRate} onChange={(e) => set({ hourlyRate: e.target.value })} /><span className="mt-1 block text-xs text-muted">{l("0 = heures incluses (non facturées)", "0 = hours included (not billed)")}</span></label>}
        {k.kind === "hours_bank" && <label className="mb-4 block"><span className="label">{l("Heures de la banque", "Bank hours")}</span><input className="input" type="number" step="0.25" disabled={!billing} value={v.bankHours} onChange={(e) => set({ bankHours: e.target.value })} /></label>}
        {k.kind === "fixed" && <label className="mb-4 block"><span className="label">{l("Montant fixe ($)", "Fixed amount ($)")}</span><input className="input" type="number" step="0.01" disabled={!billing} value={v.amount} onChange={(e) => set({ amount: e.target.value })} /></label>}
        <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={dis} checked={v.supportDefault} onChange={(e) => set({ supportDefault: e.target.checked })} />{l("Contrat par défaut du client", "Client's default contract")}</label>
        <label className="mb-4 block sm:col-span-2"><span className="label">{l("Notes", "Notes")}</span><textarea className="input" rows={3} disabled={dis} value={v.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      </div>
      {edit && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            {k.status === "active" ? <button className="btn" onClick={() => confirmDo(l("Arrêter ce contrat ? Il garde son historique.", "Stop this contract? It keeps its history."), () => void run(() => api(`/api/clients/contracts/${k.id}`, { method: "PATCH", body: { status: "ended", endsOn: k.endsOn ?? todayISO() } })))}>{l("Arrêter", "Stop")}</button>
              : <button className="btn" onClick={() => void run(() => api(`/api/clients/contracts/${k.id}`, { method: "PATCH", body: { status: "active" } }))}>{l("Réactiver", "Resume")}</button>}
            {can("clients.contracts.edit") && <button className="btn btn-danger" onClick={() => confirmDo(l("Supprimer ce contrat ?", "Delete this contract?"), () => void run(async () => { await api(`/api/clients/contracts/${k.id}`, { method: "DELETE" }); onClose(); }))}><Trash2 size={14} />{l("Supprimer", "Delete")}</button>}
          </div>
          <button className="btn btn-primary" onClick={() => void save()}>{l("Enregistrer", "Save")}</button>
        </div>)}
    </>
  );
}
