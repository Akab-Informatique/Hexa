import { describe, expect, test } from "vitest";
import { NAV_ALL as NAV } from "../apps/web/src/modules/registry.ts";
import { holds, itemRights, MODIFY, rowState, setAccess, setModify } from "../apps/web/src/modules/access.ts";
import { isKnownPermission, permissionsFor } from "../packages/shared/src/permissions.ts";

const none = new Set<string>();
const inv = { path: "/accounting/invoices", permission: ["accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage"] };

describe("sidebar item -> permission keys", () => {
  test("every key is a known staff right and every modify entry matches a nav path", () => {
    const staff = new Set(permissionsFor("staff"));
    const paths = new Set(NAV.flatMap((s) => s.items.map((i) => i.path)));
    for (const s of NAV) for (const i of s.items) { const r = itemRights(i); for (const k of [...r.see, ...r.modify]) { expect(isKnownPermission(k), k).toBe(true); expect(staff.has(k), k).toBe(true); } }
    for (const p of Object.keys(MODIFY)) expect(paths.has(p), p).toBe(true);
  });
  test("Accès grants only the first (least powerful) right", () => {
    expect(setAccess(inv, true, none, {})).toEqual({ "accounting.invoices.view": "allow" });
  });
  test("Modifier implies Accès and grants the edit right", () => {
    expect(setModify(inv, true, none, {})).toEqual({ "accounting.invoices.view": "allow", "accounting.invoices.edit": "allow" });
  });
  test("unticking Accès drops the row's allows, keeps others", () => {
    const ov = { "accounting.invoices.view": "allow", "accounting.invoices.edit": "allow", "hr.view": "allow" } as const;
    expect(setAccess(inv, false, none, { ...ov })).toEqual({ "hr.view": "allow" });
  });
  test("rights from a group show ticked via group and add no override", () => {
    const inh = new Set(["accounting.invoices.view"]);
    expect(setAccess(inv, true, inh, {})).toEqual({});
    expect(rowState(inv, inh, {})).toMatchObject({ access: true, accessViaGroup: true, modify: false });
  });
  test("a deny removes the right; ticking replaces it by an allow", () => {
    const inh = new Set(["accounting.invoices.view"]);
    expect(holds("accounting.invoices.view", inh, { "accounting.invoices.view": "deny" })).toBe(false);
    expect(setAccess(inv, true, inh, { "accounting.invoices.view": "deny" })).toEqual({ "accounting.invoices.view": "allow" });
  });
});
