import { randomUUID } from "node:crypto";
import { pool } from "../db.ts";
import { quebecToday } from "./quebecDate.ts";
import { planFrom, type ClientRow, type Planned } from "./autoTasksPlan.ts";
import { planCustom, type CustomRule } from "./customRulesPlan.ts";

// Rules (taxes, DAS, payroll, year-end, T4/RL-1) live in autoTasksPlan.ts, the firm's own rules in customRulesPlan.ts, so they can be tested without a database.
export { planFrom, type Planned, type ClientRow, type DoneFiling } from "./autoTasksPlan.ts";

const CLIENT_SELECT = `select c.id, c.name, c.tax_frequency, c.class_key, t.resource_id, t.fiscal_month, coalesce(t.das_filer,'') as das_filer, coalesce(t.payroll_period,'') as payroll_period,
            coalesce(t.t4_on,false) as t4_on, coalesce(t.rl1_on,false) as rl1_on, coalesce(t.t4a_on,false) as t4a_on
       from clients c left join client_tracking t on t.client_id = c.id where c.status = 'active'`;

const prevMonthKey = (today: string) => {
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  const prev = new Date(Date.UTC(ty, tm - 2, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
};

// $2 (client) limits the aggregated client list to that client; it is null for "every client".
const RULE_SELECT = `select r.id, r.name, r.enabled, r.title_template, r.description_template, r.bullets, r.cadence, r.weekday, r.day_of_month, r.month, r.due_after_days, r.due_day_of_month,
       r.scope, r.scope_class_key, r.assignee_mode, r.assignee_user_id,
       array(select j.client_id from auto_task_rule_clients j where j.rule_id = r.id and ($2::uuid is null or j.client_id = $2)) as client_ids
  from auto_task_rules r`;

export const toRule = (r: Record<string, any>): CustomRule => ({
  id: r.id, name: r.name, enabled: r.enabled, titleTemplate: r.title_template, descriptionTemplate: r.description_template, bullets: r.bullets ?? [],
  cadence: r.cadence, weekday: r.weekday, dayOfMonth: r.day_of_month, month: r.month, dueAfterDays: r.due_after_days, dueDayOfMonth: r.due_day_of_month,
  scope: r.scope, scopeClassKey: r.scope_class_key, clientIds: r.client_ids ?? [], assigneeMode: r.assignee_mode, assigneeUserId: r.assignee_user_id,
});

/** Custom rules: all of them, one by id, or only those that can apply to one client. */
export async function loadRules(opts: { clientId?: string; ruleId?: string; enabledOnly?: boolean } = {}): Promise<CustomRule[]> {
  const r = await pool.query(
    `${RULE_SELECT} where ($1::uuid is null or r.id = $1) and (not $3::boolean or r.enabled)
       and ($2::uuid is null or r.scope = 'all' or (r.scope = 'class' and r.scope_class_key = (select class_key from clients where id = $2))
            or (r.scope = 'clients' and exists (select 1 from auto_task_rule_clients j where j.rule_id = r.id and j.client_id = $2)))
     order by r.created_at`, [opts.ruleId ?? null, opts.clientId ?? null, opts.enabledOnly ?? true]);
  return r.rows.map(toRule);
}

async function plan(today: string, clientId?: string, ruleId?: string): Promise<Planned[]> {
  const clients: ClientRow[] = (await pool.query(`${CLIENT_SELECT} and ($1::uuid is null or c.id = $1) order by lower(c.name)`, [clientId ?? null])).rows;
  if (!clients.length) return [];
  const out: Planned[] = [];
  if (!ruleId) {
    const doneFilings = (await pool.query(
      "select client_id, kind, period, item, status from client_filings where kind in ('tax','das') and period = $1 and status in ('done','na') and ($2::uuid is null or client_id = $2)",
      [prevMonthKey(today), clientId ?? null])).rows;
    out.push(...planFrom({ clients, doneFilings }, today));
  }
  out.push(...planCustom(await loadRules({ clientId, ruleId }), clients, today));
  return out;
}

export async function planAutoTasks(today = quebecToday()): Promise<Planned[]> { return plan(today); }

/** What is planned and not yet created. Only recent log rows matter: a planned task always belongs to the current window, and the claim in create() is the real guard. */
async function fresh(planned: Planned[], clientId?: string): Promise<Planned[]> {
  if (!planned.length) return [];
  const logged = new Set((await pool.query(
    "select client_id || '|' || rule || '|' || period as k from auto_task_log where created_at > now() - interval '90 days' and ($1::uuid is null or client_id = $1)", [clientId ?? null])).rows.map((r) => r.k as string));
  return planned.filter((p) => !logged.has(`${p.clientId}|${p.rule}|${p.period}`));
}

async function createOne(p: Planned): Promise<boolean> {
  // One transaction per task: the claim, the task, its bullets and the log update commit together, so a failure
  // rolls the claim back and a later run retries. The claim (on conflict do nothing) stops two runs creating it twice.
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await client.query("insert into auto_task_log (client_id, rule, period) values ($1,$2,$3) on conflict do nothing returning client_id", [p.clientId, p.rule, p.period]);
    if (!claim.rowCount) { await client.query("rollback"); return false; }
    // The assignee must still be an active staff member.
    const t = await client.query(
      `insert into tasks (title, description, status, priority, assignee_id, client_id, start_date, due_date, visibility, tags)
       values ($1,$2,'todo','normal',(select id from users where id = $3 and kind = 'staff' and active),$4,$5,$6,'team',$7::text[]) returning id`,
      [p.title, p.description, p.assigneeId, p.clientId, p.start, p.due, p.tags ?? ["auto", "suivi-fiscal"]]);
    const id = t.rows[0].id;
    if (p.bullets.length) await client.query("insert into task_checklist (task_id, text, position) select $1, b.t, b.i - 1 from unnest($2::text[]) with ordinality as b(t, i)", [id, p.bullets]);
    await client.query("update auto_task_log set task_id = $4 where client_id = $1 and rule = $2 and period = $3", [p.clientId, p.rule, p.period, id]);
    await client.query("commit");
    return true;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error(`[auto-tasks] failed for ${p.title}:`, e);
    return false;
  } finally {
    client.release();
  }
}

const CHUNK = 200;
const keyOf = (p: { clientId: string; rule: string; period: string }) => `${p.clientId}|${p.rule}|${p.period}`;

/** One chunk in one transaction: bulk claim, bulk tasks, one checklist insert, log update. Throws (after rollback) on any failure. */
async function createChunk(list: Planned[]): Promise<Planned[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await client.query(
      "insert into auto_task_log (client_id, rule, period) select * from unnest($1::uuid[], $2::text[], $3::text[]) on conflict do nothing returning client_id, rule, period",
      [list.map((p) => p.clientId), list.map((p) => p.rule), list.map((p) => p.period)]);
    const claimed = new Set<string>(claim.rows.map((r) => `${r.client_id}|${r.rule}|${r.period}`));
    const won: Planned[] = [];
    for (const p of list) { const k = keyOf(p); if (claimed.has(k)) { claimed.delete(k); won.push(p); } }   // delete: a duplicate in the list is created once
    if (!won.length) { await client.query("rollback"); return []; }
    const ids = won.map(() => randomUUID());
    // The assignee must still be an active staff member.
    await client.query(
      `insert into tasks (id, title, description, status, priority, assignee_id, client_id, start_date, due_date, visibility, tags)
       select i.id, i.title, i.description, 'todo', 'normal', (select u.id from users u where u.id = i.assignee and u.kind = 'staff' and u.active), i.client, i.start, i.due, 'team', array(select jsonb_array_elements_text(i.tags::jsonb))
         from unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::date[], $7::date[], $8::text[]) as i(id, title, description, assignee, client, start, due, tags)`,
      [ids, won.map((p) => p.title), won.map((p) => p.description), won.map((p) => p.assigneeId), won.map((p) => p.clientId), won.map((p) => p.start), won.map((p) => p.due),
        won.map((p) => JSON.stringify(p.tags ?? ["auto", "suivi-fiscal"]))]);
    const bt: string[] = [], bi: string[] = [], bp: number[] = [];
    won.forEach((p, n) => p.bullets.forEach((b, i) => { bi.push(ids[n]!); bt.push(b); bp.push(i); }));
    if (bt.length) await client.query("insert into task_checklist (task_id, text, position) select * from unnest($1::uuid[], $2::text[], $3::int[])", [bi, bt, bp]);
    await client.query(
      "update auto_task_log l set task_id = x.task_id from unnest($1::uuid[], $2::text[], $3::text[], $4::uuid[]) as x(client_id, rule, period, task_id) where l.client_id = x.client_id and l.rule = x.rule and l.period = x.period",
      [won.map((p) => p.clientId), won.map((p) => p.rule), won.map((p) => p.period), ids]);
    await client.query("commit");
    return won;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function create(list: Planned[]): Promise<Planned[]> {
  const created: Planned[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    try { created.push(...(await createChunk(chunk))); }
    catch (e) {
      // The chunk rolled back (claims undone): retry row by row so one bad row does not block the others.
      console.error("[auto-tasks] chunk failed, retrying row by row:", e);
      for (const p of chunk) if (await createOne(p)) created.push(p);
    }
  }
  return created;
}

let running = false;
/** True while a full run is in progress (the hourly tick and manual runs never overlap). */
export const autoTasksRunning = () => running;

/** Creates what is planned and not yet created. Returns the new tasks (or, with dry, what would be created). A run already in progress makes this a no-op. */
export async function runAutoTasks(opts: { today?: string; dry?: boolean } = {}): Promise<Planned[]> {
  if (opts.dry) return fresh(await plan(opts.today ?? quebecToday()));
  if (running) return [];
  running = true;
  try { return await create(await fresh(await plan(opts.today ?? quebecToday()))); }
  finally { running = false; }
}

/** Same, for one client only (one query for its data). Called right after a setting that implies tasks changes. */
export async function runAutoTasksForClient(clientId: string, opts: { today?: string; dry?: boolean } = {}): Promise<Planned[]> {
  const todo = await fresh(await plan(opts.today ?? quebecToday(), clientId), clientId);
  return opts.dry ? todo : create(todo);
}

/** Fire and forget: never fails and never delays the request that triggered it. The hourly tick stays the safety net. */
export function autoTasksSoon(clientId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) return;
  void runAutoTasksForClient(clientId).catch((e) => console.error("[auto-tasks] client run failed:", e));
}

/** One custom rule, for every client it applies to (used when a rule is created, enabled or run by hand). */
export async function runCustomRule(ruleId: string, opts: { today?: string; dry?: boolean } = {}): Promise<Planned[]> {
  const todo = await fresh(await plan(opts.today ?? quebecToday(), undefined, ruleId));
  return opts.dry ? todo : create(todo);
}

/** Preview of a rule that may not be saved yet: what it would create now (minus what a saved rule already created). */
export async function previewRule(rule: CustomRule, opts: { today?: string } = {}): Promise<Planned[]> {
  const today = opts.today ?? quebecToday();
  const clients: ClientRow[] = (await pool.query(`${CLIENT_SELECT} order by lower(c.name)`)).rows;
  const planned = planCustom([{ ...rule, enabled: true }], clients, today);
  return rule.id ? fresh(planned) : planned;
}

export async function autoTaskTick(): Promise<void> {
  const made = await runAutoTasks();
  if (made.length) console.log(`[auto-tasks] created ${made.length} task(s)`);
}
