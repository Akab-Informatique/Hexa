import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, isUuid } from "./util.ts";
import { previewRule, runCustomRule, loadRules } from "../lib/autoTasks.ts";
import { nextRun, type CustomRule } from "../lib/customRulesPlan.ts";
import { quebecToday } from "../lib/quebecDate.ts";

// The firm's own recurring automatic tasks. Staff only (requirePermission rejects client-portal users), one permission for everything.
export const autoTaskRuleRoutes = new Hono<Env>();
const PERM = requirePermission("tasks.automation.manage");
const MAX_RULES = 200;

const Int = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();
const Rule = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  titleTemplate: z.string().trim().min(1).max(200),
  descriptionTemplate: z.string().max(5000).default(""),
  bullets: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
  cadence: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  weekday: Int(1, 7), dayOfMonth: Int(1, 31), month: Int(1, 12),
  dueAfterDays: Int(0, 365), dueDayOfMonth: Int(1, 31),
  scope: z.enum(["all", "class", "clients"]).default("all"),
  scopeClassKey: z.string().max(100).nullable().optional(),
  clientIds: z.array(z.string().uuid()).max(2000).default([]),
  assigneeMode: z.enum(["resource", "user", "none"]).default("resource"),
  assigneeUserId: z.string().uuid().nullable().optional(),
}).superRefine((d, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (d.cadence === "weekly" && !d.weekday) bad("weekday", "weekday required");
  if ((d.cadence === "monthly" || d.cadence === "quarterly" || d.cadence === "yearly") && !d.dayOfMonth) bad("dayOfMonth", "day required");
  if (d.cadence === "yearly" && !d.month) bad("month", "month required");
  if (d.cadence === "quarterly" && d.month != null && d.month > 3) bad("month", "month of the quarter is 1 to 3");
  if (d.dueAfterDays != null && d.dueDayOfMonth != null) bad("dueDayOfMonth", "one due setting only");
  if (d.scope === "class" && !d.scopeClassKey) bad("scopeClassKey", "class required");
  if (d.scope === "clients" && !d.clientIds.length) bad("clientIds", "clients required");
  if (d.assigneeMode === "user" && !d.assigneeUserId) bad("assigneeUserId", "user required");
});
type RuleInput = z.infer<typeof Rule>;

/** Keeps only the fields that matter for the chosen cadence / scope / assignee. */
function normalize(d: RuleInput) {
  return {
    ...d,
    weekday: d.cadence === "weekly" ? d.weekday ?? null : null,
    dayOfMonth: d.cadence === "weekly" ? null : d.dayOfMonth ?? null,
    month: d.cadence === "yearly" ? d.month ?? null : d.cadence === "quarterly" ? d.month ?? 1 : null,
    dueAfterDays: d.dueAfterDays ?? null, dueDayOfMonth: d.dueAfterDays != null ? null : d.dueDayOfMonth ?? null,
    scopeClassKey: d.scope === "class" ? d.scopeClassKey ?? null : null,
    clientIds: d.scope === "clients" ? [...new Set(d.clientIds)] : [],
    assigneeUserId: d.assigneeMode === "user" ? d.assigneeUserId ?? null : null,
  };
}

/** The class and the assignee must exist (a staff member who is active). Returns an error code or null. */
async function check(d: ReturnType<typeof normalize>): Promise<string | null> {
  if (d.scopeClassKey && !(await pool.query("select 1 from client_classes where key = $1", [d.scopeClassKey])).rowCount) return "unknown_class";
  if (d.assigneeUserId && !(await pool.query("select 1 from users where id = $1 and kind = 'staff' and active", [d.assigneeUserId])).rowCount) return "unknown_user";
  return null;
}

const COLS = "name, enabled, title_template, description_template, bullets, cadence, weekday, day_of_month, month, due_after_days, due_day_of_month, scope, scope_class_key, assignee_mode, assignee_user_id";
const values = (d: ReturnType<typeof normalize>) => [d.name, d.enabled, d.titleTemplate, d.descriptionTemplate, d.bullets, d.cadence, d.weekday, d.dayOfMonth, d.month, d.dueAfterDays, d.dueDayOfMonth, d.scope, d.scopeClassKey, d.assigneeMode, d.assigneeUserId];

const setClients = (db: { query: typeof pool.query }, ruleId: string, ids: string[]) =>
  ids.length ? db.query("insert into auto_task_rule_clients (rule_id, client_id) select $1, id from clients where id = any($2::uuid[]) on conflict do nothing", [ruleId, ids]) : Promise.resolve();

const toDraft = (id: string, d: ReturnType<typeof normalize>): CustomRule => ({
  id, name: d.name, enabled: d.enabled, titleTemplate: d.titleTemplate, descriptionTemplate: d.descriptionTemplate, bullets: d.bullets, cadence: d.cadence,
  weekday: d.weekday, dayOfMonth: d.dayOfMonth, month: d.month, dueAfterDays: d.dueAfterDays, dueDayOfMonth: d.dueDayOfMonth,
  scope: d.scope, scopeClassKey: d.scopeClassKey, clientIds: d.clientIds, assigneeMode: d.assigneeMode, assigneeUserId: d.assigneeUserId,
});

const summary = (made: Awaited<ReturnType<typeof runCustomRule>>) => ({
  count: made.length,
  tasks: made.slice(0, 100).map((p) => ({ clientId: p.clientId, clientName: p.clientName, title: p.title, start: p.start, due: p.due, assigneeId: p.assigneeId, bullets: p.bullets })),
});

