import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useL } from "../lib/l";
import { confirmDo, errMsg } from "../components/kit";
import { PageHeader } from "../components/ui";

interface Cls { key: string; labelFr: string; labelEn: string; color: string; clients: number }

/** Client classifications: names (FR/EN) and a colour, shown as a chip on the clients list and file. */
export default function ClassesPage() {
  const l = useL();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-classes"], queryFn: () => api<Cls[]>("/api/admin/classes") });
  const [n, setN] = useState({ fr: "", en: "", color: "#7c3aed" });
  const [error, setError] = useState("");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["admin-classes"] }); await qc.invalidateQueries({ queryKey: ["client-classes"] }); await qc.invalidateQueries({ queryKey: ["clients"] }); };
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const patch = (k: string, body: object) => run(() => api(`/api/admin/classes/${k}`, { method: "PATCH", body }));
  return (
    <>
      <PageHeader title={l("Classifications de clients", "Client classifications")} subtitle={l("Une classe par client, avec sa couleur", "One class per client, with its colour")} />
      <div className="glass overflow-x-auto p-2">
        <table className="grid"><thead><tr><th>{l("Français", "French")}</th><th>{l("Anglais", "English")}</th><th>{l("Couleur", "Colour")}</th><th>{l("Clients", "Clients")}</th><th /></tr></thead>
          <tbody>{q.data?.map((k) => (
            <tr key={k.key}>
              <td><input className="input" defaultValue={k.labelFr} onBlur={(e) => e.target.value !== k.labelFr && e.target.value.trim() && void patch(k.key, { labelFr: e.target.value })} /></td>
              <td><input className="input" defaultValue={k.labelEn} onBlur={(e) => e.target.value !== k.labelEn && e.target.value.trim() && void patch(k.key, { labelEn: e.target.value })} /></td>
              <td><input type="color" className="h-9 w-14 cursor-pointer rounded border border-white/10 bg-transparent" defaultValue={k.color} onBlur={(e) => e.target.value !== k.color && void patch(k.key, { color: e.target.value })} /></td>
              <td className="text-muted">{k.clients}</td>
              <td className="text-right"><button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(k.clients ? l(`${k.clients} client(s) deviendront sans classe. Supprimer ?`, `${k.clients} client(s) will become unclassified. Delete?`) : l("Supprimer cette classe ?", "Delete this class?"), () => void run(() => api(`/api/admin/classes/${k.key}`, { method: "DELETE" })))}><Trash2 size={14} /></button></td></tr>))}</tbody></table>
        <div className="flex flex-wrap items-end gap-2 p-3">
          <label className="min-w-[140px] flex-1"><span className="label">{l("Nouvelle classe (français)", "New class (French)")}</span><input className="input" value={n.fr} onChange={(e) => setN({ ...n, fr: e.target.value })} /></label>
          <label className="min-w-[140px] flex-1"><span className="label">{l("Anglais", "English")}</span><input className="input" value={n.en} onChange={(e) => setN({ ...n, en: e.target.value })} /></label>
          <label><span className="label">{l("Couleur", "Colour")}</span><input type="color" className="h-9 w-14 cursor-pointer rounded border border-white/10 bg-transparent" value={n.color} onChange={(e) => setN({ ...n, color: e.target.value })} /></label>
          <button className="btn btn-primary" disabled={!n.fr.trim() || !n.en.trim()} onClick={() => void run(async () => { await api("/api/admin/classes", { body: { key: n.fr.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "class", labelFr: n.fr, labelEn: n.en, color: n.color } }); setN({ fr: "", en: "", color: "#7c3aed" }); })}><Plus size={15} />{l("Ajouter", "Add")}</button>
        </div>
        {error && <p role="alert" className="px-3 pb-3 text-sm text-danger">{error}</p>}
      </div>
    </>
  );
}
