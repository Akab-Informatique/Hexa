import type { NavItem } from "./registry";

/** What ticking "Modifier" on a sidebar row grants, on top of the row's access right. Anything not listed stays in the detailed matrix. */
export const MODIFY: Record<string, string[]> = {
  "/my/kb": ["mytools.kb.edit"],
  "/my/procedures": ["mytools.procedures.edit"],
  "/command/pipeline": ["command.pipeline.edit"],
  "/clients": ["clients.edit"],
  "/tracking": ["clients.tracking.edit"],
  "/tasks": ["tasks.edit"],
  "/docs": ["docs.edit"],
  "/accounting/approvals": ["accounting.approvals.manage"],
  "/accounting/invoices": ["accounting.invoices.edit"],
  "/accounting/contracts": ["clients.contracts.edit"],
  "/services": ["services.manage"],
  "/accounting/vendors": ["accounting.vendors.manage"],
  "/hr": ["hr.manage"],
  "/evolutions": ["evolutions.edit"],
};

type Ov = Record<string, "allow" | "deny">;
type Item = Pick<NavItem, "path" | "permission">;
const arr = (p: string | string[]) => (Array.isArray(p) ? p : [p]);

/** Rights that make the page show in the sidebar (any one), the single right a tick grants (the first, least powerful one), and the Modifier rights. */
export function itemRights(i: Item) {
  const see = arr(i.permission);
  return { see, grant: see[0]!, modify: MODIFY[i.path] ?? [] };
}

export const holds = (k: string, inherited: ReadonlySet<string>, ov: Ov) => ov[k] === "allow" || (ov[k] !== "deny" && inherited.has(k));

export function rowState(i: Item, inherited: ReadonlySet<string>, ov: Ov) {
  const r = itemRights(i);
  const access = r.see.some((k) => holds(k, inherited, ov));
  const modify = r.modify.length > 0 && r.modify.every((k) => holds(k, inherited, ov));
  return {
    access, modify,
    /** Held through a group: removing it means removing the group (or a deny in the detailed matrix). */
    accessViaGroup: r.see.some((k) => ov[k] !== "deny" && ov[k] !== "allow" && inherited.has(k)),
    modifyViaGroup: modify && r.modify.every((k) => ov[k] !== "allow" && inherited.has(k)),
  };
}

/** Pure: the overrides after ticking/unticking "Accès". Ticking grants only the first right; unticking drops this row's own allows. */
export function setAccess(i: Item, on: boolean, inherited: ReadonlySet<string>, ov: Ov): Ov {
  const r = itemRights(i);
  const next = { ...ov };
  if (on) {
    if (!r.see.some((k) => holds(k, inherited, next))) next[r.grant] = "allow";
  } else for (const k of [...r.see, ...r.modify]) if (next[k] === "allow") delete next[k];
  return next;
}

/** Pure: "Modifier" implies "Accès". */
export function setModify(i: Item, on: boolean, inherited: ReadonlySet<string>, ov: Ov): Ov {
  const r = itemRights(i);
  if (!on) { const next = { ...ov }; for (const k of r.modify) if (next[k] === "allow") delete next[k]; return next; }
  const next = setAccess(i, true, inherited, ov);
  for (const k of r.modify) if (!holds(k, inherited, next)) next[k] = "allow";
  return next;
}
