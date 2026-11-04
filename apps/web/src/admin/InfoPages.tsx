import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/ui";

interface IField { key: string; label: { fr: string; en: string }; secret?: boolean; options?: string[]; placeholder?: string; value: string; isSet: boolean }
interface Integration { provider: string; label: string; enabled: boolean; configured: boolean; updatedAt: string | null; fields: IField[] }

/** Each firm enters its own app credentials here. Secrets are stored encrypted and are never shown again. */
export function IntegrationPage() {
  const { t, i18n } = useTranslation();
  const { provider = "" } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["integrations"], queryFn: () => api<Integration[]>("/api/admin/integrations") });
  const [values, setValues] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [msg, setMsg] = useState("");
  const lang = i18n.language === "en" ? "en" : "fr";
  const it = q.data?.find((x) => x.provider === provider);
  if (!it) return null;
  const manage = can("admin.integrations.manage");
  const val = (f: IField) => values[f.key] ?? f.value;
  const save = async () => {
    setMsg("");
    try {
      await api(`/api/admin/integrations/${provider}`, { method: "PUT", body: { values, enabled: enabled ?? it.enabled } });
      setValues({}); setEnabled(null); setMsg(t("common.copied") === "Copié" ? "Enregistré" : "Saved");
      await qc.invalidateQueries({ queryKey: ["integrations"] }); await qc.invalidateQueries({ queryKey: ["dir-integrations"] });
    } catch (e) { setMsg(e instanceof Error ? e.message : "Error"); }
  };
  return (
    <>
      <PageHeader title={it.label} subtitle={t(`admin.${provider}Help`)} actions={<span className={`chip ${it.configured ? "chip-ok" : "chip-warn"}`}>● {it.configured ? (lang === "fr" ? "Configurée" : "Configured") : t("admin.notConfigured")}</span>} />
      <div className="glass max-w-2xl p-6">
        {it.fields.map((f) => (
          <label key={f.key} className="mb-4 block"><span className="label">{f.label[lang]}{f.secret && it.fields.find((x) => x.key === f.key)?.isSet ? (lang === "fr" ? " (enregistré, laisser vide pour conserver)" : " (saved, leave blank to keep)") : ""}</span>
            {f.options ? (
              <select className="input" disabled={!manage} value={val(f)} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}><option value="">—</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
            ) : (
              <input className="input" disabled={!manage} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.secret && f.isSet ? "••••••••••••" : f.placeholder} value={val(f)} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
          </label>
        ))}
        <label className="mb-5 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={!manage} checked={enabled ?? it.enabled} onChange={(e) => setEnabled(e.target.checked)} />{lang === "fr" ? "Activée" : "Enabled"}</label>
        {manage && <div className="flex items-center gap-3"><button className="btn btn-primary" onClick={() => void save()}>{t("common.save")}</button>{msg && <span role="status" className="text-sm text-muted">{msg}</span>}</div>}
        <p className="mt-5 text-xs text-muted">{t("admin.integrationSoon")}</p>
      </div>
    </>
  );
}

interface Tenant { version: string; plan: string; maxUsers: number | null; branding: { appName: string; primaryColor: string; accentColor: string; logoUrl?: string }; enabledModules: string[]; license: { usable: boolean; reason?: string; lastOkAt?: string } }

export function TenantPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["tenant"], queryFn: () => api<Tenant>("/api/admin/tenant") });
  const d = q.data;
  if (!d) return null;
  const swatch = (c: string) => <span className="inline-block h-5 w-5 rounded-md align-middle" style={{ background: c, boxShadow: `0 0 14px ${c}` }} />;
  return (
    <>
      <PageHeader title={t("admin.tenant")} subtitle={t("admin.brandingManaged")} />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="glass p-5">
          <h2 className="mb-3 font-semibold">{t("admin.tenantBranding")}</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-muted">{t("admin.appName")}</dt><dd>{d.branding.appName}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">{t("admin.primary")}</dt><dd>{swatch(d.branding.primaryColor)} <code className="ml-1">{d.branding.primaryColor}</code></dd></div>
            <div className="flex justify-between"><dt className="text-muted">{t("admin.accent")}</dt><dd>{swatch(d.branding.accentColor)} <code className="ml-1">{d.branding.accentColor}</code></dd></div>
          </dl>
        </section>
        <section className="glass p-5">
          <h2 className="mb-3 font-semibold">{t("admin.tenantLicense")}</h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-muted">{t("dashboard.version")}</dt><dd>{d.version}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">{t("dashboard.plan")}</dt><dd>{d.plan}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">{t("dashboard.users")}</dt><dd>{d.maxUsers ?? t("dashboard.unlimited")}</dd></div>
          </dl>
        </section>
        <section className="glass p-5 md:col-span-2">
          <h2 className="mb-3 font-semibold">{t("admin.tenantModules")}</h2>
          <div className="flex flex-wrap gap-2">{d.enabledModules.length ? d.enabledModules.map((m) => <span key={m} className="chip">{m}</span>) : <span className="text-sm text-muted">{t("admin.noModules")}</span>}</div>
        </section>
      </div>
    </>
  );
}

interface AuditRow { id: number; at: string; action: string; target: string | null; user_name: string | null }

export function AuditPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<AuditRow[]>("/api/admin/audit") });
  return (
    <>
      <PageHeader title={t("admin.audit")} />
      <div className="glass overflow-x-auto p-2">
        <table className="grid">
          <thead><tr><th>{t("admin.auditAt")}</th><th>{t("admin.auditUser")}</th><th>{t("admin.auditAction")}</th><th>{t("admin.auditTarget")}</th></tr></thead>
          <tbody>{q.data?.map((r) => (
            <tr key={r.id}><td className="whitespace-nowrap text-muted">{new Date(r.at).toLocaleString()}</td><td>{r.user_name ?? "—"}</td><td><code>{r.action}</code></td><td className="max-w-[240px] truncate text-muted">{r.target ?? ""}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}
