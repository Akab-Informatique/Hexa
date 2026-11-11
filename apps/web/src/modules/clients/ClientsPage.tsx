import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL, useLocale } from "../../lib/l";
import { Chip, Empty, FormDialog, Toolbar, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

export interface ClientRow {
  id: string; name: string; legalName: string; status: "active" | "inactive" | "prospect"; email: string; phone: string; city: string;
  parentName: string | null; contactCount: number; openTasks: number; contractCount: number; billingEmail: string;
  classKey: string | null; classLabelFr: string | null; classLabelEn: string | null; classColor: string | null;
}
export interface ClientClass { key: string; labelFr: string; labelEn: string; color: string }

/** A coloured chip for the client classification (colour set by an admin). */
export function ClassChip({ fr, en, color }: { fr: string | null; en: string | null; color: string | null }) {
  const l = useL();
  if (!fr) return null;
  return <span className="chip" style={{ borderColor: color ?? undefined, color: color ?? undefined }}>{l(fr, en ?? fr)}</span>;
}

const FREQ = [
  { value: "monthly", label: ["Mensuelle", "Monthly"] as [string, string] }, { value: "quarterly", label: ["Trimestrielle", "Quarterly"] as [string, string] },
  { value: "annual", label: ["Annuelle", "Annual"] as [string, string] },
];
export const freqLabel = (k: string) => FREQ.find((f) => f.value === k)?.label;

/** Fields follow the firm's "Fiche d'information client". `creating` adds the contact-person field (edited on the Contacts tab afterwards). */
export const clientFields = (creating = false): FieldDef[] => [
  { name: "s1", label: ["Informations générales", "General information"], type: "section" },
  { name: "name", label: ["Nom de la compagnie", "Company name"], required: true },
  { name: "legalName", label: ["Raison sociale", "Legal name"] },
  { name: "status", label: ["Statut", "Status"], type: "select", required: true, options: [
    { value: "active", label: ["Actif", "Active"] }, { value: "prospect", label: ["Prospect", "Prospect"] }, { value: "inactive", label: ["Inactif", "Inactive"] }] },
  ...(creating ? [{ name: "contactName", label: ["Personne à contacter", "Contact person"] } as FieldDef] : []),
  { name: "phone", label: ["Numéro de téléphone", "Phone number"] },
  { name: "email", label: ["Courriel", "Email"], type: "email" },
  { name: "website", label: ["Site web", "Website"] },
  { name: "address", label: ["Adresse", "Address"], span: 2 },
  { name: "city", label: ["Ville", "City"] },
  { name: "province", label: ["Province", "Province"] },
  { name: "postalCode", label: ["Code postal", "Postal code"] },
  { name: "s2", label: ["Identification de l'entreprise", "Business identification"], type: "section" },
  { name: "businessNumber", label: ["Numéro d'entreprise (NE)", "Business number (NE)"] },
  { name: "identificationNumber", label: ["Numéro d'identification (NI)", "Identification number (NI)"] },
  { name: "neq", label: ["NEQ", "NEQ"] },
  { name: "ccq", label: ["CCQ", "CCQ"] },
  { name: "rbq", label: ["RBQ", "RBQ"] },
  { name: "s3", label: ["Informations fiscales", "Tax information"], type: "section" },
  { name: "taxFrequency", label: ["Fréquence des taxes", "Tax filing frequency"], type: "select", options: FREQ },
  { name: "taxDate", label: ["Date des taxes", "Tax due date"], placeholder: "ex. 15 / 03-31" },
  { name: "dasFrequency", label: ["Fréquence des DAS", "DAS frequency"], type: "select", options: FREQ },
  { name: "dasDate", label: ["Date des DAS", "DAS due date"], placeholder: "ex. 15 / 03-31" },
  { name: "fiscalYearEnd", label: ["Date de fin d'année financière", "Fiscal year end"], placeholder: "12-31" },
  { name: "software", label: ["Logiciel utilisé", "Software used"] },
  { name: "s4", label: ["Notes", "Notes"], type: "section" },
  { name: "notes", label: ["Informations additionnelles", "Additional information"], type: "textarea" },
];

export const statusTone = (s: string) => (s === "active" ? "ok" : s === "prospect" ? "warn" : "off") as "ok" | "warn" | "off";

export default function ClientsPage() {
  const l = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const loc = useLocale();
  void loc;
  const [creating, setCreating] = useState(false);
  const [cls, setCls] = useState("");
  const [sort, setSort] = useState<"name" | "contracts" | "billing">("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(25);
  const classes = useQuery({ queryKey: ["client-classes"], queryFn: () => api<ClientClass[]>("/api/clients/classes") });
  const list = useQuery({ queryKey: ["clients", q, status, cls, sort, dir, page, size], queryFn: () => api<{ rows: ClientRow[]; total: number }>(`/api/clients?page=${page}&size=${size}&sort=${sort}&dir=${dir}&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ""}${cls ? `&class=${cls}` : ""}`) });
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / size));
  const sortBy = (k: typeof sort) => { if (sort === k) setDir(dir === "asc" ? "desc" : "asc"); else { setSort(k); setDir(k === "name" ? "asc" : "desc"); } setPage(1); };
  const arrow = (k: typeof sort) => (sort === k ? (dir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null);
  const label = (s: string) => (s === "active" ? l("Actif", "Active") : s === "prospect" ? "Prospect" : l("Inactif", "Inactive"));

  return (
    <>
      <PageHeader title={l("Clients", "Clients")} subtitle={l("Tous les clients du cabinet", "All the firm's clients")}
        actions={can("clients.edit") && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} />{l("Nouveau client", "New client")}</button>} />
      <Toolbar>
        <div className="relative min-w-[240px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" />
          <input className="input !pl-9" placeholder={l("Rechercher un client…", "Search clients…")} value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <select className="input !w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label={l("Statut", "Status")}>
          <option value="">{l("Tous les statuts", "All statuses")}</option>
          <option value="active">{l("Actifs", "Active")}</option><option value="prospect">Prospects</option><option value="inactive">{l("Inactifs", "Inactive")}</option>
        </select>
        <select className="input !w-auto" value={cls} onChange={(e) => { setCls(e.target.value); setPage(1); }} aria-label={l("Classification", "Classification")}>
          <option value="">{l("Toutes les classes", "All classes")}</option>{classes.data?.map((k) => <option key={k.key} value={k.key}>{l(k.labelFr, k.labelEn)}</option>)}
        </select>
      </Toolbar>
      <div className="glass overflow-x-auto p-2">
        {rows.length === 0 ? <Empty>{l("Aucun client. Créez le premier.", "No clients yet. Create the first one.")}</Empty> : (
          <table className="grid">
            <thead><tr><th><button className="inline-flex items-center gap-1" onClick={() => sortBy("name")}>{l("Client", "Client")}{arrow("name")}</button></th><th>{l("Statut", "Status")}</th><th><button className="inline-flex items-center gap-1" onClick={() => sortBy("billing")}>{l("Courriel de facturation", "Billing email")}{arrow("billing")}</button></th><th>{l("Téléphone", "Phone")}</th><th><button className="inline-flex items-center gap-1" onClick={() => sortBy("contracts")}>{l("Contrats", "Contracts")}{arrow("contracts")}</button></th><th>{l("Contacts", "Contacts")}</th><th>{l("Tâches ouvertes", "Open tasks")}</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="cursor-pointer" onClick={() => nav(`/clients/${c.id}`)}>
                  <td><div className="flex items-center gap-2 font-medium">{c.name}<ClassChip fr={c.classLabelFr} en={c.classLabelEn} color={c.classColor} /></div>{c.parentName && <div className="text-xs text-muted">↳ {c.parentName}</div>}</td>
                  <td><Chip tone={statusTone(c.status)}>● {label(c.status)}</Chip></td>
                  <td>{c.billingEmail ? <span className="text-muted">{c.billingEmail}</span> : c.email ? <span className="italic text-muted">{c.email}</span> : <span style={{ color: "var(--danger)" }}>{l("Aucun", "None")}</span>}</td><td className="text-muted">{c.phone || "—"}</td>
                  <td>{c.contractCount}</td><td>{c.contactCount}</td><td>{c.openTasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-xs text-muted">
          <span>{list.data?.total ?? 0} {l("client(s)", "client(s)")}</span>
          <div className="flex items-center gap-2">
            <select className="input !w-auto !py-1" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }} aria-label="page size">{[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            <button className="btn !p-1.5" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="prev"><ChevronLeft size={14} /></button>
            <span>{page} / {pages}</span>
            <button className="btn !p-1.5" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="next"><ChevronRight size={14} /></button>
          </div>
        </div>
      </div>
      {creating && (
        <FormDialog title={l("Nouveau client", "New client")} fields={clientFields(true)} initial={{ status: "active" }} wide
          onSubmit={async (v) => { const r = await api<{ id: string }>("/api/clients", { body: v }); await qc.invalidateQueries({ queryKey: ["clients"] }); await qc.invalidateQueries({ queryKey: ["dir-clients"] }); nav(`/clients/${r.id}`); }}
          onClose={() => setCreating(false)} />
      )}
    </>
  );
}
