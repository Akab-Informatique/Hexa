import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, isUuid } from "./util.ts";
import { autoTasksRunning, autoTasksSoon, runAutoTasks } from "../lib/autoTasks.ts";

// Tax follow-up calendar: which DAS, taxes, payroll, year-end and T4/RL1/RL31/T5 steps are done for each client.
// A missing row means "to do"; saving a box as "to do" with no note or amount deletes its row.
export const trackingRoutes = new Hono<Env>();

const VIEW = requirePermission("clients.tracking.view", "clients.tracking.edit");
const EDIT = requirePermission("clients.tracking.edit");

const Settings = z.object({
  resourceId: z.string().uuid().nullable().optional(), fiscalMonth: z.number().int().min(1).max(12).nullable().optional(),
  booksThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  checkFrequency: z.enum(["", "monthly", "quarterly", "semiannual", "annual"]).optional(), resourceLabel: z.string().trim().max(100).optional(), dasFiler: z.string().trim().max(60).optional(),
  payrollPeriod: z.enum(["", "weekly", "biweekly", "semimonthly", "monthly"]).optional(),
  t4On: z.boolean().optional(), rl1On: z.boolean().optional(), t4aOn: z.boolean().optional(),
  payrollSystem: z.string().trim().max(100).optional(), payrollNote: z.string().trim().max(1000).optional(),
});
const COLS: Record<keyof z.infer<typeof Settings>, string> = {
  resourceId: "resource_id", resourceLabel: "resource_label", fiscalMonth: "fiscal_month", booksThrough: "books_through", checkFrequency: "check_frequency", dasFiler: "das_filer",
  payrollPeriod: "payroll_period", t4On: "t4_on", rl1On: "rl1_on", t4aOn: "t4a_on", payrollSystem: "payroll_system", payrollNote: "payroll_note",
};
const KINDS = ["das", "tax", "payroll", "yearend", "t4rl1", "rl31", "t5", "verify"] as const;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/, YEAR = /^\d{4}$/;
// Allowed (item, period shape) per kind, as the calendar UI writes them.
const ITEMS: Record<(typeof KINDS)[number], { items: string[]; period: RegExp }> = {
  das: { items: ["fed", "prov", "ccq"], period: MONTH },
  tax: { items: [""], period: MONTH },
  yearend: { items: [""], period: YEAR }, verify: { items: [""], period: YEAR }, rl31: { items: [""], period: YEAR },
  payroll: { items: ["paies", "das", "ccq", "t4"], period: YEAR },
  t4rl1: { items: ["t4", "t4sum", "rl1", "t4a", "rl1sum", "car", "cnesst"], period: YEAR },
  t5: { items: ["t5", "sum"], period: YEAR },
};
const Filing = z.object({
  kind: z.enum(KINDS),
  period: z.string().regex(/^\d{4}(-\d{2})?$/), item: z.string().max(40).default(""),
  status: z.enum(["todo", "done", "na", "progress", "review"]),
  amount: z.number().min(-1e11).max(1e11).nullable().optional(), note: z.string().max(1000).optional(),
}).superRefine((d, ctx) => {
  const r = ITEMS[d.kind];
  if (!r.items.includes(d.item)) ctx.addIssue({ code: "custom", path: ["item"], message: "invalid item for this kind" });
  if (!r.period.test(d.period)) ctx.addIssue({ code: "custom", path: ["period"], message: "invalid period for this kind" });
});

/** Everything the calendar needs for a year: clients with their settings, and every ticked box of that year. `kinds` (comma list) limits the filings. */
trackingRoutes.get("/", VIEW, async (c) => {
  const yq = c.req.query("year");
  const year = yq ? Number(yq) : new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > 2200) return c.json({ error: "bad year" }, 400);
  const client = c.req.query("client");
  if (client && !isUuid(client)) return c.json({ error: "bad client" }, 400);
  const kq = c.req.query("kinds");
  const kinds = kq ? [...new Set(kq.split(",").map((k) => k.trim()))] : [...KINDS];
  if (kinds.some((k) => !(KINDS as readonly string[]).includes(k))) return c.json({ error: "bad kinds" }, 400);
  const clients = await pool.query(
    `select c.id, c.name, c.status, c.tax_frequency, c.das_frequency, c.software,
            t.resource_id, u.name as resource_name, coalesce(t.resource_label,'') as resource_label, t.fiscal_month, t.books_through, coalesce(t.check_frequency,'') as check_frequency,
            coalesce(t.das_filer,'') as das_filer, coalesce(t.payroll_period,'') as payroll_period, coalesce(t.payroll_system,'') as payroll_system, coalesce(t.payroll_note,'') as payroll_note, coalesce(t.t4_on,false) as t4_on, coalesce(t.rl1_on,false) as rl1_on, coalesce(t.t4a_on,false) as t4a_on
       from clients c left join client_tracking t on t.client_id = c.id left join users u on u.id = t.resource_id
      where c.status <> 'inactive' and ($1::uuid is null or c.id = $1) order by lower(c.name)`, [client ?? null]);
  const filings = await pool.query(
    `select f.client_id, f.kind, f.period, f.item, f.status, f.prev_status, f.amount, f.note, f.updated_at, u.name as updated_by_name
       from client_filings f left join users u on u.id = f.updated_by
      where ($1::uuid is null or f.client_id = $1) and f.kind = any($5::text[])
        and ((f.period >= $2 and f.period < $3) or f.kind = 'yearend' or (f.kind in ('t4rl1','rl31','t5') and f.period = $4))`, [client ?? null, String(year), String(year + 1), String(year - 1), kinds]);
  return c.json({ year, clients: camelRows(clients), filings: camelRows(filings) });
});

