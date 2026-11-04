import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle, ShieldCheck, Sparkles } from "lucide-react";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { NAV } from "../modules/registry";
import { PageHeader } from "../components/ui";

interface Cfg { version: string; plan?: string; maxUsers?: number | null; license?: { usable: boolean; reason?: string } }
interface Upd { current: string; target: string; updateAvailable: boolean; updater: { state: string; step?: string; error?: string } | null }

export default function Dashboard() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const cfg = useQuery({ queryKey: ["config-full"], queryFn: () => api<Cfg>("/api/config") });
  const upd = useQuery({
    queryKey: ["update"], queryFn: () => api<Upd>("/api/update/status"),
    refetchInterval: (q) => (q.state.data?.updater?.state === "running" ? 3000 : 60_000),
  });
  const qc = useQueryClient();
  const [err, setErr] = useState("");
  const install = async () => {
    setErr("");
    try { await api("/api/update/apply", { body: {} }); await qc.invalidateQueries({ queryKey: ["update"] }); }
    catch (e) { setErr(e instanceof ApiError ? e.message : t("common.error")); }
  };

  const running = upd.data?.updater?.state === "running";
  const failed = upd.data?.updater && ["failed", "rolled_back"].includes(upd.data.updater.state);
  const upcoming = NAV.flatMap((m) => m.items.filter((i) => i.upcoming && can(i.permission)).map((i) => ({ ...i, module: m.labelKey })));

  return (
    <>
      <PageHeader title={t("dashboard.welcome", { name: me.user?.name.split(" ")[0] })} subtitle={t("dashboard.subtitle")} />

      <div className="grid gap-4 md:grid-cols-3">
        <section className="glass p-5">
          <div className="mb-3 flex items-center gap-2 text-sm text-muted"><Sparkles size={15} />{t("dashboard.workspace")}</div>
          <dl className="space-y-2 text-sm">
            <Row k={t("dashboard.version")} v={cfg.data?.version ?? "…"} />
            <Row k={t("dashboard.plan")} v={cfg.data?.plan ?? "…"} />
            <Row k={t("dashboard.users")} v={cfg.data?.maxUsers ? String(cfg.data.maxUsers) : t("dashboard.unlimited")} />
          </dl>
        </section>

        <section className="glass p-5">
          <div className="mb-3 flex items-center gap-2 text-sm text-muted"><ShieldCheck size={15} />{t("dashboard.license")}</div>
          {cfg.data?.license?.usable !== false
            ? <span className="chip chip-ok">● {t("dashboard.licenseOk")}</span>
            : <span className="chip chip-warn">● {t("dashboard.licenseProblem")}: {cfg.data?.license?.reason}</span>}
          <p className="mt-4 text-sm text-muted">{t("dashboard.customize")}</p>
        </section>

        {(upd.data?.updateAvailable || running || failed) && (
          <section className="glass p-5">
            <div className="mb-3 flex items-center gap-2 text-sm text-muted"><ArrowUpCircle size={15} />{t("dashboard.updateTitle")}</div>
            {failed && <p className="mb-2 text-sm text-warn">{t("dashboard.updateFailed")}</p>}
            {upd.data?.updateAvailable && <p className="mb-3 text-sm">{t("dashboard.updateText", { version: upd.data.target })}</p>}
            {running
              ? <p className="text-sm text-muted">{t("dashboard.updating")} {upd.data?.updater?.step}</p>
              : me.user?.isMaster
                ? <button className="btn btn-primary" onClick={() => void install()}>{t("dashboard.updateInstall")}</button>
                : <p className="text-xs text-muted">{t("dashboard.updateOnlyMaster")}</p>}
            {err && <p className="mt-2 text-sm text-danger">{err}</p>}
          </section>
        )}
      </div>

      <section className="glass mt-4 p-5">
        <h2 className="text-base font-semibold">{t("dashboard.roadmap")}</h2>
        <p className="mb-4 text-sm text-muted">{t("dashboard.roadmapText")}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {upcoming.map((i) => (
            <Link key={i.path} to={i.path} className="glass-flat flex items-center gap-3 p-3 text-sm no-underline transition hover:bg-white/10">
              <i.icon size={17} className="text-brand" />
              <div className="min-w-0">
                <div className="truncate font-medium">{t(i.labelKey)}</div>
                <div className="truncate text-xs text-muted">{t(i.module)}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>
);
