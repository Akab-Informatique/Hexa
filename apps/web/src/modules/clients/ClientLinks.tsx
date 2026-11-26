import { useState } from "react";
import { Link } from "react-router-dom";
import { Link2, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL } from "../../lib/l";
import { Chip, confirmDo, errMsg, useClients } from "../../components/kit";
import { TypeChip } from "./ClientsPage";

export interface Relation { id: string; clientId: string; name: string; kind: string; label: string; clientType: string }
interface Props {
  clientId: string; parent: { id: string; name: string } | null; children: { id: string; name: string }[]; relations: Relation[]; onChanged: () => Promise<unknown>;
}

const KINDS: { value: string; label: [string, string] }[] = [
  { value: "spouse", label: ["Conjoint(e)", "Spouse"] }, { value: "married", label: ["Marié(e)", "Married"] },
  { value: "parent", label: ["Parent", "Parent"] }, { value: "child", label: ["Enfant", "Child"] }, { value: "other", label: ["Autre", "Other"] },
];

/** A search box over the client directory; picks one client (never the excluded ones). */
function ClientPicker({ exclude, value, onChange }: { exclude: string[]; value: string; onChange: (id: string) => void }) {
  const l = useL();
  const clients = useClients();
  const [q, setQ] = useState("");
  const list = (clients.data ?? []).filter((c) => !exclude.includes(c.id) && c.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 50);
  return (
    <div className="min-w-[220px] flex-1">
      <input className="input mb-1" placeholder={l("Rechercher un client…", "Search clients…")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={l("Rechercher un client", "Search clients")} />
      <select className="input" size={4} value={value} onChange={(e) => onChange(e.target.value)} aria-label={l("Client", "Client")}>
        {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  );
}

/** "Clients liés": hierarchy (parent_id, grouping) and family / other links. Each client stays its own record. */
export function ClientLinks({ clientId, parent, children, relations, onChanged }: Props) {
  const l = useL();
  const { can } = useAuth();
  const edit = can("clients.edit");
  const [mode, setMode] = useState<"" | "relation" | "parent">("");
  const [other, setOther] = useState("");
  const [kind, setKind] = useState("spouse");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const kindText = (r: Relation) => (r.kind === "other" ? r.label || l("Autre", "Other") : l(...KINDS.find((k) => k.value === r.kind)!.label));
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await onChanged(); setMode(""); setOther(""); setLabel(""); } catch (e) { setError(errMsg(e, l("Une erreur est survenue", "Something went wrong")).replace(/_/g, " ")); } };
  const linked = [clientId, ...relations.map((r) => r.clientId)];
  return (
    <section className="glass mb-4 p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{l("Clients liés", "Related clients")}</h2>
        {edit && <div className="flex gap-2">
          <button className="btn !py-1 text-xs" onClick={() => { setMode(mode === "relation" ? "" : "relation"); setOther(""); }}><Link2 size={13} />{l("+ Lier un client", "+ Link a client")}</button>
          {can("clients.manage") && <button className="btn !py-1 text-xs" onClick={() => { setMode(mode === "parent" ? "" : "parent"); setOther(""); }}>{l("Définir le client parent", "Set parent client")}</button>}
        </div>}
      </div>
      <dl className="space-y-3 text-sm">
        <div><dt className="mb-1 text-xs uppercase tracking-wide text-muted">{l("Client parent (regroupement)", "Parent client (grouping)")}</dt>
          <dd className="flex flex-wrap items-center gap-2">{parent ? <><Link to={`/clients/${parent.id}`}>{parent.name}</Link>
            {can("clients.manage") && <button className="btn !p-1" aria-label={l("Retirer le client parent", "Clear parent client")} onClick={() => void run(() => api(`/api/clients/${clientId}`, { method: "PATCH", body: { parentId: null } }))}><X size={12} /></button>}</> : <span className="text-muted">—</span>}</dd></div>
        {children.length > 0 && <div><dt className="mb-1 text-xs uppercase tracking-wide text-muted">{l("Clients regroupés dessous", "Grouped under this client")}</dt>
          <dd className="flex flex-wrap gap-2">{children.map((k) => <Link key={k.id} to={`/clients/${k.id}`} className="chip no-underline">{k.name}</Link>)}</dd></div>}
        <div><dt className="mb-1 text-xs uppercase tracking-wide text-muted">{l("Lien familial", "Family link")}</dt>
          <dd>{relations.length === 0 ? <span className="text-muted">—</span> : <ul className="space-y-1.5">{relations.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2"><Link to={`/clients/${r.clientId}`} className="font-medium">{r.name}</Link><TypeChip t={r.clientType} /><Chip tone="off">{kindText(r)}</Chip>
              {edit && <button className="btn btn-danger !p-1" aria-label={l("Retirer le lien", "Remove link")} onClick={() => confirmDo(l("Retirer ce lien ?", "Remove this link?"), () => void run(() => api(`/api/clients/relations/${r.id}`, { method: "DELETE" })))}><Trash2 size={12} /></button>}</li>))}</ul>}</dd></div>
      </dl>
      {mode && (
        <div className="glass-flat mt-4 flex flex-wrap items-end gap-3 p-3">
          <ClientPicker exclude={mode === "parent" ? [clientId, ...children.map((k) => k.id)] : linked} value={other} onChange={setOther} />
          {mode === "relation" && <>
            <label className="block"><span className="label">{l("Lien familial", "Family link")}</span>
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k.value} value={k.value}>{l(...k.label)}</option>)}</select>
              <span className="mt-1 block text-xs text-muted">{l("Le client choisi est son/sa…", "The picked client is this client's…")}</span></label>
            {kind === "other" && <label className="block"><span className="label">{l("Précisez", "Specify")}</span><input className="input" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} /></label>}
          </>}
          <button className="btn btn-primary" disabled={!other || (mode === "relation" && kind === "other" && !label.trim())}
            onClick={() => void run(() => mode === "parent" ? api(`/api/clients/${clientId}`, { method: "PATCH", body: { parentId: other } }) : api(`/api/clients/${clientId}/relations`, { body: { otherClientId: other, kind, label: kind === "other" ? label.trim() : undefined } }))}>{l("Enregistrer", "Save")}</button>
          <button className="btn" onClick={() => setMode("")}>{l("Annuler", "Cancel")}</button>
        </div>)}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
