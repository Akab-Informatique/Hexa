import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { parseCents } from "@hexa/shared/productSale";
import { api, ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { money, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import { codeText } from "../clients/ContractWindow";

interface Svc {
  id: string; name: string; description: string; type: "recurring" | "product"; period: "monthly" | "quarterly" | "yearly" | null;
  priceCents: number; costCents: number | null; taxable: boolean; active: boolean; clientsUsing: number; soldCount: number;
}

/** What the firm sells besides hours: fixed recurring services (150 $/month...) and one-time products (a tax return). A contract line or a sale copies the price when it is made. */
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
  const fail = (e: unknown) => setError(errMsg(e, "Error") === "service_in_use" ? l("Ce service est utilisé : désactivez-le.", "This service is in use: turn it off.") : errMsg(e, "Error") === "service_exists" ? l("Un service porte déjà ce nom.", "A service already has this name.") : codeText(errMsg(e, "Error"), l));
  const fields: FieldDef[] = [
    { name: "name", label: ["Nom", "Name"], required: true, span: 2 },
    { name: "type", label: ["Type", "Type"], type: "select", required: true, options: [{ value: "recurring", label: ["Récurrent à prix fixe", "Recurring, fixed price"] }, { value: "product", label: ["Produit (vente unique)", "Product (one-time sale)"] }] },
    { name: "period", label: ["Période (récurrent)", "Period (recurring)"], type: "select", options: [{ value: "monthly", label: ["Chaque mois", "Monthly"] }, { value: "quarterly", label: ["Chaque trimestre", "Quarterly"] }, { value: "yearly", label: ["Chaque année", "Yearly"] }] },
    { name: "price", label: ["Prix par défaut ($)", "Default price ($)"], required: true }, { name: "cost", label: ["Coût ($)", "Cost ($)"] },
    { name: "taxable", label: ["Taxable (TPS/TVQ)", "Taxable (GST/QST)"], type: "checkbox" }, { name: "active", label: ["Actif", "Active"], type: "checkbox" },
    { name: "description", label: ["Description", "Description"], type: "textarea", rows: 2 },
  ];
  const typeText = (s: Svc) => (s.type === "product" ? l("Produit", "Product") : l("Récurrent", "Recurring"));
  const periodText = (s: Svc) => (s.period === "monthly" ? l("Chaque mois", "Monthly") : s.period === "quarterly" ? l("Chaque trimestre", "Quarterly") : s.period === "yearly" ? l("Chaque année", "Yearly") : l("Unique", "One time"));
  const margin = (s: Svc) => (s.costCents != null && s.priceCents > 0 ? Math.round(((s.priceCents - s.costCents) / s.priceCents) * 100) : null);
  const toggle = (s: Svc) => void api(`/api/services/${s.id}`, { method: "PATCH", body: { active: !s.active } }).then(refresh).catch(fail);

  return (
    <>
      <PageHeader title={l("Services", "Services")} subtitle={l("Services récurrents à prix fixe et produits à vendre aux clients", "Fixed recurring services and products to sell to clients")}
        actions={manage && <button className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} />{l("Nouveau service", "New service")}</button>} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="glass overflow-x-auto p-2">
        {!q.data?.length ? <Empty>{l("Aucun service. Créez-en un pour l'ajouter aux clients.", "No services. Create one to add to clients.")}</Empty> : (
          <table className="grid"><thead><tr><th>{l("Service", "Service")}</th><th>{l("Type", "Type")}</th><th>{l("Période", "Period")}</th><th>{l("Prix", "Price")}</th>{manage && <><th>{l("Coût", "Cost")}</th><th>{l("Marge", "Margin")}</th></>}<th>{l("Clients", "Clients")}</th><th>{l("Vendus", "Sold")}</th><th>{l("Actif", "Active")}</th>{manage && <th />}</tr></thead>
            <tbody>{q.data.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}><td><div className="font-medium">{s.name}</div>{s.description && <div className="text-xs text-muted">{s.description}</div>}</td>
                <td><Chip tone={s.type === "product" ? "warn" : "ok"}>{typeText(s)}</Chip></td><td>{periodText(s)}</td><td>{money(s.priceCents / 100, loc)}{!s.taxable && <span className="ml-1 text-xs text-muted">{l("non taxable", "tax-free")}</span>}</td>
                {manage && <><td className="text-muted">{s.costCents != null ? money(s.costCents / 100, loc) : "—"}</td><td>{margin(s) != null ? <Chip tone={(margin(s) ?? 0) < 15 ? "warn" : "ok"}>{margin(s)} %</Chip> : "—"}</td></>}
                <td className="text-muted">{s.type === "recurring" ? s.clientsUsing : "—"}</td><td className="text-muted">{s.type === "product" ? s.soldCount : "—"}</td>
                <td><input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--brand)]" checked={s.active} disabled={!manage} aria-label={l("Actif", "Active")} onChange={() => toggle(s)} /></td>
                {manage && <td className="whitespace-nowrap text-right"><button className="btn !p-1.5" onClick={() => setEdit({ row: s })} aria-label="edit"><Pencil size={14} /></button> <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(l("Supprimer ce service ?", "Delete this service?"), () => void api(`/api/services/${s.id}`, { method: "DELETE" }).then(refresh).catch(fail))}><Trash2 size={14} /></button></td>}</tr>))}</tbody></table>)}
      </div>
      <p className="mt-3 text-xs text-muted">{l("Changer le prix d'un service ne change pas ce qui est déjà au contrat ni les ventes faites. Un service désactivé ne peut plus être ajouté, mais ceux déjà en cours continuent d'être facturés. Les taxes (TPS/TVQ) suivent les taux de la facturation.", "Changing a price does not change what is already on a contract or already sold. A turned-off service can no longer be added, but those already running keep billing. Taxes (GST/QST) follow the invoicing rates.")}</p>
      {edit && <FormDialog title={edit.row ? l("Modifier le service", "Edit service") : l("Nouveau service", "New service")} fields={fields} wide
        initial={edit.row ? { ...edit.row, price: String(edit.row.priceCents / 100), cost: edit.row.costCents != null ? String(edit.row.costCents / 100) : "", period: edit.row.period ?? "monthly" } : { type: "recurring", period: "monthly", taxable: true, active: true }}
        onSubmit={async (v) => {
          const priceCents = parseCents(String(v.price ?? ""));
          const costCents = v.cost === "" || v.cost == null ? undefined : parseCents(String(v.cost));
          if (priceCents == null || costCents === null) throw new ApiError(400, { error: "price_invalid" });
          const body = { name: String(v.name ?? "").trim(), type: v.type, period: v.type === "recurring" ? v.period || "monthly" : undefined, priceCents, costCents, taxable: Boolean(v.taxable), active: Boolean(v.active), description: String(v.description ?? "") };
          if (edit.row) await api(`/api/services/${edit.row.id}`, { method: "PATCH", body }); else await api("/api/services", { body });
          await refresh();
        }} onClose={() => setEdit(null)} />}
    </>
  );
}
