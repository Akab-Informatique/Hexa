import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, Tabs, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import { clientFields, statusTone } from "./ClientsPage";
import type { TaskRow } from "../tasks/TasksPage";

interface Contact { id: string; name: string; email: string; phone: string; title: string; isPrimary: boolean; isBilling: boolean; notes: string }
interface Contract { id: string; name: string; kind: string; amount: number; hourlyRate: number | null; cycle: string; startsOn: string | null; endsOn: string | null; status: string; notes: string }
interface Detail { id: string; name: string; legalName: string; status: "active" | "inactive" | "prospect"; parentId: string | null; parentName: string | null; contacts: Contact[]; contracts: Contract[]; children: { id: string; name: string }[]; [k: string]: unknown }
interface InvoiceRow { id: string; number: string; status: string; total: number; issueDate: string; dueDate: string }

type Tab = "info" | "contacts" | "contracts" | "tasks" | "invoices";

export default function ClientDetail() {
  const { id = "" } = useParams();
  const l = useL();
  const loc = useLocale();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("info");
  const [dialog, setDialog] = useState<null | { kind: "client" } | { kind: "contact"; row?: Contact } | { kind: "contract"; row?: Contract }>(null);
  const q = useQuery({ queryKey: ["client", id], queryFn: () => api<Detail>(`/api/clients/${id}`) });
  const tasks = useQuery({ queryKey: ["client-tasks", id], queryFn: () => api<TaskRow[]>(`/api/tasks?client=${id}&status=all`), enabled: tab === "tasks" && can("tasks.view", "command.pipeline.view") });
  const invoices = useQuery({ queryKey: ["client-invoices", id], queryFn: () => api<InvoiceRow[]>(`/api/accounting/invoices?client=${id}`), enabled: tab === "invoices" && can("accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage") });
  const c = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["client", id] });
  if (!c) return null;

  const tabs: { key: Tab; label: string }[] = [
    { key: "info", label: l("Infos", "Info") },
    ...(can("clients.contacts.view") ? [{ key: "contacts" as Tab, label: `${l("Contacts", "Contacts")} (${c.contacts.length})` }] : []),
    ...(can("clients.contracts.view") ? [{ key: "contracts" as Tab, label: `${l("Contrats", "Contracts")} (${c.contracts.length})` }] : []),
    ...(can("tasks.view", "command.pipeline.view") ? [{ key: "tasks" as Tab, label: l("Tâches", "Tasks") }] : []),
    ...(can("accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage") ? [{ key: "invoices" as Tab, label: l("Factures", "Invoices") }] : []),
  ];
  const contactFields: FieldDef[] = [
    { name: "name", label: ["Nom", "Name"], required: true }, { name: "title", label: ["Titre", "Title"] },
    { name: "email", label: ["Courriel", "Email"], type: "email" }, { name: "phone", label: ["Téléphone", "Phone"] },
    { name: "isPrimary", label: ["Contact principal", "Primary contact"], type: "checkbox" }, { name: "isBilling", label: ["Contact facturation", "Billing contact"], type: "checkbox" },
    { name: "notes", label: ["Notes", "Notes"], type: "textarea" },
  ];
  const contractFields: FieldDef[] = [
    { name: "name", label: ["Nom du contrat", "Contract name"], required: true, span: 2 },
    { name: "kind", label: ["Type", "Type"], type: "select", required: true, options: [
      { value: "recurring", label: ["Services récurrents", "Recurring services"] }, { value: "hourly", label: ["Taux horaire", "Hourly"] },
      { value: "fixed", label: ["Prix fixe", "Fixed price"] }, { value: "hours_bank", label: ["Banque d'heures", "Hours bank"] }] },
    { name: "cycle", label: ["Cycle", "Cycle"], type: "select", required: true, options: [
      { value: "monthly", label: ["Mensuel", "Monthly"] }, { value: "quarterly", label: ["Trimestriel", "Quarterly"] }, { value: "yearly", label: ["Annuel", "Yearly"] }, { value: "one_time", label: ["Ponctuel", "One time"] }] },
    { name: "amount", label: ["Montant", "Amount"], type: "number", step: "0.01" }, { name: "hourlyRate", label: ["Taux horaire", "Hourly rate"], type: "number", step: "0.01", hint: ["Utilisé pour facturer le temps approuvé", "Used to bill approved time"] },
    { name: "startsOn", label: ["Début", "Start"], type: "date" }, { name: "endsOn", label: ["Fin", "End"], type: "date" },
    { name: "status", label: ["Statut", "Status"], type: "select", required: true, options: [{ value: "active", label: ["Actif", "Active"] }, { value: "paused", label: ["En pause", "Paused"] }, { value: "ended", label: ["Terminé", "Ended"] }] },
    { name: "notes", label: ["Notes", "Notes"], type: "textarea" },
  ];
  const num = (v: unknown) => (v === "" || v === undefined || v === null ? null : Number(v));
  const nul = (v: unknown) => (v === "" ? null : v);

  const del = async (path: string, ask: string) => confirmDo(ask, () => { void api(path, { method: "DELETE" }).then(refresh).catch((e) => alert(errMsg(e, l("Erreur", "Error")))); });

  return (
    <>
      <Link to="/clients" className="mb-3 inline-flex items-center gap-1 text-sm text-muted no-underline hover:text-white"><ArrowLeft size={14} />{l("Clients", "Clients")}</Link>
      <PageHeader title={c.name} subtitle={c.legalName || undefined}
        actions={<div className="flex items-center gap-2"><Chip tone={statusTone(c.status)}>● {c.status}</Chip>{can("clients.edit") && <button className="btn" onClick={() => setDialog({ kind: "client" })}><Pencil size={15} />{l("Modifier", "Edit")}</button>}</div>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === "info" && (
        <div className="grid gap-4 md:grid-cols-2">
          <section className="glass p-5">
            <dl className="space-y-2 text-sm">
              {([["email", l("Courriel", "Email")], ["phone", l("Téléphone", "Phone")], ["website", l("Site web", "Website")], ["businessNumber", l("Numéro d'entreprise", "Business number")], ["fiscalYearEnd", l("Fin d'exercice", "Fiscal year end")]] as const).map(([k, label]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd>{String(c[k] ?? "") || "—"}</dd></div>
              ))}
              <div className="flex justify-between gap-3"><dt className="text-muted">{l("Adresse", "Address")}</dt><dd className="text-right">{[c.address, c.city, c.province, c.postalCode].filter(Boolean).join(", ") || "—"}</dd></div>
              {c.parentName && <div className="flex justify-between gap-3"><dt className="text-muted">{l("Société mère", "Parent company")}</dt><dd><Link to={`/clients/${c.parentId}`}>{c.parentName}</Link></dd></div>}
            </dl>
          </section>
          <section className="glass p-5">
            <h2 className="mb-2 font-semibold">{l("Notes", "Notes")}</h2>
            <p className="whitespace-pre-wrap text-sm text-muted">{String(c.notes ?? "") || "—"}</p>
            {c.children.length > 0 && <><h2 className="mb-2 mt-5 font-semibold">{l("Sociétés liées", "Subsidiaries")}</h2><div className="flex flex-wrap gap-2">{c.children.map((k) => <Link key={k.id} to={`/clients/${k.id}`} className="chip no-underline">{k.name}</Link>)}</div></>}
          </section>
        </div>
      )}

      {tab === "contacts" && (
        <section className="glass p-2">
          <div className="flex justify-end p-2">{can("clients.contacts.edit") && <button className="btn btn-primary" onClick={() => setDialog({ kind: "contact" })}><Plus size={15} />{l("Contact", "Contact")}</button>}</div>
          {c.contacts.length === 0 ? <Empty>{l("Aucun contact.", "No contacts.")}</Empty> : (
            <table className="grid"><tbody>{c.contacts.map((k) => (
              <tr key={k.id}>
                <td><div className="font-medium">{k.name} {k.isPrimary && <Chip tone="ok">{l("Principal", "Primary")}</Chip>} {k.isBilling && <Chip>{l("Facturation", "Billing")}</Chip>}</div><div className="text-xs text-muted">{k.title}</div></td>
                <td className="text-muted">{k.email}</td><td className="text-muted">{k.phone}</td>
                <td className="text-right">{can("clients.contacts.edit") && <><button className="btn !p-1.5" onClick={() => setDialog({ kind: "contact", row: k })} aria-label="edit"><Pencil size={14} /></button> <button className="btn btn-danger !p-1.5" onClick={() => void del(`/api/clients/contacts/${k.id}`, l("Supprimer ce contact ?", "Delete this contact?"))} aria-label="delete"><Trash2 size={14} /></button></>}</td>
              </tr>))}</tbody></table>
          )}
        </section>
      )}

      {tab === "contracts" && (
        <section className="glass p-2">
          <div className="flex justify-end p-2">{can("clients.contracts.edit") && <button className="btn btn-primary" onClick={() => setDialog({ kind: "contract" })}><Plus size={15} />{l("Contrat", "Contract")}</button>}</div>
          {c.contracts.length === 0 ? <Empty>{l("Aucun contrat.", "No contracts.")}</Empty> : (
            <table className="grid"><tbody>{c.contracts.map((k) => (
              <tr key={k.id}>
                <td><div className="font-medium">{k.name}</div><div className="text-xs text-muted">{k.kind} · {k.cycle}{k.startsOn ? ` · ${fmtDate(k.startsOn, loc)}` : ""}{k.endsOn ? ` → ${fmtDate(k.endsOn, loc)}` : ""}</div></td>
                <td>{k.hourlyRate ? `${money(k.hourlyRate, loc)}/h` : money(k.amount, loc)}</td>
                <td><Chip tone={k.status === "active" ? "ok" : "off"}>{k.status}</Chip></td>
                <td className="text-right">{can("clients.contracts.edit") && <><button className="btn !p-1.5" onClick={() => setDialog({ kind: "contract", row: k })} aria-label="edit"><Pencil size={14} /></button> <button className="btn btn-danger !p-1.5" onClick={() => void del(`/api/clients/contracts/${k.id}`, l("Supprimer ce contrat ?", "Delete this contract?"))} aria-label="delete"><Trash2 size={14} /></button></>}</td>
              </tr>))}</tbody></table>
          )}
        </section>
      )}

      {tab === "tasks" && (
        <section className="glass p-2">
          {!tasks.data?.length ? <Empty>{l("Aucune tâche pour ce client.", "No tasks for this client.")}</Empty> : (
            <table className="grid"><tbody>{tasks.data.map((t) => (
              <tr key={t.id}><td><Link to={`/tasks?open=${t.id}`} className="font-medium no-underline">{t.title}</Link></td><td className="text-muted">{t.assigneeName ?? "—"}</td><td className="text-muted">{fmtDate(t.dueDate, loc)}</td><td><Chip tone={t.status === "done" ? "ok" : "off"}>{t.status}</Chip></td></tr>))}</tbody></table>
          )}
        </section>
      )}

      {tab === "invoices" && (
        <section className="glass p-2">
          {!invoices.data?.length ? <Empty>{l("Aucune facture.", "No invoices.")}</Empty> : (
            <table className="grid"><tbody>{invoices.data.map((i) => (
              <tr key={i.id}><td><Link to={`/accounting/invoices?open=${i.id}`} className="font-medium no-underline">{i.number}</Link></td><td className="text-muted">{fmtDate(i.issueDate, loc)}</td><td>{money(i.total, loc)}</td><td><Chip tone={i.status === "paid" ? "ok" : i.status === "void" ? "off" : "warn"}>{i.status}</Chip></td></tr>))}</tbody></table>
          )}
        </section>
      )}

      {dialog?.kind === "client" && (
        <FormDialog title={l("Modifier le client", "Edit client")} fields={clientFields().filter((f) => can("clients.manage") || f.name !== "status")} wide initial={c as Record<string, unknown>}
          onSubmit={async (v) => { const { id: _i, contacts: _c, contracts: _k, children: _h, parentName: _p, createdAt: _a, updatedAt: _u, createdBy: _b, quickbooksId: _q, parentId: _pi, ...rest } = v as Record<string, unknown>; void [_i, _c, _k, _h, _p, _a, _u, _b, _q, _pi]; await api(`/api/clients/${id}`, { method: "PATCH", body: rest }); await refresh(); await qc.invalidateQueries({ queryKey: ["clients"] }); }}
          onClose={() => setDialog(null)}>
          {can("clients.manage") && <p className="mb-3 text-xs text-muted">{l("Un client avec un historique (factures, tâches, temps) ne peut pas être supprimé: désactivez-le.", "A client with history (invoices, tasks, time) cannot be deleted: deactivate it instead.")}</p>}
        </FormDialog>
      )}
      {dialog?.kind === "contact" && (
        <FormDialog title={dialog.row ? l("Modifier le contact", "Edit contact") : l("Nouveau contact", "New contact")} fields={contactFields} initial={dialog.row as unknown as Record<string, unknown>}
          onSubmit={async (v) => { const body = { name: v.name, title: v.title ?? "", email: v.email ?? "", phone: v.phone ?? "", isPrimary: Boolean(v.isPrimary), isBilling: Boolean(v.isBilling), notes: v.notes ?? "" }; if (dialog.row) await api(`/api/clients/contacts/${dialog.row.id}`, { method: "PATCH", body }); else await api(`/api/clients/${id}/contacts`, { body }); await refresh(); }}
          onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "contract" && (
        <FormDialog title={dialog.row ? l("Modifier le contrat", "Edit contract") : l("Nouveau contrat", "New contract")} fields={contractFields} wide initial={dialog.row ? (dialog.row as unknown as Record<string, unknown>) : { kind: "recurring", cycle: "monthly", status: "active" }}
          onSubmit={async (v) => { const body = { name: v.name, kind: v.kind, cycle: v.cycle, amount: num(v.amount) ?? 0, hourlyRate: num(v.hourlyRate), startsOn: nul(v.startsOn) ?? null, endsOn: nul(v.endsOn) ?? null, status: v.status, notes: v.notes ?? "" }; if (dialog.row) await api(`/api/clients/contracts/${dialog.row.id}`, { method: "PATCH", body }); else await api(`/api/clients/${id}/contracts`, { body }); await refresh(); }}
          onClose={() => setDialog(null)} />
      )}
      {can("clients.manage") && tab === "info" && (
        <div className="mt-6 text-right"><button className="btn btn-danger" onClick={() => confirmDo(l("Supprimer définitivement ce client ?", "Permanently delete this client?"), () => { void api(`/api/clients/${id}`, { method: "DELETE" }).then(() => nav("/clients")).catch((e) => alert(errMsg(e, "Error"))); })}><Trash2 size={15} />{l("Supprimer le client", "Delete client")}</button></div>
      )}
    </>
  );
}
