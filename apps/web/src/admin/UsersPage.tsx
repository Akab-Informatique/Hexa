import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Copy, KeyRound, Mail, Plus } from "lucide-react";
import type { ModuleDef } from "@hexa/shared/permissions";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useL } from "../lib/l";
import { Field, Modal, PageHeader } from "../components/ui";
import AccessGrid from "./AccessGrid";

interface UserRow { id: string; email: string; name: string; active: boolean; is_master: boolean; totp_enabled: boolean; last_login_at: string | null; groupIds: string[] }
interface GroupRow { id: string; name: string; permissions: string[]; locked: boolean }
interface UserDetail extends UserRow { locale?: string; overrides: { permission: string; effect: "allow" | "deny" }[]; rights: string[] }

export default function UsersPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => api<UserRow[]>("/api/admin/users") });
  const groups = useQuery({ queryKey: ["admin-groups"], queryFn: () => api<GroupRow[]>("/api/admin/groups") });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const manage = can("admin.users.manage");
  const groupName = (id: string) => groups.data?.find((g) => g.id === id)?.name ?? "?";

  return (
    <>
      <PageHeader title={t("admin.users")} actions={manage && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} />{t("admin.newUser")}</button>} />
      <div className="glass overflow-x-auto p-2">
        <table className="grid">
          <thead><tr><th>{t("common.name")}</th><th>{t("admin.userGroups")}</th><th>{t("admin.mfa")}</th><th>{t("admin.lastLogin")}</th><th>{t("common.status")}</th></tr></thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} className="cursor-pointer" onClick={() => setEditing(u.id)}>
                <td><div className="font-medium">{u.name} {u.is_master && <span className="chip ml-1">{t("admin.master")}</span>}</div><div className="text-xs text-muted">{u.email}</div></td>
                <td className="space-x-1">{u.groupIds.map((g) => <span key={g} className="chip">{groupName(g)}</span>)}</td>
                <td>{u.totp_enabled ? <span className="chip chip-ok">✓</span> : <span className="chip chip-off">—</span>}</td>
                <td className="text-muted">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : t("admin.never")}</td>
                <td>{u.active ? <span className="chip chip-ok">● {t("common.active")}</span> : <span className="chip chip-off">● {t("common.inactive")}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && <CreateUser groups={groups.data ?? []} onClose={() => setCreating(false)} onCreated={(pw) => { setCreating(false); setSecret(pw); void qc.invalidateQueries({ queryKey: ["admin-users"] }); }} />}
      {editing && <EditUser id={editing} groups={groups.data ?? []} readOnly={!manage} onClose={() => setEditing(null)} onSecret={setSecret} />}
      {secret && <Secret value={secret} onClose={() => setSecret(null)} />}
    </>
  );
}

function errorText(e: unknown, t: (k: string) => string) {
  if (e instanceof ApiError && e.status === 409) return t("errors.exists");
  if (e instanceof ApiError && e.status === 403) return t("errors.escalation");
  return t("common.error");
}

function GroupPicker({ groups, value, onChange, disabled }: { groups: GroupRow[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {groups.map((g) => {
        const on = value.includes(g.id);
        return (
          <button key={g.id} type="button" disabled={disabled} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== g.id) : [...value, g.id])}
            className="chip cursor-pointer transition" style={on ? { background: "linear-gradient(135deg, var(--brand), var(--brand-2))", color: "#fff", borderColor: "transparent" } : undefined}>
            {g.name}
          </button>
        );
      })}
    </div>
  );
}

function CreateUser({ groups, onClose, onCreated }: { groups: GroupRow[]; onClose: () => void; onCreated: (pw: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]); // nothing pre-ticked: the admin picks the access row by row (or a group as a preset)
  const l = useL();
  const { can, me } = useAuth();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api<ModuleDef[]>("/api/admin/catalog") });
  const [ov, setOv] = useState<Record<string, "allow" | "deny">>({});
  const inherited = [...new Set(groups.filter((g) => groupIds.includes(g.id)).flatMap((g) => g.permissions))];
  // The server enforces this too; here a non-master admin just can't tick what they don't hold.
  const canGrant = (k: string) => !!me.user?.isMaster || can(k);
  const m = useMutation({
    mutationFn: () => api<{ temporaryPassword: string }>("/api/admin/users", { body: { name, email, groupIds, overrides: Object.entries(ov).map(([permission, effect]) => ({ permission, effect })) } }),
    onSuccess: (r) => onCreated(r.temporaryPassword),
  });
  return (
    <Modal title={t("admin.newUser")} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={t("common.name")}><input className="input" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t("common.email")}><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <div className="mb-2 text-sm font-medium">{l("Accès", "Access")}</div>
        <Field label={t("admin.userGroups")}><GroupPicker groups={groups} value={groupIds} onChange={setGroupIds} /></Field>
        {catalog.data && <div className="mb-4"><AccessGrid catalog={catalog.data} inherited={inherited} overrides={ov} onChange={setOv} canGrant={canGrant} /></div>}
        {m.isError && <p role="alert" className="mb-3 text-sm text-danger">{errorText(m.error, t)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button><button className="btn btn-primary" disabled={m.isPending}>{t("common.create")}</button></div>
      </form>
    </Modal>
  );
}