trackingRoutes.put("/:id/settings", EDIT, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const d = await body(c, Settings);
  if (!(await pool.query("select 1 from clients where id = $1", [id])).rowCount) return c.json({ error: "not found" }, 404);
  if (d.resourceId && !(await pool.query("select 1 from users where id = $1 and kind = 'staff' and active", [d.resourceId])).rowCount) return c.json({ error: "resource must be an active staff member" }, 400);
  const keys = (Object.keys(d) as (keyof typeof d)[]).filter((k) => d[k] !== undefined);
  const cols = ["client_id", ...keys.map((k) => COLS[k])];
  const vals = [id, ...keys.map((k) => d[k])];
  const upd = keys.map((k) => `${COLS[k]} = excluded.${COLS[k]}`).concat("updated_at = now()");
  await pool.query(
    `insert into client_tracking (${cols.join(", ")}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})
     on conflict (client_id) do update set ${upd.join(", ")}`, vals);
  await audit("tracking.settings", { userId: auth(c).user.id, target: id, detail: { keys } });
  autoTasksSoon(id);   // a box switched on mid-month creates its task now
  return c.json({ ok: true });
});

trackingRoutes.put("/:id/filing", EDIT, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const d = await body(c, Filing);
  const note = d.note ?? "";
  const uid = auth(c).user.id;
  if (!(await pool.query("select 1 from clients where id = $1", [id])).rowCount) return c.json({ error: "not found" }, 404);
  // One transaction: the advisory lock serializes writers of the same box (also when its row does not exist yet), so the
  // log's from_status always comes from the row as it was just before this write, and a change never exists without its log.
  const db = await pool.connect();
  let from = "todo", change: Record<string, unknown> | null = null;
  try {
    await db.query("begin");
    await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`filing|${id}|${d.kind}|${d.period}|${d.item}`]);
    const prev = (await db.query("select status, amount, note from client_filings where client_id = $1 and kind = $2 and period = $3 and item = $4 for update", [id, d.kind, d.period, d.item])).rows[0];
    from = prev?.status ?? "todo";
    // An unticked box keeps its row (status "todo") so the last person to touch it is still known.
    if (prev || d.status !== "todo" || d.amount != null || note) {
      await db.query(
        `insert into client_filings (client_id, kind, period, item, status, prev_status, amount, note, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (client_id, kind, period, item) do update set status = excluded.status, prev_status = client_filings.status, amount = excluded.amount, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
        [id, d.kind, d.period, d.item, d.status, from, d.amount ?? null, note, uid]);
      const amountChanged = Number(prev?.amount ?? 0) !== Number(d.amount ?? 0);
      const noteChanged = (prev?.note ?? "") !== note;
      if (from !== d.status || amountChanged || noteChanged) {
        await db.query("insert into client_filing_log (client_id, kind, period, item, from_status, to_status, user_id) values ($1,$2,$3,$4,$5,$6,$7)", [id, d.kind, d.period, d.item, from, d.status, uid]);
        change = { from, to: d.status, ...(amountChanged ? { amountFrom: prev?.amount == null ? null : Number(prev.amount), amountTo: d.amount ?? null } : {}), ...(noteChanged ? { noteChanged: true } : {}) };
      }
    }
    await db.query("commit");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
  await audit("tracking.filing", { userId: uid, target: `${d.kind} ${d.period} ${d.item}`.trim(), detail: change ?? { from, to: d.status, unchanged: true } });
  return c.json({ ok: true });
});

/** Creates the automatic tasks now (they are also created every hour). With ?dry=1 it only lists what it would create. */
const lastRun = new Map<string, number>();
trackingRoutes.post("/auto-tasks/run", EDIT, async (c) => {
  const dry = c.req.query("dry") === "1";
  const uid = auth(c).user.id;
  if (!dry) {
    if (autoTasksRunning()) return c.json({ error: "a run is already in progress" }, 429);
    const now = Date.now();
    if (now - (lastRun.get(uid) ?? 0) < 10_000) return c.json({ error: "wait a few seconds" }, 429);
    lastRun.set(uid, now);
  }
  const made = await runAutoTasks({ dry });
  if (!dry) await audit("tracking.auto_tasks", { userId: uid, target: `${made.length} tasks` });
  return c.json({ count: made.length, tasks: made.map((p) => ({ clientId: p.clientId, rule: p.rule, title: p.title, due: p.due, start: p.start, bullets: p.bullets })) });
});
