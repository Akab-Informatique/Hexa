// Pure folder-rule logic for the Documentation module (kept apart from the database so it is unit-tested).
export type Level = "view" | "edit";
export interface Rule { path: string; level: Level }
const norm = (p: string) => p.toLowerCase();

/** Highest level a set of rules gives on a path (a rule covers its folder and everything below). */
export function levelOn(rules: Rule[], path: string): Level | null {
  const p = norm(path);
  let best: Level | null = null;
  for (const r of rules) {
    const rp = norm(r.path);
    if (rp === "" || p === rp || p.startsWith(rp + "/")) { if (r.level === "edit") return "edit"; best = "view"; }
  }
  return best;
}

/** True when a rule exists somewhere below the path, so the folder stays visible to reach it. */
export function leadsToAccess(rules: Rule[], path: string): boolean {
  const p = norm(path);
  return rules.some((r) => { const rp = norm(r.path); return p === "" ? true : rp.startsWith(p + "/"); });
}
