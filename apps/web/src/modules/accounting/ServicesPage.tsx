import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { money, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

interface Svc { id: string; name: string; description: string; kind: "monthly" | "yearly" | "one_time"; priceCents: number; costCents: number | null; taxable: boolean; active: boolean; inUse: number }

/** What the firm sells besides hours. A contract copies a service's price when it is added, so a change here never moves a contract. */
export default function ServicesPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can("services.manage");
  const [edit, setEdit] = useState<null | { row?: Svc }>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["svc-catalogue"], queryFn: () => api<Svc[]>("/api/services") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["svc-catalogue"] });
  const fields: FieldDef[] = [
    { name: "name", label: ["Nom", "Name"], required: true, span: 2 },
    { name: "kind", label: ["Facturation", "Billing"], type: "select", required: true, options: [{ value: "monthly", label: ["Mensuel", "Monthly"] }, { value: "yearly", label: ["Annuel", "Yearly"] }, { value: "one_time", label: ["Ponctuel", "One time"] }] },
    { name: "price", label: ["Prix ($)", "Price ($)"], type: "number", step: "0.01", required: true }, { name: "cost", label: ["Coût ($)", "Cost ($)"], type: "number", step: "0.01" },
    { name: "taxable", label: ["Taxable", "Taxable"], type: "checkbox" }, { name: "active", label: ["Actif", "Active"], type: "checkbox" },
    { name: "description", label: ["Description", "Description"], type: "textarea", rows: 2 },
  ];
  const kindText = (k: string) => (k === "monthly" ? l("Mensuel", "Monthly") : k === "yearly" ? l("Annuel", "Yearly") : l("Ponctuel", "One time"));
  const margin = (s: Svc) => (s.costCents != null && s.priceCents > 0 ? Math.round(((s.priceCents - s.costCents) / s.priceCents) * 100) : null);

  return (
    <>
      <PageHeader title={l("Services", "Services")} subtitle={l("Catalogue de ce que le cabinet vend, à ajouter aux contrats", "What the firm sells, to add to contracts")}
        actions={manage && <button className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} />{l("Nouveau service", "New service")}</button>} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="glass overflow-x-auto p-2">
        {!q.data?.length ? <Empty>{l("Aucun service. Créez-en un pour l'ajouter aux contrats.", "No services. Create one to add to contracts.")}</Empty> : (
          <table className="grid"><thead><tr><th>{l("Service", "Service")}</th><th>{l("Facturation", "Billing")}</th><th>{l("Prix", "Price")}</th>{manage && <><th>{l("Coût", "Cost")}</th><th>{l("Marge", "Margin")}</th></>}<th>{l("Contrats", "Contracts")}</th>{manage && <th />}</tr></thead>
            <tbody>{q.data.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}><td><div className="font-medium">{s.name}</div>{s.description && <div className="text-xs text-muted">{s.description}</div>}</td><td>{kindText(s.kind)}</td><td>{money(s.priceCents / 100, loc)}</td>
                {manage && <><td className="text-muted">{s.costCents != null ? money(s.costCents / 100, loc) : "—"}</td><td>{margin(s) != null ? <Chip tone={(margin(s) ?? 0) < 15 ? "warn" : "ok"}>{margin(s)} %</Chip> : "—"}</td></>}
                <td className="text-muted">{s.inUse}</td>
                {manage && <td className="whitespace-nowrap text-right"><button className="btn !p-1.5" onClick={() => setEdit({ row: s })} aria-label="edit"><Pencil size={14} /></button> <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(l("Supprimer ce service ?", "Delete this service?"), () => void api(`/api/services/${s.id}`, { method: "DELETE" }).then(refresh).catch((e) => setError(errMsg(e, "Error") === "service_in_use" ? l("Ce service est sur des contrats : désactivez-le.", "This service is on contracts: turn it off.") : errMsg(e, "Error"))))}><Trash2 size={14} /></button></td>}</tr>))}</tbody></table>)}
      </div>
      <p className="mt-3 text-xs text-muted">{l("Changer le prix d'un service ne change pas les contrats qui l'ont déjà : chaque contrat garde le prix convenu.", "Changing a service's price does not change the contracts that already hold it: each contract keeps the agreed price.")}</p>
      {edit && <FormDialog title={edit.row ? l("Modifier le service", "Edit service") : l("Nouveau service", "New service")} fields={fields} wide
        initial={edit.row ? { ...edit.row, price: edit.row.priceCents / 100, cost: edit.row.costCents != null ? edit.row.costCents / 100 : "" } : { kind: "monthly", taxable: true, active: true }}
        onSubmit={async (v) => { const body = { name: v.name, kind: v.kind, price: Number(v.price) || 0, cost: v.cost === "" || v.cost == null ? undefined : Number(v.cost), taxable: Boolean(v.taxable), active: Boolean(v.active), description: v.description ?? "" }; if (edit.row) await api(`/api/services/${edit.row.id}`, { method: "PATCH", body }); else await api("/api/services", { body }); await refresh(); }} onClose={() => setEdit(null)} />}
    </>
  );
}
