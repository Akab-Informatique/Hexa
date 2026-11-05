import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Lock, Plus, Trash2 } from "lucide-react";
import type { ModuleDef } from "@hexa/shared/permissions";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Field, Modal, PageHeader } from "../components/ui";
import PermissionMatrix from "./PermissionMatrix";

interface GroupRow { id: string; name: string; description: string; permissions: string[]; locked: boolean; isSystem: boolean; members: number }

export default function GroupsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can("admin.groups.manage");
  const groups = useQuery({ queryKey: ["admin-groups"], queryFn: () => api<GroupRow[]>("/api/admin/groups") });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => api<ModuleDef[]>("/api/admin/catalog") });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [error, setError] = useState("");
  const current = groups.data?.find((g) => g.id === selected) ?? groups.data?.[0];

  useEffect(() => { if (current) { setDraft(current.permissions); setError(""); } }, [current?.id, current?.permissions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-groups"] });
  const save = useMutation({
    mutationFn: () => api(`/api/admin/groups/${current!.id}`, { method: "PATCH", body: { permissions: draft } }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError && e.status === 403 ? t("errors.escalation") : t("common.error")),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/admin/groups/${current!.id}`, { method: "DELETE" }),
    onSuccess: async () => { setSelected(null); await refresh(); },
  });
  const dirty = current && JSON.stringify([...draft].sort()) !== JSON.stringify([...current.permissions].sort());

  return (
    <>
      <PageHeader title={t("admin.groups")} actions={manage && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} />{t("admin.newGroup")}</button>} />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <div className="glass space-y-1 p-2 self-start">
          {groups.data?.map((g) => (
            <button key={g.id} onClick={() => setSelected(g.id)} className={`nav-item w-full ${current?.id === g.id ? "active" : ""}`}>
              <span className="flex-1 truncate text-left">{g.name}</span>
              {g.locked && <Lock size={13} />}
              <span className="text-xs opacity-70">{g.members}</span>
            </button>
          ))}
        </div>
        {current && catalog.data && (
          <div className="glass p-5">
            <div className="mb-1 flex items-center gap-2">
              <h2 className="text-lg font-semibold">{current.name}</h2>
              {current.locked ? <span className="chip"><Lock size={12} />{t("admin.locked")}</span> : current.isSystem && <span className="chip">{t("admin.system")}</span>}
            </div>
            <p className="mb-1 text-sm text-muted">{current.description}</p>
            <p className="mb-4 text-xs text-muted">{draft.length} {t("admin.granted")} · {current.members} {t("admin.members")}</p>
            {current.locked && <p className="mb-4 text-sm text-warn">{t("admin.lockedHelp")}</p>}
            <PermissionMatrix mode="group" catalog={catalog.data} granted={draft} onChange={setDraft} disabled={!manage || current.locked} />
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
            {manage && !current.locked && (
              <div className="mt-5 flex justify-between">
                {!current.isSystem ? <button className="btn btn-danger" onClick={() => confirm(t("admin.confirmDelete")) && remove.mutate()}><Trash2 size={15} />{t("admin.deleteGroup")}</button> : <span />}
                <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{t("common.save")}</button>
              </div>
            )}
          </div>
        )}
      </div>
      {creating && <CreateGroup onClose={() => setCreating(false)} onCreated={async (id) => { setCreating(false); await refresh(); setSelected(id); }} />}
    </>
  );
}

function CreateGroup({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const m = useMutation({ mutationFn: () => api<{ id: string }>("/api/admin/groups", { body: { name, description, permissions: [] } }), onSuccess: (r) => onCreated(r.id) });
  return (
    <Modal title={t("admin.newGroup")} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label={t("admin.groupName")}><input className="input" required autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t("admin.groupDescription")}><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button><button className="btn btn-primary" disabled={m.isPending}>{t("common.create")}</button></div>
      </form>
    </Modal>
  );
}
