import { PortalAccess } from "./PortalAccess";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, Receipt, Star, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, Tabs, useUsers, type FieldDef } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";
import { TrackingView } from "./TrackingPage";
import { ClassChip, cleanClientBody, clientFields, freqLabel, referralLabel, statusTone, TypeChip, type ClientClass } from "./ClientsPage";
import { ClientLinks, type Relation } from "./ClientLinks";
import { viewLabel, viewTone } from "../accounting/InvoiceDialog";
import { ContractWindow, NewContractDialog, codeText } from "./ContractWindow";
import { ClientProducts } from "./ClientProducts";
import type { TaskRow } from "../tasks/TasksPage";

interface Contact { id: string; name: string; email: string; phone: string; title: string; isPrimary: boolean; isBilling: boolean; notes: string }
interface Contract { id: string; name: string; kind: string; amount: number; hourlyRate: number | null; cycle: string; startsOn: string | null; endsOn: string | null; status: string; billingPeriod: string; supportDefault: boolean; serviceCount: number }
interface Detail {
  id: string; name: string; legalName: string; status: "active" | "inactive" | "prospect"; parentId: string | null; parentName: string | null; classKey: string | null; classLabelFr: string | null; classLabelEn: string | null; classColor: string | null;
  billingEmail: string; billingContactId: string | null; termsDays?: number | null; poRequired?: boolean; autoApproveKinds?: string[]; invoiceNotes?: string;
  resource?: { id: string | null; name: string | null; email: string | null; phone: string; label: string }; contacts: Contact[]; contracts: Contract[]; children: { id: string; name: string }[];
  clientType: string; parent: { id: string; name: string } | null; relations: Relation[];
  referralSource: string; referralName: string; referralClientId: string | null; referralClientName: string | null; referralDetail: string; [k: string]: unknown;
}
interface InvoiceRow { id: string; number: string; status: string; view: string; total: number; balance: number; issueDate: string; dueDate: string }
type Tab = "info" | "contacts" | "contracts" | "tasks" | "invoices" | "billing" | "tracking";

