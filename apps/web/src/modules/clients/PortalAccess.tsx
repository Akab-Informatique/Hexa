import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderLock, KeyRound, Mail, Trash2, UserMinus } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg } from "../../components/kit";
import { Modal } from "../../components/ui";

interface Contact { id: string; name: string; email: string; title: string; userId: string | null; active: boolean | null; lastLoginAt: string | null }
interface Rule { id: string; driveId: string; driveName: string; path: string; level: string }
interface Portal { contacts: Contact[]; rules: Rule[]; mail: boolean }

/** Client portal: which contacts can sign in, and which SharePoint folders the whole client may read. */
export function PortalAccess({ clientId }: { clientId: string }) {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["client-portal", clientId], queryFn: () => api<Portal>(`/api/clients/${clientId}/portal`) });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [folder, setFolder] = useState(false);
  const manage = can("clients.users.manage");
  const refresh = () => qc.invalidateQueries({ queryKey: ["client-portal", clientId] });
  const code: Record<string, [string, string]> = {
    contact_email_missing: ["Ce contact n'a pas de courriel valide.", "This contact has no valid email."], email_used: ["Ce courriel est déjà utilisé par un autre compte.", "This email is already used by another account."],
  };
  const act = async (fn: () => Promise<{ emailed?: boolean; link?: string } | unknown>, ok: [string, string]) => {
    setMsg(null);
    try {
      const r = (await fn()) as { emailed?: boolean; link?: string } | undefined;
      if (r?.link) setLink(r.link);
      setMsg({ ok: true, text: r && "emailed" in r ? (r.emailed ? l("Courriel d'accueil envoyé.", "Welcome email sent.") : l("Courriel non envoyé (Mailjet non configuré) : copiez le lien.", "Email not sent (Mailjet not set up): copy the link.")) : l(...ok) });
      await refresh();
    } catch (e) { const c = errMsg(e, "Error"); setMsg({ ok: false, text: code[c] ? l(...code[c]!) : c }); }
  };
  const data = q.data;
  if (!data) return null;
  return (
    <section className="mt-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{l("Portail client", "Client portal")}</h3>
      <div className="glass p-3">
        {data.contacts.length === 0 ? <Empty>{l("Ajoutez un contact avec un courriel pour lui donner accès.", "Add a contact with an email to give them access.")}</Empty> : (
          <ul className="divide-y divide-white/10">{data.contacts.map((k) => {
            const on = Boolean(k.userId && k.active);
            return (
              <li key={k.id} className="flex flex-wrap items-center gap-3 p-2">
                <div className="min-w-0 flex-1"><div className="text-sm font-medium">{k.name}</div><div className="text-xs text-muted">{k.email || l("pas de courriel", "no email")}{on && k.lastLoginAt ? ` · ${l("dernière connexion", "last sign-in")} ${fmtDate(k.lastLoginAt, loc)}` : ""}</div></div>
                <Chip tone={on ? "ok" : "off"}>{on ? (k.lastLoginAt ? l("Accès actif", "Access on") : l("Invité", "Invited")) : k.userId ? l("Accès retiré", "Access removed") : l("Aucun accès", "No access")}</Chip>
                {manage && (on
                  ? <><button className="btn !py-1 text-xs" onClick={() => void act(() => api(`/api/clients/${clientId}/portal/${k.id}/resend`, { body: {} }), ["", ""])}><Mail size={13} />{l("Renvoyer le lien", "Resend link")}</button>
                      <button className="btn btn-danger !py-1 text-xs" onClick={() => confirmDo(l("Retirer l'accès au portail ?", "Remove portal access?"), () => void act(() => api(`/api/clients/${clientId}/portal/${k.id}`, { method: "DELETE" }), ["Accès retiré.", "Access removed."]))}><UserMinus size={13} />{l("Retirer", "Remove")}</button></>
                  : <button className="btn btn-primary !py-1 text-xs" disabled={!k.email} onClick={() => void act(() => api(`/api/clients/${clientId}/portal/${k.id}`, { body: { lang: l("fr", "en") } }), ["", ""])}><KeyRound size={13} />{k.userId ? l("Rétablir l'accès", "Restore access") : l("Donner l'accès", "Give access")}</button>)}
              </li>);
          })}</ul>)}
        {msg && <p role="status" className="p-2 text-sm" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</p>}
        <p className="p-2 text-xs text-muted">{l("Le contact reçoit un courriel avec un lien pour choisir son mot de passe. Il ne voit que les données de cette entreprise.", "The contact gets an email with a link to choose a password. They only see this company's data.")}</p>
      </div>

      <h3 className="mb-2 mt-5 text-sm font-semibold uppercase tracking-wide text-muted">{l("Documents du portail", "Portal documents")}</h3>
      <div className="glass p-3">
        {data.rules.length === 0 ? <Empty>{l("Aucun dossier SharePoint partagé avec ce client.", "No SharePoint folder shared with this client.")}</Empty> : (
          <ul className="divide-y divide-white/10">{data.rules.map((r) => (
            <li key={r.id} className="flex items-center gap-3 p-2 text-sm"><FolderLock size={15} className="text-muted" /><span className="flex-1">{r.driveName} / {r.path || l("(racine)", "(root)")}</span><Chip>{l("Lecture", "View")}</Chip>
              {can("docs.manage", "docs.access.manage") && <button className="btn btn-danger !p-1.5" aria-label="remove" onClick={() => confirmDo(l("Retirer ce dossier ?", "Remove this folder?"), () => void act(() => api(`/api/docs/access/${r.id}`, { method: "DELETE" }), ["Dossier retiré.", "Folder removed."]))}><Trash2 size={14} /></button>}</li>))}</ul>)}
        {can("docs.manage", "docs.access.manage") && <div className="p-2"><button className="btn" onClick={() => setFolder(true)}><FolderLock size={14} />{l("Partager un dossier", "Share a folder")}</button></div>}
      </div>
      {folder && <FolderDialog clientId={clientId} onClose={() => setFolder(false)} onDone={async () => { setFolder(false); await refresh(); }} />}
      {link && (
        <Modal title={l("Lien d'invitation", "Invitation link")} onClose={() => setLink(null)}>
          <p className="mb-3 text-sm text-muted">{l("Aucun courriel n'a pu partir. Transmettez ce lien au contact (valide 72 h, un seul usage).", "No email could be sent. Pass this link to the contact (valid 72 h, single use).")}</p>
          <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <div className="mt-4 flex justify-end"><button className="btn" onClick={() => setLink(null)}>{l("Fermer", "Close")}</button></div>
        </Modal>)}
    </section>
  );
}

