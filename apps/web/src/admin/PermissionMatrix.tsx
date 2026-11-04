import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { ModuleDef } from "@nexo/shared/permissions";

type Effect = "allow" | "deny";

interface Common { catalog: ModuleDef[]; disabled?: boolean }
interface GroupMode extends Common { mode: "group"; granted: string[]; onChange: (next: string[]) => void }
interface UserMode extends Common {
  mode: "user";
  /** Rights the user already gets from their groups. */
  inherited: string[];
  overrides: Record<string, Effect>;
  onChange: (next: Record<string, Effect>) => void;
}

const SECTION_KEYS: Record<string, string> = {
  team: "admin.sectionTeam", mytools: "admin.sectionMytools", command: "admin.sectionCommand", management: "admin.sectionManagement",
  accounting: "admin.sectionAccounting", admin: "admin.sectionAdmin", clientportal: "admin.sectionClientportal",
};

/**
 * One matrix, two uses. Group mode: tick the rights the group grants. User mode: for each right,
 * keep what the groups give (inherit), or force allow / deny for this one user.
 * Rights are grouped by module, modules by sidebar section, so a whole module can be granted in one click.
 */
export default function PermissionMatrix(props: GroupMode | UserMode) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "fr";
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const modules = props.catalog.filter((m) => m.audience === "staff");
  const sections = [...new Set(modules.map((m) => m.section))];

  const grantedCount = (m: ModuleDef) =>
    m.permissions.filter((p) => (props.mode === "group" ? props.granted.includes(p.key) : props.overrides[p.key] === "allow" || (props.overrides[p.key] !== "deny" && props.inherited.includes(p.key)))).length;

  const toggleModule = (m: ModuleDef) => {
    if (props.mode !== "group" || props.disabled) return;
    const keys = m.permissions.map((p) => p.key);
    const all = keys.every((k) => props.granted.includes(k));
    props.onChange(all ? props.granted.filter((k) => !keys.includes(k)) : [...new Set([...props.granted, ...keys])]);
  };

  return (
    <div className="space-y-5">
      {sections.map((s) => (
        <div key={s}>
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted">{t(SECTION_KEYS[s] ?? s)}</div>
          <div className="space-y-2">
            {modules.filter((m) => m.section === s).map((m) => {
              const isOpen = open[m.key] ?? false;
              return (
                <div key={m.key} className="glass-flat">
                  <div className="flex items-center gap-2 p-3">
                    <button className="flex flex-1 items-center gap-2 text-left" onClick={() => setOpen((o) => ({ ...o, [m.key]: !isOpen }))} aria-expanded={isOpen}>
                      <ChevronDown size={15} style={{ transform: isOpen ? "rotate(180deg)" : "rotate(-90deg)", transition: "transform .15s" }} />
                      <span className="font-medium">{m.label[lang]}</span>
                      <span className="chip">{grantedCount(m)}/{m.permissions.length}</span>
                    </button>
                    {props.mode === "group" && !props.disabled && <button className="btn !px-2.5 !py-1 text-xs" onClick={() => toggleModule(m)}>{t("admin.selectAll")}</button>}
                  </div>
                  {isOpen && (
                    <ul className="border-t border-white/10 px-3 py-1">
                      {m.permissions.map((p) => (
                        <li key={p.key} className="flex items-center justify-between gap-3 py-2 text-sm">
                          <div className="min-w-0">
                            <div>{p.label[lang]}</div>
                            <code className="text-[11px] text-muted">{p.key}</code>
                          </div>
                          {props.mode === "group" ? (
                            <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" disabled={props.disabled} checked={props.granted.includes(p.key)}
                              onChange={(e) => props.onChange(e.target.checked ? [...props.granted, p.key] : props.granted.filter((k) => k !== p.key))} aria-label={p.label[lang]} />
                          ) : (
                            <Tri value={props.overrides[p.key]} inherited={props.inherited.includes(p.key)} disabled={props.disabled}
                              onChange={(v) => { const next = { ...props.overrides }; if (v) next[p.key] = v; else delete next[p.key]; props.onChange(next); }} />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Tri({ value, inherited, onChange, disabled }: { value?: Effect; inherited: boolean; onChange: (v?: Effect) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const opts: { v?: Effect; label: string }[] = [
    { v: undefined, label: `${t("admin.inherited")} ${inherited ? "✓" : "✗"}` },
    { v: "allow", label: t("admin.allow") },
    { v: "deny", label: t("admin.deny") },
  ];
  return (
    <div className="glass-flat inline-flex shrink-0 p-0.5 text-xs">
      {opts.map((o) => {
        const on = value === o.v;
        const bg = !on ? undefined : o.v === "deny" ? "rgb(248 113 113 / .35)" : o.v === "allow" ? "rgb(74 222 128 / .3)" : "rgb(255 255 255 / .14)";
        return <button key={o.label} disabled={disabled} onClick={() => onChange(o.v)} className="rounded-[9px] px-2.5 py-1 transition" style={{ background: bg, color: on ? "var(--fg)" : "var(--muted)" }}>{o.label}</button>;
      })}
    </div>
  );
}