export default function ClientDetail() {
  const { id = "" } = useParams();
  const l = useL();
  const loc = useLocale();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab | "">("");
  const [dialog, setDialog] = useState<null | { kind: "client" } | { kind: "contact"; row?: Contact } | { kind: "newContract" } | { kind: "order" }>(null);
  const [openContract, setOpenContract] = useState<string | null>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["client", id], queryFn: () => api<Detail>(`/api/clients/${id}`) });
  const order = useQuery({ queryKey: ["client-tab-order"], queryFn: () => api<{ order: Tab[] }>("/api/clients/tab-order") });
  const classes = useQuery({ queryKey: ["client-classes"], queryFn: () => api<ClientClass[]>("/api/clients/classes") });
  const invoiceRight = can("accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage");
  const billingRight = can("clients.billing.manage") || invoiceRight;
  const users = useUsers();
  const c = q.data;
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["client", id] }); await qc.invalidateQueries({ queryKey: ["clients"] }); };

  const allowed: Record<Tab, boolean> = {
    info: true, contacts: can("clients.contacts.view"), contracts: can("clients.contracts.view"), tasks: can("tasks.view", "command.pipeline.view"), invoices: invoiceRight, billing: billingRight, tracking: can("clients.tracking.view", "clients.tracking.edit"),
  };
  const labels: Record<Tab, string> = {
    info: l("Infos", "Info"), contacts: `${l("Contacts", "Contacts")}${c ? ` (${c.contacts.length})` : ""}`, contracts: `${l("Contrats", "Contracts")}${c ? ` (${c.contracts.length})` : ""}`,
    tasks: l("Tâches", "Tasks"), invoices: l("Factures", "Invoices"), billing: l("Facturation", "Invoicing"), tracking: l("Suivi fiscal", "Tax follow-up"),
  };
  const ordered = (order.data?.order ?? (["info", "contacts", "contracts", "tasks", "invoices", "billing", "tracking"] as Tab[])).filter((k) => allowed[k]);
  // The first tab of the shared order is the one a client page opens on.
  const active = (tab && ordered.includes(tab) ? tab : ordered[0] ?? "info") as Tab;

  const tasks = useQuery({ queryKey: ["client-tasks", id], queryFn: () => api<TaskRow[]>(`/api/tasks?client=${id}&status=all`), enabled: active === "tasks" && allowed.tasks });
  const invoices = useQuery({ queryKey: ["client-invoices", id], queryFn: () => api<InvoiceRow[]>(`/api/accounting/invoices?client=${id}`), enabled: active === "invoices" && invoiceRight });
  if (!c) return null;

  const contactFields: FieldDef[] = [
    { name: "name", label: ["Nom", "Name"], required: true }, { name: "title", label: ["Titre", "Title"] },
    { name: "email", label: ["Courriel", "Email"], type: "email" }, { name: "phone", label: ["Téléphone", "Phone"] },
    { name: "notes", label: ["Notes", "Notes"], type: "textarea" },
  ];
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { setError(codeText(errMsg(e, "Error"), l)); } };
  const billingBy = (k: Contact) => run(() => api(`/api/clients/${id}/billing-contact`, { method: "PUT", body: { contactId: k.isBilling ? null : k.id } }));
  const primaryBy = (k: Contact) => run(() => api(`/api/clients/${id}/primary-contact`, { method: "PUT", body: { contactId: k.isPrimary ? null : k.id } }));
  const del = (path: string, ask: string) => confirmDo(ask, () => void run(() => api(path, { method: "DELETE" })));

  return (
    <>
      <Link to="/clients" className="mb-3 inline-flex items-center gap-1 text-sm text-muted no-underline hover:text-white"><ArrowLeft size={14} />{l("Clients", "Clients")}</Link>
      <PageHeader title={c.name} subtitle={c.legalName || undefined}
        actions={<div className="flex items-center gap-2"><TypeChip t={c.clientType} /><ClassChip fr={c.classLabelFr} en={c.classLabelEn} color={c.classColor} /><Chip tone={statusTone(c.status)}>● {c.status}</Chip>{can("clients.edit") && <button className="btn" onClick={() => setDialog({ kind: "client" })}><Pencil size={15} />{l("Modifier", "Edit")}</button>}</div>} />
      <div className="flex flex-wrap items-start gap-2">
        <Tabs tabs={ordered.map((k) => ({ key: k, label: labels[k] }))} value={active} onChange={setTab} />
        {can("clients.layout.manage") && <button className="btn !py-1.5 text-xs" onClick={() => setDialog({ kind: "order" })}>{l("Ordre des onglets", "Tab order")}</button>}
      </div>
      {c.resource && (() => {
        const r = c.resource;
        const edit = can("clients.tracking.edit");
        const setRes = (body: object) => void run(() => api(`/api/tracking/${id}/settings`, { method: "PUT", body }).then(() => qc.invalidateQueries({ queryKey: ["tracking"] })));
        return (
          <section className="glass mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
            <div className="min-w-0"><div className="text-xs uppercase tracking-wide text-muted">{l("Personne ressource", "Resource person")}</div>
              <div className="text-lg font-semibold">{r.name ?? (r.label || <span className="text-muted">{l("Non assignée", "Not assigned")}</span>)}</div>
              {!r.id && r.label && <div className="text-xs text-muted">{l("Nom importé, non lié à un employé", "Imported name, not linked to a staff member")}</div>}</div>
            {r.id && <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <div>{r.phone ? <a href={`tel:${r.phone.replace(/[^0-9+]/g, "")}`}>{r.phone}</a> : <span className="text-muted">{l("Aucun téléphone", "No phone")}</span>}</div>
              <div>{r.email && <a href={`mailto:${r.email}`}>{r.email}</a>}</div></div>}
            {edit && <select className="input !w-auto !py-1 sm:ml-auto" aria-label={l("Personne ressource", "Resource person")} value={r.id ?? ""} onChange={(e) => setRes({ resourceId: e.target.value || null, ...(e.target.value ? { resourceLabel: "" } : {}) })}>
              <option value="">{r.label ? l(`— Lier « ${r.label} » à un employé —`, `— Link "${r.label}" to a staff member —`) : "—"}</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
          </section>);
      })()}
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      {active === "info" && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="glass p-5">
            <dl className="space-y-2 text-sm">
              {([["email", l("Courriel", "Email")], ["phone", l("Téléphone", "Phone")], ["website", l("Site web", "Website")], ["businessNumber", l("Numéro d'entreprise (NE)", "Business number (NE)")], ["identificationNumber", l("Numéro d'identification (NI)", "Identification number (NI)")], ["neq", "NEQ"], ["ccq", "CCQ"], ["rbq", "RBQ"], ["fiscalYearEnd", l("Fin d'exercice", "Fiscal year end")], ["software", l("Logiciel utilisé", "Software used")]] as const).map(([k, label]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd>{String(c[k] ?? "") || "—"}</dd></div>
              ))}
              {([["tax", l("Taxes", "Taxes")], ["das", "DAS"]] as const).map(([p, label]) => {
                const fr = freqLabel(String(c[`${p}Frequency`] ?? ""));
                const txt = [fr && l(...fr), String(c[`${p}Date`] ?? "")].filter(Boolean).join(" · ");
                return <div key={p} className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd>{txt || "—"}</dd></div>;
              })}
              <div className="flex justify-between gap-3"><dt className="text-muted">{l("Courriel de facturation", "Billing email")}</dt><dd>{c.billingEmail || <span style={{ color: "var(--danger)" }}>{l("Aucun", "None")}</span>}</dd></div>
              <div className="flex items-center justify-between gap-3"><dt className="text-muted">{l("Classification", "Classification")}</dt>
                <dd>{can("clients.edit") ? <select className="input !w-auto !py-1" value={c.classKey ?? ""} onChange={(e) => void run(() => api(`/api/clients/${id}`, { method: "PATCH", body: { classKey: e.target.value || null } }))}><option value="">—</option>{classes.data?.map((k) => <option key={k.key} value={k.key}>{l(k.labelFr, k.labelEn)}</option>)}</select> : <ClassChip fr={c.classLabelFr} en={c.classLabelEn} color={c.classColor} />}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">{l("Adresse", "Address")}</dt><dd className="text-right">{[c.address, c.city, c.province, c.postalCode].filter(Boolean).join(", ") || "—"}</dd></div>
              {c.referralSource && <div className="flex justify-between gap-3"><dt className="text-muted">{l("Référence", "Referral")}</dt><dd className="text-right">{l(...referralLabel(c.referralSource)!)}
                {c.referralSource === "word_of_mouth" && (c.referralClientId ? <> · <Link to={`/clients/${c.referralClientId}`}>{c.referralClientName}</Link></> : null)}
                {c.referralSource === "word_of_mouth" && c.referralName ? ` · ${c.referralName}` : ""}{c.referralSource === "other" && c.referralDetail ? ` · ${c.referralDetail}` : ""}</dd></div>}
            </dl>
          </section>
          <div>
            <ClientLinks clientId={id} parent={c.parent} children={c.children} relations={c.relations} onChanged={refresh} />
            <section className="glass p-5">
              <h2 className="mb-2 font-semibold">{l("Notes", "Notes")}</h2>
              <p className="whitespace-pre-wrap text-sm text-muted">{String(c.notes ?? "") || "—"}</p>
            </section>
          </div>
        </div>
      )}

      {active === "tracking" && <TrackingView clientId={id} />}

      {active === "contacts" && (
        <section>
          <div className="mb-3 flex items-center justify-between"><p className="text-xs text-muted">{l("★ contact principal · reçu = contact de facturation (son courriel reçoit les factures)", "★ main contact · receipt = billing contact (its email receives invoices)")}</p>
            {can("clients.contacts.edit") && <button className="btn btn-primary" onClick={() => setDialog({ kind: "contact" })}><Plus size={15} />{l("Contact", "Contact")}</button>}</div>
          {c.contacts.length === 0 ? <div className="glass"><Empty>{l("Aucun contact.", "No contacts.")}</Empty></div> : (
            <div className="grid gap-3 md:grid-cols-2">{c.contacts.map((k) => (
              <div key={k.id} className="glass p-4" style={k.isPrimary ? { borderColor: "var(--warn)" } : k.isBilling ? { borderColor: "var(--ok)" } : undefined}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><div className="font-medium">{k.name}</div><div className="text-xs text-muted">{k.title}</div></div>
                  <div className="flex shrink-0 gap-1">
                    {can("clients.contacts.edit") && <button className="btn !p-1.5" title={l("Contact principal", "Main contact")} onClick={() => void primaryBy(k)}><Star size={14} fill={k.isPrimary ? "var(--warn)" : "none"} color={k.isPrimary ? "var(--warn)" : undefined} /></button>}
                    {can("clients.billing.manage") && <button className="btn !p-1.5" title={l("Contact de facturation", "Billing contact")} onClick={() => void billingBy(k)}><Receipt size={14} color={k.isBilling ? "var(--ok)" : undefined} /></button>}
                    {can("clients.contacts.edit") && <><button className="btn !p-1.5" onClick={() => setDialog({ kind: "contact", row: k })} aria-label="edit"><Pencil size={14} /></button><button className="btn btn-danger !p-1.5" onClick={() => del(`/api/clients/contacts/${k.id}`, l("Supprimer ce contact ?", "Delete this contact?"))} aria-label="delete"><Trash2 size={14} /></button></>}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">{k.isPrimary && <Chip tone="warn">{l("Principal", "Main")}</Chip>}{k.isBilling && <Chip tone="ok">{l("Facturation", "Billing")}</Chip>}</div>
                <div className="mt-2 text-sm text-muted">{[k.email, k.phone].filter(Boolean).join(" · ") || "—"}</div>
              </div>))}</div>)}
          <PortalAccess clientId={id} />
        </section>
      )}

      {active === "contracts" && (
        <>
        <section className="glass p-2">
          <div className="flex justify-end p-2">{can("clients.contracts.edit") && <button className="btn btn-primary" onClick={() => setDialog({ kind: "newContract" })}><Plus size={15} />{l("Contrat", "Contract")}</button>}</div>
          {c.contracts.length === 0 ? <Empty>{l("Aucun contrat.", "No contracts.")}</Empty> : (
            <table className="grid"><tbody>{c.contracts.map((k) => (
              <tr key={k.id} className="cursor-pointer" onClick={() => setOpenContract(k.id)} style={{ opacity: k.status === "active" ? 1 : 0.55 }}>
                <td><div className="font-medium">{k.name} {k.supportDefault && <Chip tone="warn">{l("Par défaut", "Default")}</Chip>}</div><div className="text-xs text-muted">{k.kind === "recurring" ? `${l("Services récurrents", "Recurring services")} · ${k.serviceCount} ${l("service(s)", "service(s)")} · ${k.billingPeriod === "yearly" ? l("annuel", "yearly") : l("mensuel", "monthly")}` : k.kind === "hourly" ? l("Taux horaire", "Hourly") : k.kind === "hours_bank" ? l("Banque d'heures", "Hours bank") : l("Prix fixe", "Fixed price")}{k.startsOn ? ` · ${fmtDate(k.startsOn, loc)}` : ""}{k.endsOn ? ` → ${fmtDate(k.endsOn, loc)}` : ""}</div></td>
                <td>{k.kind === "hourly" || k.kind === "hours_bank" ? (k.hourlyRate != null ? (Number(k.hourlyRate) === 0 ? l("Heures incluses", "Hours included") : `${money(k.hourlyRate, loc)}/h`) : "—") : k.kind === "fixed" ? money(k.amount, loc) : ""}</td>
                <td><Chip tone={k.status === "active" ? "ok" : "off"}>{k.status === "active" ? l("Actif", "Active") : k.status === "paused" ? l("En pause", "Paused") : l("Terminé", "Ended")}</Chip></td></tr>))}</tbody></table>)}
        </section>
        <ClientProducts clientId={id} onChanged={refresh} />
        </>
      )}

      {active === "tasks" && (
        <section className="glass p-2">
          {!tasks.data?.length ? <Empty>{l("Aucune tâche pour ce client.", "No tasks for this client.")}</Empty> : (
            <table className="grid"><tbody>{tasks.data.map((t) => (
              <tr key={t.id}><td><Link to={`/tasks?open=${t.id}`} className="font-medium no-underline">{t.title}</Link></td><td className="text-muted">{t.assigneeName ?? "—"}</td><td className="text-muted">{fmtDate(t.dueDate, loc)}</td><td><Chip tone={t.status === "done" ? "ok" : "off"}>{t.status}</Chip></td></tr>))}</tbody></table>
          )}
        </section>
      )}

      {active === "invoices" && (
        <section className="glass p-2">
          {!invoices.data?.length ? <Empty>{l("Aucune facture.", "No invoices.")}</Empty> : (
            <table className="grid"><tbody>{invoices.data.map((i) => (
              <tr key={i.id}><td><Link to={`/accounting/invoices?open=${i.id}`} className="font-medium no-underline">{i.number}</Link></td><td className="text-muted">{fmtDate(i.issueDate, loc)}</td><td>{money(i.total, loc)}</td><td><Chip tone={viewTone(i.view)}>{viewLabel(i.view, l)}</Chip></td><td className="text-right text-muted">{i.balance > 0 && i.status === "sent" ? money(i.balance, loc) : ""}</td></tr>))}</tbody></table>
          )}
        </section>
      )}

      {active === "billing" && <BillingTab c={c} editable={can("clients.billing.manage")} onSaved={refresh} />}

      {dialog?.kind === "client" && (
        <FormDialog title={l("Modifier le client", "Edit client")} fields={clientFields().filter((f) => can("clients.manage") || f.name !== "status")} wide initial={c as Record<string, unknown>}
          onSubmit={async (v) => { const keep = clientFields().filter((f) => f.type !== "section").map((f) => f.name); const body = cleanClientBody(Object.fromEntries(Object.entries(v).filter(([k]) => keep.includes(k) && (k !== "status" || can("clients.manage"))))); await api(`/api/clients/${id}`, { method: "PATCH", body }); await refresh(); }}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "contact" && (
        <FormDialog title={dialog.row ? l("Modifier le contact", "Edit contact") : l("Nouveau contact", "New contact")} fields={contactFields} initial={dialog.row as unknown as Record<string, unknown>}
          onSubmit={async (v) => { const body = { name: v.name, title: v.title ?? "", email: v.email ?? "", phone: v.phone ?? "", notes: v.notes ?? "" }; if (dialog.row) await api(`/api/clients/contacts/${dialog.row.id}`, { method: "PATCH", body }); else await api(`/api/clients/${id}/contacts`, { body }); await refresh(); }}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "newContract" && <NewContractDialog clientId={id} onDone={async (cid) => { await refresh(); setOpenContract(cid); }} onClose={() => setDialog(null)} />}
      {dialog?.kind === "order" && <TabOrder current={ordered} labels={labels} onClose={() => setDialog(null)} onSaved={() => qc.invalidateQueries({ queryKey: ["client-tab-order"] })} />}
      {openContract && <ContractWindow id={openContract} onClose={() => setOpenContract(null)} onChanged={refresh} />}
      {can("clients.manage") && active === "info" && <DeleteClient id={id} name={c.name} onDone={() => nav("/clients")} />}
    </>
  );
}

function BillingTab({ c, editable, onSaved }: { c: Detail; editable: boolean; onSaved: () => Promise<unknown> }) {
  const l = useL();
  const [v, setV] = useState({ billingEmail: c.billingEmail, termsDays: c.termsDays != null ? String(c.termsDays) : "", poRequired: Boolean(c.poRequired), autoApproveKinds: c.autoApproveKinds ?? [], invoiceNotes: c.invoiceNotes ?? "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const kinds = [["contract", l("Lignes de contrat", "Contract lines")], ["time", l("Temps", "Time")], ["expense", l("Dépenses", "Expenses")], ["manual", l("Lignes manuelles", "Manual lines")]] as const;
  const save = async () => {
    setError(""); setMsg("");
    try {
      await api(`/api/clients/${c.id}`, { method: "PATCH", body: { billingEmail: v.billingEmail, termsDays: v.termsDays === "" ? null : Number(v.termsDays), poRequired: v.poRequired, autoApproveKinds: v.autoApproveKinds, invoiceNotes: v.invoiceNotes } });
      await onSaved(); setMsg(l("Enregistré", "Saved"));
    } catch (e) { setError(codeText(errMsg(e, "Error"), l)); }
  };
  return (
    <section className="glass max-w-2xl p-5">
      <div className="grid gap-x-4 sm:grid-cols-2">
        <label className="mb-4 block sm:col-span-2"><span className="label">{l("Courriel de facturation", "Billing email")}</span><input className="input" type="email" disabled={!editable} value={v.billingEmail} onChange={(e) => setV({ ...v, billingEmail: e.target.value })} />
          <span className="mt-1 block text-xs text-muted">{c.billingContactId ? l("Suit le courriel du contact de facturation.", "Follows the billing contact's email.") : l("Saisi à la main. Choisissez un contact de facturation (reçu) pour le lier.", "Typed by hand. Pick a billing contact (receipt) to link it.")}</span></label>
        <label className="mb-4 block"><span className="label">{l("Délai de paiement (jours)", "Payment terms (days)")}</span><input className="input" type="number" min="0" disabled={!editable} placeholder={l("Défaut du cabinet", "Firm default")} value={v.termsDays} onChange={(e) => setV({ ...v, termsDays: e.target.value })} /></label>
        <label className="mb-4 flex items-center gap-2 pt-6 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={!editable} checked={v.poRequired} onChange={(e) => setV({ ...v, poRequired: e.target.checked })} />{l("Numéro de bon de commande requis", "Purchase order number required")}</label>
        <div className="mb-4 sm:col-span-2"><span className="label">{l("Approuver automatiquement le travail à facturer", "Auto-approve work to bill")}</span>
          <div className="flex flex-wrap gap-3">{kinds.map(([k, label]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={!editable} checked={v.autoApproveKinds.includes(k)} onChange={(e) => setV({ ...v, autoApproveKinds: e.target.checked ? [...v.autoApproveKinds, k] : v.autoApproveKinds.filter((x) => x !== k) })} />{label}</label>)}</div></div>
        <label className="mb-4 block sm:col-span-2"><span className="label">{l("Notes sur les factures", "Invoice notes")}</span><textarea className="input" rows={3} disabled={!editable} value={v.invoiceNotes} onChange={(e) => setV({ ...v, invoiceNotes: e.target.value })} /></label>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {editable && <div className="flex items-center gap-3"><button className="btn btn-primary" onClick={() => void save()}>{l("Enregistrer", "Save")}</button>{msg && <span role="status" className="text-sm text-muted">{msg}</span>}</div>}
    </section>
  );
}

/** The order of the tabs is one for everyone; an admin moves them with the arrows. */
function TabOrder({ current, labels, onClose, onSaved }: { current: Tab[]; labels: Record<Tab, string>; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const l = useL();
  const [list, setList] = useState<Tab[]>(current);
  const move = (i: number, d: number) => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j]!, n[i]!]; setList(n); };
  return (
    <Modal title={l("Ordre des onglets", "Tab order")} onClose={onClose}>
      <p className="mb-3 text-xs text-muted">{l("Cet ordre vaut pour tout le monde. Le premier onglet est celui sur lequel s'ouvre un dossier client.", "This order applies to everyone. The first tab is the one a client page opens on.")}</p>
      <div className="mb-4 space-y-2">{list.map((k, i) => <div key={k} className="glass-flat flex items-center justify-between px-3 py-2 text-sm"><span>{i + 1}. {labels[k].replace(/ \(\d+\)$/, "")}</span><span className="flex gap-1"><button className="btn !p-1" onClick={() => move(i, -1)} disabled={i === 0} aria-label="up"><ArrowUp size={13} /></button><button className="btn !p-1" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label="down"><ArrowDown size={13} /></button></span></div>)}</div>
      <div className="flex justify-between"><button className="btn" onClick={async () => { await api("/api/clients/tab-order", { method: "PUT", body: { order: null } }); await onSaved(); onClose(); }}>{l("Rétablir", "Reset")}</button>
        <div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" onClick={async () => { await api("/api/clients/tab-order", { method: "PUT", body: { order: list } }); await onSaved(); onClose(); }}>{l("Enregistrer", "Save")}</button></div></div>
    </Modal>
  );
}

/** Delete with the counts in view: a client with history is never deleted, only deactivated. */
function DeleteClient({ id, name, onDone }: { id: string; name: string; onDone: () => void }) {
  const l = useL();
  const [info, setInfo] = useState<null | { counts: Record<string, number>; blocked: boolean }>(null);
  const names: Record<string, [string, string]> = { contacts: ["contacts", "contacts"], contracts: ["contrats", "contracts"], tasks: ["tâches", "tasks"], invoices: ["factures", "invoices"], billing_items: ["lignes à facturer", "work to bill lines"], time_entries: ["entrées de temps", "time entries"], expenses: ["dépenses", "expenses"] };
  return (
    <div className="mt-6 text-right">
      <button className="btn btn-danger" onClick={async () => setInfo(await api(`/api/clients/${id}/delete-check`))}><Trash2 size={15} />{l("Supprimer le client", "Delete client")}</button>
      {info && (
        <Modal title={`${l("Supprimer", "Delete")} ${name}`} onClose={() => setInfo(null)}>
          <ul className="mb-4 space-y-1 text-sm">{Object.entries(info.counts).filter(([, n]) => n > 0).map(([k, n]) => <li key={k} className="flex justify-between"><span className="text-muted">{l(...(names[k] ?? [k, k]))}</span><b>{n}</b></li>)}{!Object.values(info.counts).some((n) => n > 0) && <li className="text-muted">{l("Aucune donnée liée.", "No linked data.")}</li>}</ul>
          {info.blocked ? <p className="mb-4 text-sm text-warn">{l("Ce client a un historique (factures, travail à facturer, tâches, temps ou dépenses) : il ne peut pas être supprimé. Désactivez-le plutôt (Modifier › Statut).", "This client has history (invoices, work to bill, tasks, time or expenses): it cannot be deleted. Deactivate it instead (Edit › Status).")}</p>
            : <p className="mb-4 text-sm text-muted">{l("Ses contacts et contrats seront supprimés avec lui. Cette action est inscrite au journal.", "Its contacts and contracts go with it. This action is logged.")}</p>}
          <div className="flex justify-end gap-2"><button className="btn" onClick={() => setInfo(null)}>{l("Annuler", "Cancel")}</button>
            {!info.blocked && <button className="btn btn-danger" onClick={() => void api(`/api/clients/${id}`, { method: "DELETE" }).then(onDone)}>{l("Supprimer définitivement", "Delete permanently")}</button>}</div>
        </Modal>)}
    </div>
  );
}
