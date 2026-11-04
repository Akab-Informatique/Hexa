import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL } from "../../lib/l";
import { Chip, Empty, FormDialog, Toolbar, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

export interface ClientRow {
  id: string; name: string; legalName: string; status: "active" | "inactive" | "prospect"; email: string; phone: string; city: string;
  parentName: string | null; contactCount: number; openTasks: number;
}

export const clientFields = (): FieldDef[] => [
  { name: "name", label: ["Nom", "Name"], required: true },
  { name: "legalName", label: ["Raison sociale", "Legal name"] },
  { name: "status", label: ["Statut", "Status"], type: "select", required: true, options: [
    { value: "active", label: ["Actif", "Active"] }, { value: "prospect", label: ["Prospect", "Prospect"] }, { value: "inactive", label: ["Inactif", "Inactive"] }] },
  { name: "businessNumber", label: ["Numéro d'entreprise (NEQ/NE)", "Business number"] },
  { name: "email", label: ["Courriel", "Email"], type: "email" },
  { name: "phone", label: ["Téléphone", "Phone"] },
  { name: "website", label: ["Site web", "Website"] },
  { name: "fiscalYearEnd", label: ["Fin d'exercice", "Fiscal year end"], placeholder: "12-31" },
  { name: "address", label: ["Adresse", "Address"], span: 2 },
  { name: "city", label: ["Ville", "City"] },
  { name: "province", label: ["Province", "Province"] },
  { name: "postalCode", label: ["Code postal", "Postal code"] },
  { name: "notes", label: ["Notes", "Notes"], type: "textarea" },
];

export const statusTone = (s: string) => (s === "active" ? "ok" : s === "prospect" ? "warn" : "off") as "ok" | "warn" | "off";

export default function ClientsPage() {
  const l = useL();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ["clients", q, status], queryFn: () => api<ClientRow[]>(`/api/clients?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ""}`) });
  const label = (s: string) => (s === "active" ? l("Actif", "Active") : s === "prospect" ? "Prospect" : l("Inactif", "Inactive"));

  return (
    <>
      <PageHeader title={l("Clients", "Clients")} subtitle={l("Tous les clients du cabinet", "All the firm's clients")}
        actions={can("clients.edit") && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} />{l("Nouveau client", "New client")}</button>} />
      <Toolbar>
        <div className="relative min-w-[240px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" />
          <input className="input !pl-9" placeholder={l("Rechercher un client…", "Search clients…")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={l("Statut", "Status")}>
          <option value="">{l("Tous les statuts", "All statuses")}</option>
          <option value="active">{l("Actifs", "Active")}</option><option value="prospect">Prospects</option><option value="inactive">{l("Inactifs", "Inactive")}</option>
        </select>
      </Toolbar>
      <div className="glass overflow-x-auto p-2">
        {list.data?.length === 0 ? <Empty>{l("Aucun client. Créez le premier.", "No clients yet. Create the first one.")}</Empty> : (
          <table className="grid">
            <thead><tr><th>{l("Client", "Client")}</th><th>{l("Statut", "Status")}</th><th>{l("Courriel", "Email")}</th><th>{l("Téléphone", "Phone")}</th><th>{l("Contacts", "Contacts")}</th><th>{l("Tâches ouvertes", "Open tasks")}</th></tr></thead>
            <tbody>
              {list.data?.map((c) => (
                <tr key={c.id} className="cursor-pointer" onClick={() => nav(`/clients/${c.id}`)}>
                  <td><div className="font-medium">{c.name}</div>{c.parentName && <div className="text-xs text-muted">↳ {c.parentName}</div>}</td>
                  <td><Chip tone={statusTone(c.status)}>● {label(c.status)}</Chip></td>
                  <td className="text-muted">{c.email || "—"}</td><td className="text-muted">{c.phone || "—"}</td>
                  <td>{c.contactCount}</td><td>{c.openTasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <FormDialog title={l("Nouveau client", "New client")} fields={clientFields()} initial={{ status: "active" }} wide
          onSubmit={async (v) => { const r = await api<{ id: string }>("/api/clients", { body: v }); await qc.invalidateQueries({ queryKey: ["clients"] }); await qc.invalidateQueries({ queryKey: ["dir-clients"] }); nav(`/clients/${r.id}`); }}
          onClose={() => setCreating(false)} />
      )}
    </>
  );
}