autoTaskRuleRoutes.get("/", PERM, async (c) => {
  const [rules, classes] = await Promise.all([
    pool.query(
      `select r.id, r.name, r.enabled, r.title_template, r.description_template, r.bullets, r.cadence, r.weekday, r.day_of_month, r.month, r.due_after_days, r.due_day_of_month,
              r.scope, r.scope_class_key, r.assignee_mode, r.assignee_user_id, r.updated_at,
              array(select j.client_id from auto_task_rule_clients j where j.rule_id = r.id) as client_ids
         from auto_task_rules r order by lower(r.name), r.created_at limit ${MAX_RULES}`),
    pool.query("select key, label_fr, label_en from client_classes order by position, key"),
  ]);
  return c.json({ rules: camelRows(rules), classes: camelRows(classes) });
});

autoTaskRuleRoutes.post("/preview", PERM, async (c) => {
  const raw = await body(c, Rule.and(z.object({ id: z.string().uuid().optional() })));
  const d = normalize(raw);
  const rule = toDraft(raw.id ?? "", d);
  const made = await previewRule(rule);
  return c.json({ ...summary(made), next: made.length ? null : nextRun(rule, quebecToday()) });
});

autoTaskRuleRoutes.post("/", PERM, async (c) => {
  const d = normalize(await body(c, Rule));
  const err = await check(d);
  if (err) return c.json({ error: err }, 400);
  if (Number((await pool.query("select count(*) as n from auto_task_rules")).rows[0].n) >= MAX_RULES) return c.json({ error: "too_many_rules" }, 409);
  const db = await pool.connect();
  let id: string;
  try {
    await db.query("begin");
    id = (await db.query(`insert into auto_task_rules (${COLS}, created_by) values (${[...Array(15)].map((_, i) => `$${i + 1}`).join(", ")}, $16) returning id`, [...values(d), auth(c).user.id])).rows[0].id;
    await setClients(db, id, d.clientIds);
    await db.query("commit");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
  await audit("auto_task_rule.created", { userId: auth(c).user.id, target: d.name });
  // Catch up inside the current window right away.
  const made = d.enabled ? await runCustomRule(id).catch((e) => { console.error("[auto-tasks] rule run failed:", e); return []; }) : [];
  return c.json({ id, created: made.length }, 201);
});

autoTaskRuleRoutes.patch("/:id", PERM, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const raw = await c.req.json().catch(() => ({}));
  // Light toggle: only { enabled }.
  const toggle = z.object({ enabled: z.boolean() }).strict().safeParse(raw);
  let enabled: boolean;
  if (toggle.success) {
    const r = await pool.query("update auto_task_rules set enabled = $2, updated_at = now() where id = $1 returning name", [id, toggle.data.enabled]);
    if (!r.rowCount) return c.json({ error: "not found" }, 404);
    enabled = toggle.data.enabled;
    await audit(enabled ? "auto_task_rule.enabled" : "auto_task_rule.disabled", { userId: auth(c).user.id, target: r.rows[0].name });
  } else {
    const d = normalize(Rule.parse(raw));
    const err = await check(d);
    if (err) return c.json({ error: err }, 400);
    const db = await pool.connect();
    try {
      await db.query("begin");
      const r = await db.query(
        `update auto_task_rules set ${COLS.split(", ").map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1 returning id`, [id, ...values(d)]);
      if (!r.rowCount) { await db.query("rollback"); return c.json({ error: "not found" }, 404); }
      await db.query("delete from auto_task_rule_clients where rule_id = $1", [id]);
      await setClients(db, id, d.clientIds);
      await db.query("commit");
    } catch (e) {
      await db.query("rollback").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
    enabled = d.enabled;
    await audit("auto_task_rule.updated", { userId: auth(c).user.id, target: d.name });
  }
  const made = enabled ? await runCustomRule(id).catch((e) => { console.error("[auto-tasks] rule run failed:", e); return []; }) : [];
  return c.json({ ok: true, created: made.length });
});

autoTaskRuleRoutes.delete("/:id", PERM, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const db = await pool.connect();
  try {
    await db.query("begin");
    const r = await db.query("delete from auto_task_rules where id = $1 returning name", [id]);
    if (!r.rowCount) { await db.query("rollback"); return c.json({ error: "not found" }, 404); }
    await db.query("delete from auto_task_log where rule = $1", [`custom:${id}`]);   // tasks already created stay
    await db.query("commit");
    await audit("auto_task_rule.deleted", { userId: auth(c).user.id, target: r.rows[0].name });
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
  return c.json({ ok: true });
});

/** Runs one rule now (what is due in its current window). With ?dry=1 it only lists what it would create. */
autoTaskRuleRoutes.post("/:id/run", PERM, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const [rule] = await loadRules({ ruleId: id, enabledOnly: false });
  if (!rule) return c.json({ error: "not found" }, 404);
  if (!rule.enabled) return c.json({ error: "rule_disabled" }, 409);
  const dry = c.req.query("dry") === "1";
  const made = await runCustomRule(id, { dry });
  if (!dry) await audit("auto_task_rule.run", { userId: auth(c).user.id, target: rule.name, detail: { count: made.length } });
  return c.json({ ...summary(made), next: made.length ? null : nextRun(rule, quebecToday()) });
});
