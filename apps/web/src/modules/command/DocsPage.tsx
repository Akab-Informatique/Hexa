import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, FileText, Folder, FolderLock, FolderPlus, Library as LibraryIcon, Pin, Shield, Star, Trash2, Upload, Users, X } from "lucide-react";
import { ApiError, api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, Tabs, useUsers } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

interface Status { configured: boolean; mock: boolean; canManageAccess: boolean; canWrite: boolean }
interface Lib { id: string; name: string }
interface Item { name: string; path: string; folder: boolean; size: number; modifiedAt: string | null }
interface Shortcut { id: string; driveId: string; path: string; label: string; shared: boolean }
interface Browse { level: "manage" | "edit" | "view" | "path"; canWrite: boolean; items: Item[] }
interface Rule { id: string; driveId: string; driveName: string; path: string; principalType: "user" | "group"; principalId: string; principalName: string | null; level: "view" | "edit" }

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * Documentation: the firm's SharePoint, browsed through the Microsoft Graph API. Which folders each person
 * (or group) sees, and whether they can only read or also change them, is set here, per folder.
 */
export default function DocsPage() {
  const l = useL();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [tab, setTab] = useState<"files" | "access">("files");
  const status = useQuery({ queryKey: ["docs-status"], queryFn: () => api<Status>("/api/docs/status") });
  const configured = status.data?.configured;
  const libs = useQuery({ queryKey: ["docs-libs"], queryFn: () => api<Lib[]>("/api/docs/libraries"), enabled: Boolean(configured) });
  const drive = sp.get("lib") ?? libs.data?.[0]?.id ?? "";
  const path = sp.get("path") ?? "";
  const go = (lib: string, p: string) => setSp(p ? { lib, path: p } : { lib }, { replace: false });
  const canAccess = Boolean(status.data?.canManageAccess);

  if (status.isLoading) return null;
  if (!configured) {
    const admin = can("admin.integrations.view");
    return (
      <>
        <PageHeader title={l("Documentation", "Documentation")} subtitle={l("Vos dossiers SharePoint, avec des accès gérés dans le portail", "Your SharePoint folders, with access managed in the portal")} />
        <div className="glass max-w-2xl p-6 text-sm">
          <FolderLock className="mb-3 text-brand" size={26} />
          <p className="font-medium">{l("SharePoint n'est pas encore connecté.", "SharePoint is not connected yet.")}</p>
          <p className="mt-2 text-muted">{l("Un administrateur doit saisir l'application Microsoft 365 du cabinet (locataire, ID et secret) puis l'adresse du site SharePoint, et activer l'intégration.", "An administrator must enter the firm's Microsoft 365 app (tenant, ID and secret) and the SharePoint site address, then enable the integration.")}</p>
          {admin && <div className="mt-4 flex gap-2"><Link className="btn no-underline" to="/admin/integrations/o365">Microsoft 365</Link><Link className="btn btn-primary no-underline" to="/admin/integrations/sharepoint">SharePoint</Link></div>}
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title={l("Documentation", "Documentation")} subtitle={l("SharePoint du cabinet — vous voyez les dossiers auxquels vous avez accès", "The firm's SharePoint — you see the folders you have access to")}
        actions={status.data?.mock && <Chip tone="warn">{l("Simulation locale", "Local simulation")}</Chip>} />
      {canAccess && <Tabs tabs={[{ key: "files", label: l("Dossiers", "Folders") }, { key: "access", label: l("Accès aux dossiers", "Folder access") }]} value={tab} onChange={setTab} />}
      {tab === "files" ? <Files libs={libs.data ?? []} drive={drive} path={path} go={go} canAccess={canAccess} /> : <AccessOverview />}
    </>
  );
}

function Files({ libs, drive, path, go, canAccess }: { libs: Lib[]; drive: string; path: string; go: (lib: string, p: string) => void; canAccess: boolean }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["docs-browse", drive, path], enabled: Boolean(drive), retry: false,
    queryFn: () => api<Browse>(`/api/docs/browse?drive=${encodeURIComponent(drive)}&path=${encodeURIComponent(path)}`),
  });
  const shortcuts = useQuery({ queryKey: ["docs-shortcuts"], queryFn: () => api<Shortcut[]>("/api/docs/shortcuts") });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["docs-browse"] }); await qc.invalidateQueries({ queryKey: ["docs-shortcuts"] }); };
  const run = async (fn: () => Promise<unknown>) => { setError(""); setBusy(true); try { await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } finally { setBusy(false); } };
  const crumbs = path ? path.split("/") : [];
  const lib = libs.find((x) => x.id === drive);

  const upload = (f: File) => run(async () => {
    const res = await fetch(`/api/docs/file?drive=${encodeURIComponent(drive)}&path=${encodeURIComponent(path)}&name=${encodeURIComponent(f.name)}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream", "x-hexa-upload": "1" }, body: f });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  });

  if (!libs.length) return <div className="glass"><Empty>{l("Aucun dossier ne vous est accessible pour le moment. Demandez à un administrateur de vous donner accès.", "No folder is available to you yet. Ask an administrator to give you access.")}</Empty></div>;

  const pinned = (shortcuts.data ?? []).some((s) => s.driveId === drive && s.path.toLowerCase() === path.toLowerCase() && !s.shared);
  const addShortcut = (shared: boolean) => run(async () => { await api("/api/docs/shortcuts", { body: { drive, path, shared } }); await qc.invalidateQueries({ queryKey: ["docs-shortcuts"] }); });
  const dropShortcut = (id: string) => run(async () => { await api(`/api/docs/shortcuts/${id}`, { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["docs-shortcuts"] }); });

  return (
    <>
      {(shortcuts.data?.length ?? 0) > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2" aria-label={l("Raccourcis", "Shortcuts")}>
          <Star size={15} className="text-muted" />
          {shortcuts.data!.map((s) => (
            <span key={s.id} className="group inline-flex items-center">
              <button className="btn !py-1 text-xs" title={`${libs.find((x) => x.id === s.driveId)?.name ?? ""}/${s.path}`} onClick={() => go(s.driveId, s.path)}><Folder size={13} className="text-brand" />{s.label}{s.shared && <Pin size={10} className="text-muted" />}</button>
              {(!s.shared || canAccess) && <button className="ml-0.5 rounded p-1 text-muted opacity-0 hover:text-white group-hover:opacity-100 focus:opacity-100" aria-label={l("Retirer le raccourci", "Remove shortcut")} onClick={() => void dropShortcut(s.id)}><X size={12} /></button>}
            </span>))}
        </div>)}
      {libs.length > 1 && <div className="mb-3 flex flex-wrap gap-2">
        {libs.map((x) => (
          <button key={x.id} className="btn" onClick={() => go(x.id, "")} style={x.id === drive ? { background: "linear-gradient(135deg, color-mix(in oklab, var(--brand) 55%, transparent), color-mix(in oklab, var(--brand-2) 40%, transparent))", color: "#fff" } : undefined}><LibraryIcon size={15} />{x.name}</button>))}
      </div>}
      <div className="glass p-2">
        <div className="flex flex-wrap items-center gap-2 p-2">
          <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm" aria-label="breadcrumb">
            <button className="rounded px-1.5 py-0.5 hover:bg-white/10" onClick={() => go(drive, "")}>{lib?.name ?? "…"}</button>
            {crumbs.map((c, i) => (<span key={i} className="flex items-center gap-1"><ChevronRight size={14} className="text-muted" /><button className="rounded px-1.5 py-0.5 hover:bg-white/10" onClick={() => go(drive, crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>))}
          </nav>
          {q.data?.canWrite && (
            <>
              <button className="btn" disabled={busy} onClick={() => { const name = window.prompt(l("Nom du nouveau dossier", "New folder name")); if (name?.trim()) void run(() => api("/api/docs/folder", { body: { drive, path, name: name.trim() } })); }}><FolderPlus size={15} />{l("Nouveau dossier", "New folder")}</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={15} />{l("Téléverser", "Upload")}</button>
              <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
            </>)}
          {drive && !pinned && <button className="btn" disabled={busy} onClick={() => void addShortcut(false)}><Star size={15} />{l("Raccourci", "Shortcut")}</button>}
          {drive && canAccess && <button className="btn" disabled={busy} title={l("Visible par tous ceux qui ont accès au dossier", "Visible to everyone who has access to the folder")} onClick={() => void addShortcut(true)}><Pin size={15} />{l("Raccourci partagé", "Shared shortcut")}</button>}
          {canAccess && path && <button className="btn" onClick={() => setAccessFor(path)}><Shield size={15} />{l("Accès", "Access")}</button>}
          {canAccess && !path && drive && <button className="btn" onClick={() => setAccessFor("")}><Shield size={15} />{l("Accès", "Access")}</button>}
        </div>
        {error && <p role="alert" className="px-3 pb-2 text-sm text-danger">{error}</p>}
        {q.error && <p role="alert" className="px-3 pb-3 text-sm text-danger">{l("Vous n'avez pas accès à ce dossier.", "You do not have access to this folder.")}</p>}
        {q.data?.level === "path" && <p className="px-3 pb-2 text-xs text-muted">{l("Vous voyez seulement le chemin vers les dossiers auxquels vous avez accès.", "You only see the way to the folders you have access to.")}</p>}
        {q.data && q.data.items.length === 0 && <Empty>{l("Dossier vide.", "Empty folder.")}</Empty>}
        {q.data && q.data.items.length > 0 && (
          <table className="grid"><thead><tr><th>{l("Nom", "Name")}</th><th>{l("Taille", "Size")}</th><th>{l("Modifié", "Modified")}</th><th /></tr></thead>
            <tbody>{q.data.items.map((it) => (
              <tr key={it.path}>
                <td>{it.folder
                  ? <button className="flex items-center gap-2 font-medium hover:underline" onClick={() => go(drive, it.path)}><Folder size={17} className="text-brand" />{it.name}</button>
                  : <a className="flex items-center gap-2 no-underline hover:underline" href={`/api/docs/file?drive=${encodeURIComponent(drive)}&path=${encodeURIComponent(it.path)}`}><FileText size={17} className="text-muted" />{it.name}</a>}</td>
                <td className="text-muted">{it.folder ? "" : size(it.size)}</td><td className="text-muted">{fmtDate(it.modifiedAt, loc)}</td>
                <td className="whitespace-nowrap text-right">
                  {!it.folder && <a className="btn !p-1.5 no-underline" href={`/api/docs/file?drive=${encodeURIComponent(drive)}&path=${encodeURIComponent(it.path)}`} aria-label="download"><Download size={14} /></a>}{" "}
                  {it.folder && canAccess && <button className="btn !p-1.5" title={l("Gérer l'accès", "Manage access")} onClick={() => setAccessFor(it.path)}><Shield size={14} /></button>}{" "}
                  {q.data.canWrite && <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => { if (window.confirm(l(`Supprimer « ${it.name} » de SharePoint ?`, `Delete “${it.name}” from SharePoint?`))) void run(() => api(`/api/docs/item?drive=${encodeURIComponent(drive)}&path=${encodeURIComponent(it.path)}`, { method: "DELETE" })); }}><Trash2 size={14} /></button>}
                </td></tr>))}</tbody></table>)}
      </div>
      {accessFor !== null && <AccessDialog drive={drive} driveName={lib?.name ?? ""} path={accessFor} onClose={() => setAccessFor(null)} />}
    </>
  );
}

const sameOrAbove = (rule: string, path: string) => rule === "" || path.toLowerCase() === rule.toLowerCase() || path.toLowerCase().startsWith(rule.toLowerCase() + "/");

/** Rules of one folder: its own (editable) and the ones it inherits from the folders above (read only). */
function AccessDialog({ drive, driveName, path, onClose }: { drive: string; driveName: string; path: string; onClose: () => void }) {
  const l = useL();
  const qc = useQueryClient();
  const users = useUsers();
  const groups = useQuery({ queryKey: ["dir-groups"], queryFn: () => api<{ id: string; name: string }[]>("/api/directory/groups") });
  const rules = useQuery({ queryKey: ["docs-access", drive], queryFn: () => api<Rule[]>(`/api/docs/access?drive=${encodeURIComponent(drive)}`) });
  const [type, setType] = useState<"group" | "user">("group");
  const [who, setWho] = useState("");
  const [level, setLevel] = useState<"view" | "edit">("view");
  const [error, setError] = useState("");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["docs-access"] }); await qc.invalidateQueries({ queryKey: ["docs-libs"] }); };
  const direct = (rules.data ?? []).filter((r) => r.path.toLowerCase() === path.toLowerCase());
  const inherited = (rules.data ?? []).filter((r) => r.path.toLowerCase() !== path.toLowerCase() && sameOrAbove(r.path, path));
  const options = type === "group" ? groups.data : users.data;
  const levelLabel = (v: string) => (v === "edit" ? l("Modification", "Edit") : l("Lecture", "View"));
  const row = (r: Rule, ro: boolean) => (
    <tr key={r.id}><td className="flex items-center gap-2">{r.principalType === "group" ? <Users size={14} className="text-muted" /> : <span className="text-muted">👤</span>}{r.principalName ?? "?"}{ro && <span className="text-xs text-muted">· {l("hérité de", "inherited from")} /{r.path || driveName}</span>}</td>
      <td><Chip tone={r.level === "edit" ? "warn" : "ok"}>{levelLabel(r.level)}</Chip></td>
      <td className="text-right">{!ro && <button className="btn btn-danger !p-1.5" aria-label="remove" onClick={() => void api(`/api/docs/access/${r.id}`, { method: "DELETE" }).then(refresh).catch((e) => setError(errMsg(e, "Error")))}><Trash2 size={14} /></button>}</td></tr>);

  return (
    <Modal title={`${l("Accès", "Access")} · ${driveName}/${path}`} onClose={onClose} wide>
      <p className="mb-3 text-xs text-muted">{l("Un accès donné sur un dossier s'applique à tout ce qu'il contient. Sans accès, la personne ne voit pas le dossier.", "Access given on a folder covers everything inside it. Without access, a person does not see the folder.")}</p>
      <div className="glass-flat mb-4 overflow-x-auto p-1">
        {direct.length + inherited.length === 0 ? <Empty>{l("Personne (sauf les gestionnaires de la documentation) n'a accès à ce dossier.", "Nobody (except documentation managers) has access to this folder.")}</Empty>
          : <table className="grid"><tbody>{direct.map((r) => row(r, false))}{inherited.map((r) => row(r, true))}</tbody></table>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label><span className="label">{l("Pour", "For")}</span><select className="input" value={type} onChange={(e) => { setType(e.target.value as "group" | "user"); setWho(""); }}><option value="group">{l("Un groupe", "A group")}</option><option value="user">{l("Une personne", "A person")}</option></select></label>
        <label className="min-w-[180px] flex-1"><span className="label">{type === "group" ? l("Groupe", "Group") : l("Personne", "Person")}</span><select className="input" value={who} onChange={(e) => setWho(e.target.value)}><option value="">—</option>{options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <label><span className="label">{l("Niveau", "Level")}</span><select className="input" value={level} onChange={(e) => setLevel(e.target.value as "view" | "edit")}><option value="view">{l("Lecture", "View")}</option><option value="edit">{l("Modification", "Edit")}</option></select></label>
        <button className="btn btn-primary" disabled={!who} onClick={async () => { setError(""); try { await api("/api/docs/access", { body: { drive, path, principalType: type, principalId: who, level } }); setWho(""); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } }}>{l("Donner l'accès", "Give access")}</button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  );
}

/** Every rule of every library in one place, to audit who can open what. */
function AccessOverview() {
  const l = useL();
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["docs-access", "all"], queryFn: () => api<Rule[]>("/api/docs/access") });
  const [error, setError] = useState("");
  return (
    <div className="glass overflow-x-auto p-2">
      <p className="p-3 text-xs text-muted">{l("Les gestionnaires de la documentation voient tout. Pour ajouter un accès, ouvrez un dossier et utilisez le bouton Accès.", "Documentation managers see everything. To add access, open a folder and use the Access button.")}</p>
      {error && <p role="alert" className="px-3 text-sm text-danger">{error}</p>}
      {!rules.data?.length ? <Empty>{l("Aucune règle d'accès.", "No access rules.")}</Empty> : (
        <table className="grid"><thead><tr><th>{l("Bibliothèque / dossier", "Library / folder")}</th><th>{l("Qui", "Who")}</th><th>{l("Niveau", "Level")}</th><th /></tr></thead>
          <tbody>{rules.data.map((r) => (
            <tr key={r.id}><td>{r.driveName}<span className="text-muted"> / {r.path || "—"}</span></td><td>{r.principalType === "group" ? "👥 " : "👤 "}{r.principalName}</td>
              <td><Chip tone={r.level === "edit" ? "warn" : "ok"}>{r.level === "edit" ? l("Modification", "Edit") : l("Lecture", "View")}</Chip></td>
              <td className="text-right"><button className="btn btn-danger !p-1.5" aria-label="remove" onClick={() => void api(`/api/docs/access/${r.id}`, { method: "DELETE" }).then(() => qc.invalidateQueries({ queryKey: ["docs-access"] })).catch((e) => setError(errMsg(e, "Error")))}><Trash2 size={14} /></button></td></tr>))}</tbody></table>)}
    </div>
  );
}