function FolderDialog({ clientId, onClose, onDone }: { clientId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const l = useL();
  const libs = useQuery({ queryKey: ["docs-libs"], queryFn: () => api<{ id: string; name: string }[]>("/api/docs/libraries") });
  const [drive, setDrive] = useState(""), [path, setPath] = useState("");
  const [err, setErr] = useState("");
  const d = drive || libs.data?.[0]?.id || "";
  const save = async () => {
    setErr("");
    try { await api("/api/docs/access", { body: { drive: d, path, principalType: "client", principalId: clientId, level: "view" } }); await onDone(); }
    catch (e) { const c = errMsg(e, "Error"); setErr(c === "folder not found" ? l("Ce dossier n'existe pas dans SharePoint.", "That folder does not exist in SharePoint.") : c); }
  };
  return (
    <Modal title={l("Partager un dossier avec ce client", "Share a folder with this client")} onClose={onClose}>
      <label className="mb-3 block"><span className="label">{l("Bibliothèque", "Library")}</span><select className="input" value={d} onChange={(e) => setDrive(e.target.value)}>{(libs.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label className="mb-3 block"><span className="label">{l("Dossier (vide = toute la bibliothèque)", "Folder (empty = the whole library)")}</span><input className="input" placeholder="Clients/Acme" value={path} onChange={(e) => setPath(e.target.value)} /></label>
      <p className="mb-3 text-xs text-muted">{l("Le client pourra lire ce dossier et tout ce qu'il contient, sans rien modifier.", "The client can read this folder and everything in it, never change it.")}</p>
      {err && <p role="alert" className="mb-3 text-sm" style={{ color: "var(--danger)" }}>{err}</p>}
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" disabled={!d} onClick={() => void save()}>{l("Partager", "Share")}</button></div>
    </Modal>
  );
}
