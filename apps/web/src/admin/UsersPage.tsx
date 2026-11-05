import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Copy, KeyRound, Plus } from "lucide-react";
import type { ModuleDef } from "@hexa/shared/permissions";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Field, Modal, PageHeader } from "../components/ui";
import PermissionMatrix from "./PermissionMatrix";

interface UserRow { id: string; email: string; name: string; active: boolean; is_master: boolean; totp_enabled: boolean; last_login_at: string | null; groupIds: string[] }
interface GroupRow { id: string; name: string; permissions: string[]; locked: boolean }
interface UserDetail extends UserRow { overrides: { permission: string; effect: "allow" | "deny" }[]; rights: string[] }

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
  const [groupIds, setGroupIds] = useState<string[]>(() => groups.filter((g) => g.name === "Personnel").map((g) => g.id));
  const m = useMutation({ mutationFn: () => api<{ temporaryPassword: string }>("/api/admin/users", { body: { name, email, groupIds } }), onSuccess: (r) => onCreated(r.temporaryPassword) });
  return (
    <Modal title={t("admin.newUser")} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={t("common.name")}><input className="input" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t("common.email")}><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label={t("admin.userGroups")}><GroupPicker groups={groups} value={groupIds} onChange={setGroupIds} /></Field>
        {m.isError && <p role="alert" className="mb-3 text-sm text-danger">{errorText(m.error, t)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button><button className="btn btn-primary" disabled={m.isPending}>{t("common.create")}</button></div>
      </form>
    </Modal>
  );
}

function EditUser({ id, groups, readOnly, onClose, onSecret }: { id: string; groups: GroupRow[]; readOnly: boolean; onClose: () => void; onSecret: (pw: string) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api<ModuleDef[]>("/api/admin/catalog") });
  const detail = useQuery({ queryKey: ["admin-user", id], queryFn: () => api<UserDetail>(`/api/admin/users/${id}`) });
  const [groupIds, setGroupIds] = useState<string[] | null>(null);
  const [overrides, setOverrides] = useState<Record<string, "allow" | "deny"> | null>(null);
  const d = detail.data;
  if (!d || !catalog.data) return null;
  const gIds = groupIds ?? d.groupIds;
  const ov = overrides ?? Object.fromEntries(d.overrides.map((o) => [o.permission, o.effect]));
  // Rights the groups give, computed from the groups currently ticked in the form.
  const inherited = [...new Set(groups.filter((g) => gIds.includes(g.id)).flatMap((g) => g.permissions))];

  const save = useMutation({
    mutationFn: (patch: object) => api(`/api/admin/users/${id}`, { method: "PATCH", body: patch }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["admin-users"] }); await qc.invalidateQueries({ queryKey: ["admin-user", id] }); },
  });
  const reset = useMutation({ mutationFn: () => api<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`, { body: {} }), onSuccess: (r) => onSecret(r.temporaryPassword) });

  return (
    <Modal title={`${t("admin.editUser")}: ${d.name}`} onClose={onClose} wide>
      <div className="mb-1 text-sm text-muted">{d.email}</div>
      <Field label={t("admin.userGroups")}><GroupPicker groups={groups} value={gIds} onChange={setGroupIds} disabled={readOnly || d.is_master} /></Field>
      <div className="mb-2 text-sm font-medium">{t("admin.userOverrides")}</div>
      <p className="mb-3 text-xs text-muted">{t("admin.overridesHelp")}</p>
      <PermissionMatrix mode="user" catalog={catalog.data} inherited={inherited} overrides={ov} onChange={setOverrides} disabled={readOnly || d.is_master} />
      {save.isError && <p role="alert" className="mt-3 text-sm text-danger">{errorText(save.error, t)}</p>}
      {!readOnly && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <button className="btn" onClick={() => reset.mutate()}><KeyRound size={15} />{t("admin.resetPassword")}</button>
            <button className="btn btn-danger" onClick={() => save.mutate({ active: !d.active })}>{d.active ? t("admin.deactivate") : t("admin.reactivate")}</button>
          </div>
          <button className="btn btn-primary" disabled={save.isPending}
            onClick={() => save.mutate({ groupIds: gIds, overrides: Object.entries(ov).map(([permission, effect]) => ({ permission, effect })) }, { onSuccess: onClose })}>{t("common.save")}</button>
        </div>
      )}
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
