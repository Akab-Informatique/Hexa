import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, GripVertical, Lock, LockOpen, Pencil, Plus, RotateCcw, Share2, Star, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL } from "../../lib/l";
import { errMsg, useUsers } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";
import { WIDGETS } from "./widgets";

interface Widget { id: string; type: string; size: number }
interface Dash {
  id: string; name: string; ownerName: string; visibility: "private" | "team"; teamAccess: "view" | "edit"; locked: boolean; builtin: boolean; isDefault: boolean;
  layout: Widget[]; sharedLayout: Widget[]; hasPersonalLayout: boolean; members: { userId: string; name: string; access: "view" | "edit" }[];
  isOwner: boolean; shared: boolean; canEdit: boolean; canShare: boolean; canLock: boolean; canCustomize: boolean; canDelete: boolean;
}

const SIZES = [{ n: 1, label: "S" }, { n: 2, label: "M" }, { n: 3, label: "L" }];

/**
 * Dashboards: several per person, built-in ones, shareable (view/edit) and lockable.
 * A shared dashboard is ONE record, but anyone who sees it can arrange it "just for me" (with "back to default").
 * Widgets are added from a gallery, dragged to reorder and resized (S/M/L).
 */
export default function DashboardsPage() {
  const l = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["dashboards"], queryFn: () => api<Dash[]>("/api/team/dashboards") });
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState<null | { id?: string; name: string }>(null);
  const [layout, setLayout] = useState<Widget[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const dash = list.data?.find((d) => d.id === sel) ?? list.data?.[0];

  useEffect(() => { setLayout(null); setEditing(false); setError(""); }, [dash?.id]);
  if (!dash) return null;

  const widgets = layout ?? dash.layout;
  const allowed = (type: string) => { const def = WIDGETS[type]; return def && (!def.permission || can(...def.permission)); };
  const refresh = () => qc.invalidateQueries({ queryKey: ["dashboards"] });
  const run = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const patch = (b: object) => run(() => api(`/api/team/dashboards/${dash.id}`, { method: "PATCH", body: b }));
  const finish = () => { setLayout(null); setEditing(false); setSaving(false); };
  // A dashboard nobody else sees is saved as is; a shared one asks: for everyone, or just for me.
  const askSave = () => { if (dash.shared && dash.canEdit && dash.canCustomize) setSaving(true); else if (dash.canEdit && !dash.shared) void saveShared(); else void saveMine(); };
  const saveShared = () => run(async () => { await api(`/api/team/dashboards/${dash.id}`, { method: "PATCH", body: { layout: widgets } }); finish(); });
  const saveMine = () => run(async () => { await api(`/api/team/dashboards/${dash.id}/my-layout`, { method: "PUT", body: { layout: widgets } }); finish(); });
  const move = (from: string, to: string) => { if (from === to) return; const a = [...widgets]; const i = a.findIndex((w) => w.id === from), j = a.findIndex((w) => w.id === to); const [x] = a.splice(i, 1); a.splice(j, 0, x!); setLayout(a); };
  const add = (type: string) => { setLayout([...widgets, { id: `w${Date.now().toString(36)}`, type, size: WIDGETS[type]?.size ?? 1 }]); setGallery(false); };
  const create = async (name: string) => { const r = await api<{ id: string }>("/api/team/dashboards", { body: { name } }); await refresh(); setSel(r.id); };

  return (
    <>
      <PageHeader title={l("Tableau de bord", "Dashboard")} subtitle={dash.isOwner || dash.builtin ? undefined : `${l("Partagé par", "Shared by")} ${dash.ownerName}`}
        actions={can("team.dashboard.edit") && <button className="btn" onClick={() => setNaming({ name: "" })}><Plus size={15} />{l("Nouveau", "New")}</button>} />

      <div className="mb-4 flex flex-wrap items-center gap-2" role="tablist">
        {list.data?.map((d) => (
          <button key={d.id} role="tab" onClick={() => setSel(d.id)} aria-selected={d.id === dash.id} className="chip cursor-pointer text-sm" style={d.id === dash.id ? { background: "linear-gradient(135deg, var(--brand), var(--brand-2))", color: "#fff", borderColor: "transparent" } : undefined}>
            {d.isDefault && <Star size={11} fill="currentColor" />}{d.locked && <Lock size={11} />}{d.name}{d.builtin ? "" : d.visibility === "team" || d.members.length > 0 ? " ⇄" : ""}
          </button>))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {dash.locked && <span className="chip chip-warn"><Lock size={12} />{l("Verrouillé pour tous", "Locked for everyone")}</span>}
        {dash.hasPersonalLayout && !editing && <span className="chip">{l("Votre disposition", "Your arrangement")}</span>}
        {(dash.canEdit || dash.canCustomize) && !editing && <button className="btn" onClick={() => setEditing(true)}><Pencil size={15} />{l("Personnaliser", "Customize")}</button>}
        {editing && <><button className="btn btn-primary" onClick={askSave}>{l("Enregistrer", "Save")}</button><button className="btn" onClick={() => { setLayout(null); setEditing(false); }}>{l("Annuler", "Cancel")}</button><button className="btn" onClick={() => setGallery(true)}><Plus size={15} />{l("Ajouter un widget", "Add a widget")}</button></>}
        {dash.hasPersonalLayout && !editing && <button className="btn" onClick={() => void run(() => api(`/api/team/dashboards/${dash.id}/my-layout`, { method: "DELETE" }))}><RotateCcw size={15} />{l("Revenir à la disposition par défaut", "Back to the default arrangement")}</button>}
        {!editing && <button className="btn" title={l("Le tableau qui s'ouvre en premier", "The dashboard that opens first")} onClick={() => void run(() => api("/api/team/dashboards/default", { method: "PUT", body: { dashboardId: dash.isDefault ? null : dash.id } }))}><Star size={15} fill={dash.isDefault ? "currentColor" : "none"} />{dash.isDefault ? l("Mon tableau par défaut", "My default dashboard") : l("Définir par défaut", "Make default")}</button>}
        {!dash.canEdit && can("team.dashboard.edit") && !editing && <button className="btn" onClick={() => void run(async () => { const r = await api<{ id: string }>(`/api/team/dashboards/${dash.id}/copy`, { method: "POST", body: {} }); setSel(r.id); })}><Copy size={15} />{l("Copier dans mes tableaux", "Copy to mine")}</button>}
        {dash.canEdit && !dash.builtin && !editing && <button className="btn" onClick={() => setNaming({ id: dash.id, name: dash.name })}>{l("Renommer", "Rename")}</button>}
        {dash.canShare && !editing && <button className="btn" onClick={() => setSharing(true)}><Share2 size={15} />{l("Partager", "Share")}</button>}
        {dash.canLock && !editing && <button className="btn" onClick={() => void patch({ locked: !dash.locked })}>{dash.locked ? <LockOpen size={15} /> : <Lock size={15} />}{dash.locked ? l("Déverrouiller", "Unlock") : l("Verrouiller", "Lock")}</button>}
        {dash.canDelete && !editing && <button className="btn btn-danger" aria-label="delete" onClick={() => { if (window.confirm(l("Supprimer ce tableau de bord ?", "Delete this dashboard?"))) void run(async () => { await api(`/api/team/dashboards/${dash.id}`, { method: "DELETE" }); setSel(null); }); }}><Trash2 size={15} /></button>}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      {editing && <p className="mb-3 text-xs text-muted">{l("Glissez les cartes pour les réordonner; S / M / L règle la largeur.", "Drag the cards to reorder them; S / M / L sets the width.")}</p>}

      <div className="grid gap-4 md:grid-cols-3">
        {widgets.map((w) => (!allowed(w.type) ? null : (
          <div key={w.id} className={`relative ${editing ? "rounded-2xl outline-dashed outline-1 outline-white/25" : ""}`} style={{ gridColumn: `span ${Math.min(w.size, 3)} / span ${Math.min(w.size, 3)}`, opacity: dragId === w.id ? 0.4 : 1 }}
            draggable={editing} onDragStart={() => setDragId(w.id)} onDragEnd={() => setDragId(null)} onDragOver={(e) => editing && e.preventDefault()} onDrop={() => { if (dragId) move(dragId, w.id); setDragId(null); }}>
            {editing && (
              <div className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg bg-black/60 p-1 backdrop-blur">
                <GripVertical size={14} className="cursor-grab text-muted" />
                {SIZES.map((s) => <button key={s.n} className="btn !px-2 !py-0.5 text-xs" style={w.size === s.n ? { background: "var(--brand)", color: "#fff" } : undefined} onClick={() => setLayout(widgets.map((x) => (x.id === w.id ? { ...x, size: s.n } : x)))}>{s.label}</button>)}
                <button className="btn btn-danger !p-1" onClick={() => setLayout(widgets.filter((x) => x.id !== w.id))} aria-label="remove"><X size={13} /></button>
              </div>)}
            {WIDGETS[w.type]!.render()}
          </div>)))}
      </div>

      {gallery && (
        <Modal title={l("Ajouter un widget", "Add a widget")} onClose={() => setGallery(false)} wide>
          <div className="grid gap-3 sm:grid-cols-2">{Object.entries(WIDGETS).filter(([k]) => allowed(k)).map(([k, w]) => (
            <button key={k} className="glass-flat p-3 text-left transition hover:brightness-125" onClick={() => add(k)}>
              <div className="font-medium">{l(...w.label)}</div><div className="mt-0.5 text-xs text-muted">{l(...w.desc)}</div><div className="mt-2 text-[11px] text-muted">{l("Largeur par défaut", "Default width")}: {SIZES.find((s) => s.n === w.size)?.label}</div>
            </button>))}</div>
        </Modal>)}
      {saving && (
        <Modal title={l("Enregistrer la disposition", "Save the arrangement")} onClose={() => setSaving(false)}>
          <p className="mb-4 text-sm text-muted">{l("Ce tableau est partagé. Voulez-vous changer la disposition pour tout le monde, ou seulement pour vous ?", "This dashboard is shared. Change the arrangement for everyone, or just for you?")}</p>
          <div className="flex flex-col gap-2"><button className="btn btn-primary" onClick={() => void saveShared()}>{l("Pour tout le monde", "For everyone")}</button><button className="btn" onClick={() => void saveMine()}>{l("Seulement pour moi", "Just for me")}</button></div>
        </Modal>)}
      {naming && <NameDialog init={naming.name} title={naming.id ? l("Renommer le tableau", "Rename the dashboard") : l("Nouveau tableau de bord", "New dashboard")} onClose={() => setNaming(null)} onSave={async (name) => { if (naming.id) await patch({ name }); else await create(name); setNaming(null); }} />}
      {sharing && <ShareDialog dash={dash} onClose={() => setSharing(false)} onSave={async (b) => { await patch(b); setSharing(false); }} />}
    </>
  );
}

function NameDialog({ init, title, onClose, onSave }: { init: string; title: string; onClose: () => void; onSave: (n: string) => Promise<void> }) {
  const l = useL();
  const [name, setName] = useState(init);
  return (
    <Modal title={title} onClose={onClose}>
      <label className="mb-4 block"><span className="label">{l("Nom", "Name")}</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && void onSave(name.trim())} /></label>
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" disabled={!name.trim()} onClick={() => void onSave(name.trim())}>{l("Enregistrer", "Save")}</button></div>
    </Modal>
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
      <p className="mb-4 text-sm text-muted">{l("Un tableau partagé est unique : une modification faite par une personne autorisée à modifier est vue de tous (sauf ceux qui l'ont arrangé pour eux). Verrouillez-le pour empêcher les modifications.", "A shared dashboard is a single record: an edit by anyone allowed to edit shows for everyone (except those who arranged it for themselves). Lock it to prevent edits.")}</p>
      {!dash.builtin && <label className="mb-4 block"><span className="label">{l("Visible par", "Visible to")}</span>
        <select className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "team")}><option value="private">{l("Seulement les personnes choisies", "Only chosen people")}</option><option value="team">{l("Toute l'équipe", "The whole team")}</option></select></label>}
      {visibility === "team" && <label className="mb-4 block"><span className="label">{l("Droit de l'équipe", "Team access")}</span><select className="input" value={teamAccess} onChange={(e) => setTeamAccess(e.target.value as "view" | "edit")}><option value="view">{l("Voir seulement", "View only")}</option><option value="edit">{l("Voir et modifier", "View and edit")}</option></select></label>}
      {!dash.builtin && <div className="mb-4"><span className="label">{l("Personnes", "People")}</span>
        <ul className="max-h-56 space-y-1.5 overflow-auto">{users.data?.filter((u) => u.name !== dash.ownerName).map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-2 text-sm"><span>{u.name}</span>
            <select className="input !w-auto !py-1" value={accessOf(u.id) ?? ""} onChange={(e) => setAccess(u.id, e.target.value as "view" | "edit" | "")}><option value="">—</option><option value="view">{l("Voir", "View")}</option><option value="edit">{l("Modifier", "Edit")}</option></select></li>))}</ul></div>}
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" onClick={() => void onSave(dash.builtin ? { teamAccess } : { visibility, teamAccess, members })}>{l("Enregistrer", "Save")}</button></div>
    </Modal>
  );
}
