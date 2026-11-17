import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { ModuleDef } from "@hexa/shared/permissions";
import { NAV_ALL } from "../modules/registry";
import { itemRights, rowState, setAccess, setModify } from "../modules/access";
import { useL } from "../lib/l";
import PermissionMatrix from "./PermissionMatrix";

type Ov = Record<string, "allow" | "deny">;

/**
 * Access grid mirroring the left menu (same NAV source as the sidebar): one row per page,
 * "Accès" = sees/uses the page, "Modifier" = also edits. Computes the per-user allow overrides;
 * rights coming from the ticked groups show as ticked, "via groupe". The detailed matrix stays below for fine-tuning.
 */
export default function AccessGrid({ catalog, inherited, overrides, onChange, disabled, canGrant }: {
  catalog: ModuleDef[]; inherited: string[]; overrides: Ov; onChange: (o: Ov) => void; disabled?: boolean; canGrant: (k: string) => boolean;
}) {
  const { t } = useTranslation();
  const l = useL();
  const [adv, setAdv] = useState(false);
  const inh = new Set(inherited);
  const rows = (s: (typeof NAV_ALL)[number]) => s.items.filter((i) => !i.upcoming).map((i) => {
    const r = itemRights(i), st = rowState(i, inh, overrides);
    const accessLocked = !!disabled || st.accessViaGroup || (!st.access && !canGrant(r.grant));
    const modifyLocked = !!disabled || st.modifyViaGroup || !r.modify.every(canGrant) || (!st.access && !canGrant(r.grant));
    return { i, r, st, accessLocked, modifyLocked };
  });
  const cb = "h-4 w-4 accent-[var(--brand)]";
  const via = <span className="chip ml-2 text-[10px]">{l("via groupe", "via group")}</span>;

  return (
    <div>
      <div className="glass-flat overflow-x-auto p-2">
        <table className="grid">
          <thead><tr><th>{l("Menu", "Menu")}</th><th className="w-24 text-center">{l("Accès", "Access")}</th><th className="w-24 text-center">{l("Modifier", "Edit")}</th></tr></thead>
          <tbody>
            {NAV_ALL.map((s) => {
              const rs = rows(s);
              if (!rs.length) return null;
              const free = rs.filter((x) => !x.accessLocked);
              const all = rs.every((x) => x.st.access);
              return [
                <tr key={s.key}>
                  <td className="font-medium"><span className="inline-flex items-center gap-2"><s.icon size={16} />{t(s.labelKey)}</span></td>
                  <td className="text-center"><input type="checkbox" className={cb} aria-label={`${t(s.labelKey)} · ${l("tout", "all")}`} disabled={!free.length} checked={all}
                    onChange={(e) => onChange(free.reduce((o, x) => setAccess(x.i, e.target.checked, inh, o), overrides))} /></td>
                  <td />
                </tr>,
                ...rs.map(({ i, r, st, accessLocked, modifyLocked }) => (
                  <tr key={i.path}>
                    <td className="pl-8"><span className="inline-flex items-center gap-2"><i.icon size={14} />{t(i.labelKey)}{st.accessViaGroup && via}</span></td>
                    <td className="text-center"><input type="checkbox" className={cb} aria-label={`${t(i.labelKey)} · ${l("Accès", "Access")}`} disabled={accessLocked} checked={st.access}
                      onChange={(e) => onChange(setAccess(i, e.target.checked, inh, overrides))} /></td>
                    <td className="text-center">{r.modify.length > 0 && <input type="checkbox" className={cb} aria-label={`${t(i.labelKey)} · ${l("Modifier", "Edit")}`} disabled={modifyLocked} checked={st.modify}
                      onChange={(e) => onChange(setModify(i, e.target.checked, inh, overrides))} />}</td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
      <button type="button" className="mt-4 flex items-center gap-2 text-sm font-medium" aria-expanded={adv} onClick={() => setAdv(!adv)}>
        <ChevronDown size={15} style={{ transform: adv ? "rotate(180deg)" : "rotate(-90deg)", transition: "transform .15s" }} />{l("Droits détaillés (avancé)", "Detailed rights (advanced)")}
      </button>
      {adv && <div className="mt-3"><p className="mb-3 text-xs text-muted">{t("admin.overridesHelp")}</p><PermissionMatrix mode="user" catalog={catalog} inherited={inherited} overrides={overrides} onChange={onChange} disabled={disabled} canGrant={canGrant} /></div>}
    </div>
  );
}
