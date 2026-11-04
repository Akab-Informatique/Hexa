import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Copy, Lock, LockOpen, Pencil, Plus, Share2, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL } from "../../lib/l";
import { errMsg, useUsers } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";
import { WIDGETS } from "./widgets";

interface Widget { id: string; type: string; size: number }
interface Dash {
  id: string; name: string; ownerName: string; visibility: "private" | "team"; teamAccess: "view" | "edit"; locked: boolean; layout: Widget[];
  members: { userId: string; name: string; access: "view" | "edit" }[]; isOwner: boolean; canEdit: boolean; canShare: boolean; canLock: boolean;
}

/**
 * Team dashboard: several dashboards per person, shareable (view/edit) and lockable by an admin.
 * A shared dashboard is ONE record: an edit made by anyone allowed to edit shows for everyone.
 * Locked or view-only dashboards can still be copied ("Copy to mine") and customized from there.
 */
export default function DashboardsPage() {
  const l = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["dashboards"], queryFn: () => api<Dash[]>("/api/team/dashboards") });
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [layout, setLayout] = useState<Widget[] | null>(null);
  const [error, setError] = useState("");
  const dash = list.data?.find((d) => d.id === sel) ?? list.data?.[0];

  useEffect(() => { setLayout(null); setEditing(false); setError(""); }, [dash?.id]);
  if (!dash) return null;

  const widgets = layout ?? dash.layout;
  const visible = (w: Widget) => { const def = WIDGETS[w.type]; return def && (!def.permission || can(...def.permission)); };
  const refresh = () => qc.invalidateQueries({ queryKey: ["dashboards"] });
  const patch = async (body: object) => { try { setError(""); await api(`/api/team/dashboards/${dash.id}`, { method: "PATCH", body }); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const move = (i: number, d: number) => { const a = [...widgets]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j]!, a[i]!]; setLayout(a); };
  const save = async () => { await patch({ layout: widgets }); setLayout(null); setEditing(false); };
  const create = async () => { const name = window.prompt(l("Nom du tableau de bord", "Dashboard name")); if (name?.trim()) { const r = await api<{ id: string }>("/api/team/dashboards", { body: { name: name.trim() } }); await refresh(); setSel(r.id); } };
  const copy = async () => { const r = await api<{ id: string }>(`/api/team/dashboards/${dash.id}/copy`, { method: "POST", body: {} }); await refresh(); setSel(r.id); };
  const del = async () => { if (window.confirm(l("Supprimer ce tableau de bord ?", "Delete this dashboard?"))) { try { await api(`/api/team/dashboards/${dash.id}`, { method: "DELETE" }); setSel(null); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } } };

  return (
    <>
      <PageHeader title={l("Tableau de bord", "Dashboard")} subtitle={dash.isOwner ? undefined : `${l("Partagé par", "Shared by")} ${dash.ownerName}`}
        actions={can("team.dashboard.edit") && <button className="btn" onClick={() => void create()}><Plus size={15} />{l("Nouveau", "New")}</button>} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {list.data?.map((d) => (
          <button key={d.id} onClick={() => setSel(d.id)} aria-pressed={d.id === dash.id} className="chip cursor-pointer text-sm" style={d.id === dash.id ? { background: "linear-gradient(135deg, var(--brand), var(--brand-2))", color: "#fff", borderColor: "transparent" } : undefined}>
            {d.locked && <Lock size={11} />}{d.name}{d.visibility === "team" || d.members.length > 0 ? " ⇄" : ""}
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {dash.locked && <span className="chip chip-warn"><Lock size={12} />{l("Verrouillé: modifications impossibles", "Locked: cannot be edited")}</span>}
        {dash.canEdit && !editing && <button className="btn" onClick={() => setEditing(true)}><Pencil size={15} />{l("Personnaliser", "Customize")}</button>}
        {editing && <><button className="btn btn-primary" onClick={() => void save()}>{l("Enregistrer", "Save")}</button><button className="btn" onClick={() => { setLayout(null); setEditing(false); }}>{l("Annuler", "Cancel")}</button></>}
        {editing && (
          <select className="input !w-auto" value="" onChange={(e) => { if (e.target.value) setLayout([...widgets, { id: `w${Date.now().toString(36)}`, type: e.target.value, size: 1 }]); }} aria-label={l("Ajouter un widget", "Add a widget")}>
            <option value="">+ {l("Ajouter un widget", "Add a widget")}</option>
            {Object.entries(WIDGETS).filter(([, w]) => !w.permission || can(...w.permission)).map(([k, w]) => <option key={k} value={k}>{l(...w.label)}</option>)}
          </select>
        )}
        {!dash.canEdit && can("team.dashboard.edit") && <button className="btn" onClick={() => void copy()}><Copy size={15} />{l("Copier dans mes tableaux", "Copy to mine")}</button>}
        {dash.canShare && <button className="btn" onClick={() => setSharing(true)}><Share2 size={15} />{l("Partager", "Share")}</button>}
        {dash.canLock && <button className="btn" onClick={() => void patch({ locked: !dash.locked })}>{dash.locked ? <LockOpen size={15} /> : <Lock size={15} />}{dash.locked ? l("Déverrouiller", "Unlock") : l("Verrouiller", "Lock")}</button>}
        {dash.isOwner && can("team.dashboard.edit") && <button className="btn btn-danger" onClick={() => void del()}><Trash2 size={15} /></button>}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {dash.canEdit && (dash.visibility === "team" || dash.members.length > 0) && editing && <p className="mb-3 text-xs text-warn">{l("Ce tableau est partagé: vos changements seront visibles par tous ceux qui le voient.", "This dashboard is shared: your changes will show for everyone who sees it.")}</p>}

      <div className="grid gap-4 md:grid-cols-3">
        {widgets.map((w, i) => (!visible(w) ? null : (
          <div key={w.id} className="relative" style={{ gridColumn: `span ${Math.min(w.size, 3)} / span ${Math.min(w.size, 3)}` }}>
            {editing && (
              <div className="absolute right-2 top-2 z-10 flex gap-1 rounded-lg bg-black/60 p-1 backdrop-blur">
                <button className="btn !p-1" onClick={() => move(i, -1)} aria-label="left"><ArrowLeft size={13} /></button>
                <button className="btn !p-1" onClick={() => move(i, 1)} aria-label="right"><ArrowRight size={13} /></button>
                <button className="btn !px-2 !py-1 text-xs" onClick={() => setLayout(widgets.map((x) => (x.id === w.id ? { ...x, size: (x.size % 3) + 1 } : x)))} title="size">{"▮".repeat(w.size)}</button>
                <button className="btn btn-danger !p-1" onClick={() => setLayout(widgets.filter((x) => x.id !== w.id))} aria-label="remove"><X size={13} /></button>
              </div>
            )}
            {WIDGETS[w.type]!.render()}
          </div>
        )))}
      </div>
      {sharing && <ShareDialog dash={dash} onClose={() => setSharing(false)} onSave={async (b) => { await patch(b); setSharing(false); }} />}
    </>
  );
}

function ShareDialog({ dash, onClose, onSave }: { dash: Dash; onClose: () => void; onSave: (b: object) => Promise<void> }) {
  const l = useL();
  const users = useUsers();
  const [visibility, setVisibility] = useState(dash.visibility);
  const [teamAccess, setTeamAccess] = useState(dash.teamAccess);
  const [members, setMembers] = useState(dash.members.map((m) => ({ userId: m.userId, access: m.access })));
  const accessOf = (id: string) => members.find((m) => m.userId === id)?.access;
  const setAccess = (id: string, a: "view" | "edit" | "") => setMembers((ms) => { const rest = ms.filter((m) => m.userId !== id); return a ? [...rest, { userId: id, access: a }] : rest; });
  return (
    <Modal title={l("Partager le tableau de bord", "Share dashboard")} onClose={onClose}>
      <p className="mb-4 text-sm text-muted">{l("Un tableau partagé est unique: une modification faite par une personne autorisée à modifier est vue de tous. Verrouillez-le pour empêcher les modifications.", "A shared dashboard is a single record: an edit by anyone allowed to edit shows for everyone. Lock it to prevent edits.")}</p>
      <label className="mb-4 block"><span className="label">{l("Visible par", "Visible to")}</span>
        <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "team")}><option value="private">{l("Seulement les personnes choisies", "Only chosen people")}</option><option value="team">{l("Toute l'équipe", "The whole team")}</option></select></label>
      {visibility === "team" && <label className="mb-4 block"><span className="label">{l("Droit de l'équipe", "Team access")}</span><select className="input" value={teamAccess} onChange={(e) => setTeamAccess(e.target.value as "view" | "edit")}><option value="view">{l("Voir seulement", "View only")}</option><option value="edit">{l("Voir et modifier", "View and edit")}</option></select></label>}
      <div className="mb-4"><span className="label">{l("Personnes", "People")}</span>
        <ul className="max-h-56 space-y-1.5 overflow-auto">{users.data?.filter((u) => u.name !== dash.ownerName).map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-2 text-sm"><span>{u.name}</span>
            <select className="input !w-auto !py-1" value={accessOf(u.id) ?? ""} onChange={(e) => setAccess(u.id, e.target.value as "view" | "edit" | "")}><option value="">—</option><option value="view">{l("Voir", "View")}</option><option value="edit">{l("Modifier", "Edit")}</option></select></li>))}</ul></div>
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" onClick={() => void onSave({ visibility, teamAccess, members })}>{l("Enregistrer", "Save")}</button></div>
    </Modal>
  );
}
