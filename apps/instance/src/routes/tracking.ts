import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, isUuid } from "./util.ts";

// Tax follow-up calendar: which DAS, taxes, payroll, year-end and T4/RL1/RL31/T5 steps are done for each client.
// A missing row means "to do"; saving a box as "to do" with no note or amount deletes its row.
export const trackingRoutes = new Hono<Env>();

const VIEW = requirePermission("clients.tracking.view", "clients.tracking.edit");
const EDIT = requirePermission("clients.tracking.edit");

const Settings = z.object({
  resourceId: z.string().uuid().nullable().optional(), fiscalMonth: z.number().int().min(1).max(12).nullable().optional(),
  booksThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  checkFrequency: z.enum(["", "monthly", "quarterly", "semiannual", "annual"]).optional(), resourceLabel: z.string().max(100).optional(), dasFiler: z.enum(["", "us", "them", "them_ccq_us"]).optional(),
  payrollPeriod: z.enum(["", "weekly", "biweekly", "semimonthly", "monthly"]).optional(),
  payrollSystem: z.string().max(100).optional(), payrollNote: z.string().max(1000).optional(),
});
const COLS: Record<keyof z.infer<typeof Settings>, string> = {
  resourceId: "resource_id", resourceLabel: "resource_label", fiscalMonth: "fiscal_month", booksThrough: "books_through", checkFrequency: "check_frequency", dasFiler: "das_filer",
  payrollPeriod: "payroll_period", payrollSystem: "payroll_system", payrollNote: "payroll_note",
};
const Filing = z.object({
  kind: z.enum(["das", "tax", "payroll", "yearend", "t4rl1", "rl31", "t5", "verify"]),
  period: z.string().regex(/^\d{4}(-\d{2})?$/), item: z.string().max(40).default(""),
  status: z.enum(["todo", "done", "na", "progress", "review"]),
  amount: z.number().min(-1e11).max(1e11).nullable().optional(), note: z.string().max(1000).optional(),
});

/** Everything the calendar needs for a year: clients with their settings, and every ticked box of that year. */
trackingRoutes.get("/", VIEW, async (c) => {
  const year = Number(c.req.query("year")) || new Date().getFullYear();
  const client = c.req.query("client");
  if (client && !isUuid(client)) return c.json({ error: "bad client" }, 400);
  const clients = await pool.query(
    `select c.id, c.name, c.status, c.tax_frequency, c.das_frequency, c.software,
            t.resource_id, u.name as resource_name, coalesce(t.resource_label,'') as resource_label, t.fiscal_month, t.books_through, coalesce(t.check_frequency,'') as check_frequency,
            coalesce(t.das_filer,'') as das_filer, coalesce(t.payroll_period,'') as payroll_period, coalesce(t.payroll_system,'') as payroll_system, coalesce(t.payroll_note,'') as payroll_note
       from clients c left join client_tracking t on t.client_id = c.id left join users u on u.id = t.resource_id
      where c.status <> 'inactive' and ($1::uuid is null or c.id = $1) order by lower(c.name)`, [client ?? null]);
  const filings = await pool.query(
    `select f.client_id, f.kind, f.period, f.item, f.status, f.prev_status, f.amount, f.note, f.updated_at, u.name as updated_by_name
       from client_filings f left join users u on u.id = f.updated_by
      where ($1::uuid is null or f.client_id = $1) and (f.period like $2 || '%' or f.kind = 'yearend')`, [client ?? null, String(year)]);
  return c.json({ year, clients: camelRows(clients), filings: camelRows(filings) });
});

trackingRoutes.put("/:id/settings", EDIT, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const d = await body(c, Settings);
  const keys = (Object.keys(d) as (keyof typeof d)[]).filter((k) => d[k] !== undefined);
  const cols = ["client_id", ...keys.map((k) => COLS[k])];
  const vals = [id, ...keys.map((k) => d[k])];
  const upd = keys.map((k) => `${COLS[k]} = excluded.${COLS[k]}`).concat("updated_at = now()");
  await pool.query(
    `insert into client_tracking (${cols.join(", ")}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")})
     on conflict (client_id) do update set ${upd.join(", ")}`, vals);
  return c.json({ ok: true });
});

trackingRoutes.put("/:id/filing", EDIT, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const d = await body(c, Filing);
  const note = d.note ?? "";
  const prev = (await pool.query("select status, amount, note from client_filings where client_id = $1 and kind = $2 and period = $3 and item = $4", [id, d.kind, d.period, d.item])).rows[0];
  const from = prev?.status ?? "todo";
  // An unticked box keeps its row (status "todo") so the last person to touch it is still known.
  if (prev || d.status !== "todo" || d.amount != null || note) {
    await pool.query(
      `insert into client_filings (client_id, kind, period, item, status, prev_status, amount, note, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (client_id, kind, period, item) do update set status = excluded.status, prev_status = client_filings.status, amount = excluded.amount, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
      [id, d.kind, d.period, d.item, d.status, from, d.amount ?? null, note, auth(c).user.id]);
    if (from !== d.status || Number(prev?.amount ?? 0) !== Number(d.amount ?? 0)) {
      await pool.query("insert into client_filing_log (client_id, kind, period, item, from_status, to_status, user_id) values ($1,$2,$3,$4,$5,$6,$7)", [id, d.kind, d.period, d.item, from, d.status, auth(c).user.id]);
    }
  }
  await audit("tracking.filing", { userId: auth(c).user.id, target: `${d.kind} ${d.period} ${d.item}`.trim() });
  return c.json({ ok: true });
});
