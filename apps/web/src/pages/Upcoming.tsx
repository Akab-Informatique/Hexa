import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Hourglass } from "lucide-react";
import { NAV } from "../modules/registry";
import { PageHeader } from "../components/ui";

export default function Upcoming() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const item = NAV.flatMap((m) => m.items).find((i) => i.path === pathname);
  return (
    <>
      <PageHeader title={item ? t(item.labelKey) : ""} />
      <div className="glass grid place-items-center gap-3 p-12 text-center">
        <Hourglass size={34} className="text-brand" />
        <h2 className="text-lg font-semibold">{t("nav.upcomingTitle")}</h2>
        <p className="max-w-md text-sm text-muted">{t("nav.upcomingText")}</p>
      </div>
    </>
  );
}