function EditUser({ id, groups, readOnly, onClose, onSecret }: { id: string; groups: GroupRow[]; readOnly: boolean; onClose: () => void; onSecret: (pw: string) => void }) {
  const { t } = useTranslation();
  const l = useL();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api<ModuleDef[]>("/api/admin/catalog") });
  const detail = useQuery({ queryKey: ["admin-user", id], queryFn: () => api<UserDetail>(`/api/admin/users/${id}`) });
  const [groupIds, setGroupIds] = useState<string[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, "allow" | "deny"> | null>(null);
  const [info, setInfo] = useState<{ name: string; email: string; locale: "fr" | "en" } | null>(null);
  const [note, setNote] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [pwDialog, setPwDialog] = useState(false);
  // All hooks stay above the early return below: returning before them changes the hook count once the data arrives (blank page).
  const save = useMutation({
    mutationFn: (patch: object) => api(`/api/admin/users/${id}`, { method: "PATCH", body: patch }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["admin-users"] }); await qc.invalidateQueries({ queryKey: ["admin-user", id] }); },
  });
  const reset = useMutation({ mutationFn: () => api<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`, { body: {} }), onSuccess: (r) => onSecret(r.temporaryPassword) });
  const sendLink = useMutation({
    mutationFn: () => api<{ emailed: boolean; link?: string }>(`/api/admin/users/${id}/send-reset`, { body: {} }),
    onSuccess: (r) => { if (r.emailed) setNote(l("Courriel envoyé avec un lien de réinitialisation (valide 72 h).", "Email sent with a reset link (valid 72 h).")); else setLink(r.link ?? null); },
  });

  const d = detail.data;
  if (!d || !catalog.data) return null;
  const gIds = groupIds ?? d.groupIds;
  const ov = overrides ?? Object.fromEntries(d.overrides.map((o) => [o.permission, o.effect]));
  const f = info ?? { name: d.name, email: d.email, locale: (d.locale === "en" ? "en" : "fr") as "fr" | "en" };
  // Rights the groups give, computed from the groups currently ticked in the form.
  const inherited = [...new Set(groups.filter((g) => gIds.includes(g.id)).flatMap((g) => g.permissions))];
  const locked = readOnly;
  const canGrant = (k: string) => !!me.user?.isMaster || can(k);
  const msg = (e: unknown) => (e instanceof ApiError && e.status === 409 ? t("errors.exists") : errorText(e, t));

  return (
    <Modal title={`${t("admin.editUser")}: ${d.name}`} onClose={onClose} wide>
      <div className="mb-4 grid gap-x-4 sm:grid-cols-3">
        <label className="mb-3 block"><span className="label">{l("Nom", "Name")}</span><input className="input" value={f.name} disabled={locked} onChange={(e) => setInfo({ ...f, name: e.target.value })} /></label>
        <label className="mb-3 block"><span className="label">{l("Courriel (identifiant)", "Email (sign-in)")}</span><input className="input" type="email" value={f.email} disabled={locked} onChange={(e) => setInfo({ ...f, email: e.target.value })} /></label>
        <label className="mb-3 block"><span className="label">{l("Langue", "Language")}</span><select className="input" value={f.locale} disabled={locked} onChange={(e) => setInfo({ ...f, locale: e.target.value as "fr" | "en" })}><option value="fr">Français</option><option value="en">English</option></select></label>
      </div>
      {!locked && (
        <div className="glass-flat mb-4 flex flex-wrap items-center gap-2 p-3">
          <span className="mr-1 text-sm font-medium">{l("Mot de passe", "Password")}</span>
          <button className="btn" disabled={!d.active || sendLink.isPending} title={l("La personne reçoit un lien à usage unique pour choisir son mot de passe", "The person gets a one-time link to choose a password")} onClick={() => { setNote(""); sendLink.mutate(); }}><Mail size={15} />{l("Envoyer un lien par courriel", "Email a reset link")}</button>
          <button className="btn" onClick={() => setPwDialog(true)}><KeyRound size={15} />{l("Définir un mot de passe", "Set a password")}</button>
          <button className="btn" onClick={() => reset.mutate()}>{l("Mot de passe temporaire", "Temporary password")}</button>
          {note && <span role="status" className="text-sm text-muted">{note}</span>}
          {sendLink.isError && <span role="alert" className="text-sm text-danger">{msg(sendLink.error)}</span>}
        </div>)}
      <Field label={t("admin.userGroups")}><GroupPicker groups={groups} value={gIds} onChange={setGroupIds} disabled={readOnly || d.is_master} /></Field>
      <div className="mb-2 text-sm font-medium">{l("Accès", "Access")}</div>
      <AccessGrid catalog={catalog.data} inherited={inherited} overrides={ov} onChange={setOverrides} disabled={readOnly || d.is_master} canGrant={canGrant} />
      {save.isError && <p role="alert" className="mt-3 text-sm text-danger">{msg(save.error)}</p>}
      {!readOnly && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <button className="btn btn-danger" onClick={() => save.mutate({ active: !d.active })}>{d.active ? t("admin.deactivate") : t("admin.reactivate")}</button>
          <button className="btn btn-primary" disabled={save.isPending || !f.name.trim() || !f.email.trim()}
            onClick={() => save.mutate({ name: f.name.trim(), email: f.email.trim(), locale: f.locale, groupIds: gIds, overrides: Object.entries(ov).map(([permission, effect]) => ({ permission, effect })) }, { onSuccess: onClose })}>{t("common.save")}</button>
        </div>
      )}
      {pwDialog && <SetPassword id={id} name={d.name} onClose={() => setPwDialog(false)} onDone={() => { setPwDialog(false); setNote(l("Mot de passe défini.", "Password set.")); }} />}
      {link && (
        <Modal title={l("Lien de réinitialisation", "Reset link")} onClose={() => setLink(null)}>
          <p className="mb-3 text-sm text-muted">{l("Aucun courriel n'a pu partir (Mailjet n'est pas configuré ou a échoué). Transmettez ce lien à la personne (valide 72 h, un seul usage).", "No email could be sent (Mailjet is not configured or failed). Pass this link to the person (valid 72 h, single use).")}</p>
          <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={() => void navigator.clipboard?.writeText(link)}><Copy size={15} />{t("common.copy")}</button><button className="btn btn-primary" onClick={() => setLink(null)}>{t("common.close")}</button></div>
        </Modal>)}
    </Modal>
  );
}

const randomPassword = () => {
  const a = new Uint32Array(4); crypto.getRandomValues(a);
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 16 }, (_, i) => chars[a[i % 4]! % chars.length]).join("") + "!7";
};

/** An administrator picks the password directly; by default the person must change it at next sign-in. */
function SetPassword({ id, name, onClose, onDone }: { id: string; name: string; onClose: () => void; onDone: () => void }) {
  const l = useL();
  const [pw, setPw] = useState("");
  const [must, setMust] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const ok = pw.length >= 12;
  return (
    <Modal title={`${l("Définir un mot de passe", "Set a password")} · ${name}`} onClose={onClose}>
      <p className="mb-3 text-xs text-muted">{l("Au moins 12 caractères. Les sessions ouvertes de la personne sont fermées.", "At least 12 characters. The person's open sessions are signed out.")}</p>
      <label className="mb-3 block"><span className="label">{l("Nouveau mot de passe", "New password")}</span>
        <div className="flex gap-2"><input className="input font-mono" autoFocus value={pw} onChange={(e) => { setPw(e.target.value); setCopied(false); }} autoComplete="off" />
          <button type="button" className="btn" onClick={() => { setPw(randomPassword()); setCopied(false); }}>{l("Générer", "Generate")}</button>
          <button type="button" className="btn" disabled={!pw} onClick={() => { void navigator.clipboard?.writeText(pw); setCopied(true); }}><Copy size={15} />{copied ? l("Copié", "Copied") : l("Copier", "Copy")}</button></div></label>
      <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={must} onChange={(e) => setMust(e.target.checked)} />{l("Exiger un nouveau mot de passe à la prochaine connexion", "Require a new password at next sign-in")}</label>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button>
        <button className="btn btn-primary" disabled={!ok} onClick={() => void api(`/api/admin/users/${id}/set-password`, { body: { password: pw, mustChange: must } }).then(onDone).catch((e) => setError(e instanceof ApiError && e.status === 403 ? l("Seul un administrateur principal peut changer ce compte.", "Only a master user can change this account.") : l("Échec : vérifiez le mot de passe.", "Failed: check the password.")))}>{l("Enregistrer", "Save")}</button></div>
    </Modal>
  );
}

function Secret({ value, onClose }: { value: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={t("admin.tempPassword")} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">{t("admin.tempPasswordHelp")}</p>
      <div className="mb-4 flex items-center gap-2">
        <code className="input select-all font-mono">{value}</code>
        <button className="btn" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true); }}><Copy size={15} />{copied ? t("common.copied") : t("common.copy")}</button>
      </div>
      <div className="flex justify-end"><button className="btn btn-primary" onClick={onClose}>{t("common.close")}</button></div>
    </Modal>
  );
}
