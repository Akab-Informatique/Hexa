import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useL } from "../lib/l";
import { Modal } from "./ui";

// ---------- Directory pickers (users, clients) ----------
export interface DirUser { id: string; name: string }
export interface DirClient { id: string; name: string; status: string }
export const useUsers = () => useQuery({ queryKey: ["dir-users"], queryFn: () => api<DirUser[]>("/api/directory/users"), staleTime: 60_000 });
export const useClients = () => useQuery({ queryKey: ["dir-clients"], queryFn: () => api<DirClient[]>("/api/directory/clients"), staleTime: 30_000 });
export const useIntegrations = () => useQuery({ queryKey: ["dir-integrations"], queryFn: () => api<Record<string, { configured: boolean; enabled: boolean }>>("/api/directory/integrations") });

export const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

// ---------- Generic form ----------
export type FieldType = "text" | "textarea" | "number" | "date" | "select" | "checkbox" | "email" | "url" | "client" | "user" | "section";
export interface FieldDef {
  name: string; label: [string, string]; type?: FieldType; required?: boolean; span?: 1 | 2; placeholder?: string; step?: string;
  options?: { value: string; label: [string, string] | string }[]; rows?: number; hint?: [string, string];
}

export function FormFields({ fields, values, onChange }: { fields: FieldDef[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const l = useL();
  const users = useUsers();
  const clients = useClients();
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });
  return (
    <div className="grid gap-x-4 sm:grid-cols-2">
      {fields.map((f) => {
        const v = values[f.name];
        const label = l(...f.label);
        if (f.type === "section") return <h3 key={f.name} className="mb-3 mt-2 border-b border-white/10 pb-1 text-xs font-semibold uppercase tracking-wide text-muted sm:col-span-2">{label}</h3>;
        let input: ReactNode;
        if (f.type === "textarea") input = <textarea className="input" rows={f.rows ?? 3} required={f.required} placeholder={f.placeholder} value={String(v ?? "")} onChange={(e) => set(f.name, e.target.value)} />;
        else if (f.type === "checkbox") input = <label className="flex items-center gap-2 py-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={Boolean(v)} onChange={(e) => set(f.name, e.target.checked)} />{label}</label>;
        else if (f.type === "select" || f.type === "client" || f.type === "user") {
          const opts = f.type === "client" ? (clients.data ?? []).map((c) => ({ value: c.id, label: c.name as string }))
            : f.type === "user" ? (users.data ?? []).map((u) => ({ value: u.id, label: u.name as string })) : f.options ?? [];
          input = (
            <select className="input" required={f.required} value={String(v ?? "")} onChange={(e) => set(f.name, e.target.value)}>
              {!f.required || f.type !== "select" ? <option value="">—</option> : null}
              {opts.map((o) => <option key={o.value} value={o.value}>{typeof o.label === "string" ? o.label : l(...o.label)}</option>)}
            </select>
          );
        } else input = <input className="input" type={f.type ?? "text"} step={f.step} required={f.required} placeholder={f.placeholder} value={String(v ?? "")} onChange={(e) => set(f.name, f.type === "number" ? e.target.value : e.target.value)} />;
        return (
          <div key={f.name} className={`mb-4 ${f.span === 2 || f.type === "textarea" ? "sm:col-span-2" : ""}`}>
            {f.type !== "checkbox" && <span className="label">{label}{f.required && " *"}</span>}
            {input}
            {f.hint && <span className="mt-1 block text-xs text-muted">{l(...f.hint)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Dialog around FormFields: loads `initial`, calls onSubmit(values), shows server errors inline. */
export function FormDialog({ title, fields, initial, onSubmit, onClose, submitLabel, wide, children }: {
  title: string; fields: FieldDef[]; initial?: Record<string, unknown>; onSubmit: (v: Record<string, unknown>) => Promise<unknown>;
  onClose: () => void; submitLabel?: string; wide?: boolean; children?: ReactNode;
}) {
  const l = useL();
  const [values, setValues] = useState<Record<string, unknown>>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError("");
        try { await onSubmit(values); onClose(); } catch (err) { setError(errMsg(err, l("Une erreur est survenue", "Something went wrong"))); } finally { setBusy(false); }
      }}>
        <FormFields fields={fields} values={values} onChange={setValues} />
        {children}
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{submitLabel ?? l("Enregistrer", "Save")}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Small pieces ----------
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="glass-flat mb-4 inline-flex flex-wrap p-0.5 text-sm" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)} className="rounded-[9px] px-3.5 py-1.5 font-medium transition"
          style={value === t.key ? { background: "linear-gradient(135deg, var(--brand), var(--brand-2))", color: "#fff" } : { color: "var(--muted)" }}>{t.label}</button>
      ))}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="p-8 text-center text-sm text-muted">{children}</div>;

export function Chip({ tone, children }: { tone?: "ok" | "warn" | "off" | "danger"; children: ReactNode }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : tone === "danger" ? "var(--danger)" : tone === "off" ? "var(--muted)" : undefined;
  return <span className="chip" style={{ color }}>{children}</span>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "warn" | "danger" }) {
  return (
    <div className="glass p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold" style={{ color: tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : undefined }}>{value}</div>
    </div>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">{children}</div>;
}

export const confirmDo = (msg: string, fn: () => void) => { if (window.confirm(msg)) fn(); };
