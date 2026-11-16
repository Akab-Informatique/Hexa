import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { useL } from "../lib/l";
import { BrandMark } from "../components/ui";
import { useAuth } from "../lib/auth";
import { PageHeader } from "../components/ui";
import { ProviderPanel } from "./IntegrationPanels";

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
        <ProviderPanel provider={provider} />
      </div>
    </>
  );
}

interface Brand { appName: string; primaryColor: string; accentColor: string; logoUrl?: string }
interface Tenant { version: string; plan: string; maxUsers: number | null; branding: Brand; defaultBranding: Brand; brandingOverride: Partial<Brand>; enabledModules: string[]; license: { usable: boolean; reason?: string; lastOkAt?: string } }

export function TenantPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["tenant"], queryFn: () => api<Tenant>("/api/admin/tenant") });
  const d = q.data;
  if (!d) return null;
  return (
    <>
      <PageHeader title={t("admin.tenant")} />
      <div className="grid gap-4 md:grid-cols-2">
        <BrandingCard d={d} onChanged={() => { void q.refetch(); }} />
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

const HEX = /^#[0-9a-fA-F]{6}$/;
interface SiteScan { site: string; title: string; colors: { hex: string; source: string }[]; logos: { url: string; source: string; type: string; bytes: number; dataUrl?: string }[] }

/** The firm's own look (white label): name, the two colors and the logo. Left empty, the supplier's defaults apply. */
function BrandingCard({ d, onChanged }: { d: Tenant; onChanged: () => void }) {
  const l = useL();
  const qc = useQueryClient();
  const { can } = useAuth();
  const manage = can("admin.branding.manage");
  const [name, setName] = useState(d.branding.appName);
  const [primary, setPrimary] = useState(d.branding.primaryColor);
  const [accent, setAccent] = useState(d.branding.accentColor);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [scan, setScan] = useState<SiteScan | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const valid = HEX.test(primary) && HEX.test(accent) && name.trim().length > 0;
  const overridden = Object.keys(d.brandingOverride).length > 0;
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["config"] }); onChanged(); };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setError(""); setMsg(""); setBusy(true);
    try { await fn(); await refresh(); setMsg(done); } catch (e) { setError(e instanceof ApiError ? e.message : "Error"); } finally { setBusy(false); }
  };
  const upload = (f: File) => run(async () => {
    const res = await fetch("/api/admin/branding/logo", { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream", "x-hexa-upload": "1", "x-logo-type": f.type }, body: f });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  }, l("Logo enregistré.", "Logo saved."));
  const scanErrors: Record<string, [string, string]> = {
    invalid_url: ["Adresse invalide. Exemple : www.moncabinet.com", "Invalid address. Example: www.myfirm.com"],
    blocked_address: ["Cette adresse n'est pas permise (seuls les sites publics sont lus).", "This address is not allowed (only public websites are read)."],
    not_a_web_page: ["Cette adresse n'est pas une page web.", "This address is not a web page."],
    timeout: ["Le site met trop de temps à répondre.", "The website takes too long to answer."],
    fetch_failed: ["Impossible de lire ce site. Vérifiez l'adresse.", "Could not read this website. Check the address."],
    too_large: ["Le fichier est trop gros.", "The file is too large."],
    not_an_image: ["Ce fichier n'est pas une image.", "This file is not an image."],
  };
  const scanMsg = (e: unknown) => { const c = e instanceof ApiError ? e.message : "fetch_failed"; return scanErrors[c] ? l(...scanErrors[c]!) : c; };
  const analyze = async () => {
    setScanError(""); setScan(null); setScanning(true);
    try { setScan(await api<SiteScan>("/api/admin/branding/from-site", { body: { url: siteUrl } })); } catch (e) { setScanError(scanMsg(e)); } finally { setScanning(false); }
  };
  const color = (label: string, v: string, set: (x: string) => void) => (
    <label className="block"><span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <input type="color" className="h-10 w-12 cursor-pointer rounded border border-white/15 bg-transparent p-0.5" value={HEX.test(v) ? v : "#000000"} disabled={!manage} onChange={(e) => set(e.target.value)} aria-label={label} />
        <input className="input font-mono" value={v} maxLength={7} disabled={!manage} onChange={(e) => set(e.target.value)} aria-invalid={!HEX.test(v)} />
      </div></label>);
  return (
    <section className="glass p-5">
      <h2 className="mb-1 font-semibold">{l("Image de marque", "Branding")}</h2>
      <p className="mb-4 text-xs text-muted">{l("Le nom, les couleurs et le logo de votre portail. Ils s'appliquent à toute l'application et à l'écran de connexion.", "The name, colors and logo of your portal. They apply to the whole app and the sign-in screen.")}</p>
      {manage && (
        <div className="glass-flat mb-4 p-3">
          <div className="mb-2 text-sm font-medium">{l("Importer depuis votre site web", "Import from your website")}</div>
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (siteUrl.trim()) void analyze(); }}>
            <input className="input min-w-[200px] flex-1" placeholder="www.moncabinet.com" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} inputMode="url" />
            <button className="btn" disabled={scanning || !siteUrl.trim()}>{scanning ? l("Analyse…", "Reading…") : l("Analyser le site", "Read the site")}</button>
          </form>
          {scanError && <p role="alert" className="mt-2 text-sm text-danger">{scanError}</p>}
          {scan && (
            <div className="mt-3 space-y-3">
              <div>
                <div className="mb-1 text-xs text-muted">{l("Couleurs trouvées : choisissez la principale et l'accent, puis enregistrez.", "Colors found: choose the primary and the accent, then save.")}</div>
                {scan.colors.length === 0 ? <p className="text-sm text-muted">{l("Aucune couleur trouvée.", "No colors found.")}</p> : (
                  <div className="flex flex-wrap gap-2">{scan.colors.map((c) => (
                    <div key={c.hex} className="glass-flat flex items-center gap-2 p-1.5 pr-2 text-xs" title={c.source}>
                      <span className="h-7 w-7 rounded-md border border-white/20" style={{ background: c.hex }} />
                      <code>{c.hex}</code>
                      <button type="button" className="btn !px-2 !py-0.5 text-xs" onClick={() => setPrimary(c.hex)}>{l("Principale", "Primary")}</button>
                      <button type="button" className="btn !px-2 !py-0.5 text-xs" onClick={() => setAccent(c.hex)}>{l("Accent", "Accent")}</button>
                    </div>))}</div>)}
              </div>
              <div>
                <div className="mb-1 text-xs text-muted">{l("Logos trouvés : cliquez pour l'utiliser (enregistré tout de suite).", "Logos found: click to use it (saved right away).")}</div>
                {scan.logos.length === 0 ? <p className="text-sm text-muted">{l("Aucun logo utilisable trouvé. Vous pouvez en téléverser un.", "No usable logo found. You can upload one.")}</p> : (
                  <div className="flex flex-wrap gap-2">{scan.logos.map((g) => (
                    <button key={g.url} type="button" disabled={busy} className="glass-flat flex w-32 flex-col items-center gap-1 p-2 text-xs hover:bg-white/10" title={g.url}
                      onClick={() => void run(() => api("/api/admin/branding/logo-from-url", { body: { url: g.url } }), l("Logo enregistré.", "Logo saved."))}>
                      <span className="flex h-14 w-full items-center justify-center rounded-lg bg-black/40 p-1">{g.dataUrl ? <img src={g.dataUrl} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-muted">…</span>}</span>
                      <span className="text-muted">{g.source}</span><span className="btn !px-2 !py-0.5 text-xs">{l("Utiliser", "Use")}</span>
                    </button>))}</div>)}
              </div>
            </div>)}
        </div>)}
      <label className="mb-3 block"><span className="label">{l("Nom de l'application", "App name")}</span><input className="input" value={name} maxLength={60} disabled={!manage} onChange={(e) => setName(e.target.value)} /></label>
      <div className="mb-4 grid grid-cols-2 gap-3">{color(l("Couleur principale", "Primary color"), primary, setPrimary)}{color(l("Couleur d'accent", "Accent color"), accent, setAccent)}</div>
      <div className="mb-4">
        <span className="label">{l("Logo", "Logo")}</span>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex h-14 min-w-14 items-center justify-center rounded-xl border border-white/15 bg-black/30 p-2"><BrandMark name={name || d.branding.appName} logoUrl={d.branding.logoUrl} size={36} /></div>
          {manage && (
            <>
              <label className="btn cursor-pointer">{l("Choisir une image", "Choose an image")}<input type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} /></label>
              {d.brandingOverride.logoUrl && <button className="btn btn-danger" disabled={busy} onClick={() => void run(() => api("/api/admin/branding/logo", { method: "DELETE" }), l("Logo retiré.", "Logo removed."))}>{l("Retirer", "Remove")}</button>}
            </>)}
        </div>
        <p className="mt-1 text-xs text-muted">{l("PNG, JPG, WebP ou SVG, 400 Ko maximum. Un logo clair sur fond transparent convient le mieux.", "PNG, JPG, WebP or SVG, 400 KB maximum. A light logo on a transparent background works best.")}</p>
      </div>
      {manage && (
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={!valid || busy} onClick={() => void run(() => api("/api/admin/branding", { method: "PUT", body: { appName: name.trim(), primaryColor: primary, accentColor: accent } }), l("Enregistré.", "Saved."))}>{l("Enregistrer", "Save")}</button>
          {overridden && <button className="btn" disabled={busy} onClick={() => { if (window.confirm(l("Revenir à l'image de marque par défaut du fournisseur ?", "Go back to the supplier's default branding?"))) void run(async () => { await api("/api/admin/branding", { method: "DELETE" }); setName(d.defaultBranding.appName); setPrimary(d.defaultBranding.primaryColor); setAccent(d.defaultBranding.accentColor); }, l("Valeurs par défaut rétablies.", "Defaults restored.")); }}>{l("Rétablir les valeurs par défaut", "Restore defaults")}</button>}
          {msg && <span role="status" className="text-sm text-muted">{msg}</span>}
          {error && <span role="alert" className="text-sm text-danger">{error}</span>}
        </div>)}
      {!manage && <p className="text-xs text-muted">{l("Vous n'avez pas le droit de modifier l'image de marque.", "You do not have the right to change the branding.")}</p>}
    </section>
  );
}
