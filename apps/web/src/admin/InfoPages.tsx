import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Plug } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/ui";

const PROVIDERS = ["o365", "mailjet", "quickbooks", "sharepoint"] as const;

export function IntegrationPage() {
  const { t } = useTranslation();
  const { provider = "" } = useParams();
  if (!(PROVIDERS as readonly string[]).includes(provider)) return null;
  return (
    <>
      <PageHeader title={t(`admin.${provider}`)} actions={<span className="chip chip-warn">● {t("admin.notConfigured")}</span>} />
      <div className="glass p-6">
        <div className="mb-4 flex items-center gap-3"><Plug className="text-brand" /><p className="text-sm">{t(`admin.${provider}Help`)}</p></div>
        <p className="text-sm text-muted">{t("admin.integrationSoon")}</p>
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
