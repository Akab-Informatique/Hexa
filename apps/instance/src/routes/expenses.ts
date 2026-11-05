import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, can } from "./util.ts";

// Expenses modelled on the reference portal: a report (a folder for a period) holds items; each item is sent,
// then approved or refused on its own, then marked paid. Mileage items store a computed amount (km x rate)
// that the employee never sees: they only see the kilometres. Billable items become work to bill.
export const expenseRoutes = new Hono<Env>();
expenseRoutes.use("*", requirePermission("mytools.expenses.use", "mytools.expenses.approve", "mytools.timesheet.manage"));

class Fail extends Error { constructor(public status: number, public code: string) { super(code); } }
expenseRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code }, e.status as 400);
  throw e;
});

type Ctx = Context<Env>;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isApprover = (c: Ctx) => can(c, "mytools.expenses.approve");
const seesOthers = (c: Ctx) => can(c, "mytools.expenses.approve", "mytools.timesheet.manage");
const MAX_RECEIPT_B64 = 7_000_000; // about 5 MB of file

interface Item {
  id: string; report_id: string; user_id: string; spent_on: string; type_key: string; description: string; amount_cents: number; km: string | null;
  from_place: string; to_place: string; client_id: string | null; billable: boolean; receipt_name: string | null; status: string; reject_reason: string;
  client_name?: string | null; unit?: string; label_fr?: string; label_en?: string; has_receipt?: boolean;
}

/** An item as sent to the browser. The employee gets kilometres but no money for a trip. */
function shape(i: Item, money: boolean) {
  const trip = i.unit === "km";
  return {
    id: i.id, reportId: i.report_id, userId: i.user_id, spentOn: i.spent_on, typeKey: i.type_key, labelFr: i.label_fr, labelEn: i.label_en, unit: i.unit,
    description: i.description, amountCents: trip && !money ? null : i.amount_cents, km: i.km != null ? Number(i.km) : null, fromPlace: i.from_place, toPlace: i.to_place,
    clientId: i.client_id, clientName: i.client_name ?? null, billable: i.billable, hasReceipt: Boolean(i.has_receipt), receiptName: i.receipt_name,
    status: i.status, rejectReason: i.reject_reason,
  };
}

const ITEM_SQL = `select i.id, i.report_id, i.user_id, i.spent_on, i.type_key, i.description, i.amount_cents, i.km, i.from_place, i.to_place, i.client_id, i.billable,
    i.receipt_name, (i.receipt_b64 is not null) as has_receipt, i.status, i.reject_reason, cl.name as client_name, t.unit, t.label_fr, t.label_en
  from expense_items i join expense_types t on t.key = i.type_key left join clients cl on cl.id = i.client_id`;

async function reportFor(c: Ctx, id: string) {
  const r = (await pool.query("select * from expense_reports where id::text = $1", [id])).rows[0];
  if (!r) throw new Fail(404, "not_found");
  if (r.user_id !== auth(c).user.id && !seesOthers(c)) throw new Fail(404, "not_found");
  return r;
}

// ------------------------------------------------------------------ Types and favourites
expenseRoutes.get("/types", async (c) => {
  const r = await pool.query("select key, label_fr, label_en, unit, billable from expense_types where active order by position, key");
  // The per-km rate is accounting's: the employee never sees it.
  return c.json(camelRows(r));
});

const FavInput = z.object({
  label: z.string().min(1).max(80), typeKey: z.string().min(1), description: z.string().max(300).optional(), amount: z.number().min(0).max(100000).optional(),
  km: z.number().min(0).max(5000).nullable().optional(), fromPlace: z.string().max(120).optional(), toPlace: z.string().max(120).optional(), clientId: z.string().uuid().nullable().optional(), billable: z.boolean().optional(),
});

expenseRoutes.get("/favorites", async (c) => {
  const r = await pool.query(
    `select f.id, f.label, f.type_key, f.description, f.amount_cents, f.km, f.from_place, f.to_place, f.client_id, f.billable, t.unit
       from expense_favorites f join expense_types t on t.key = f.type_key where f.user_id = $1 order by lower(f.label)`, [auth(c).user.id]);
  return c.json(camelRows(r).map((x: any) => ({ ...x, amountCents: x.unit === "km" ? null : x.amountCents, km: x.km != null ? Number(x.km) : null })));
});

expenseRoutes.post("/favorites", async (c) => {
  const d = await body(c, FavInput);
  const n = Number((await pool.query("select count(*) as n from expense_favorites where user_id = $1", [auth(c).user.id])).rows[0].n);
  if (n >= 30) throw new Fail(409, "too_many_favorites");
  const r = await pool.query(
    `insert into expense_favorites (user_id, label, type_key, description, amount_cents, km, from_place, to_place, client_id, billable)
     values ($1,$2,$3,coalesce($4,''),$5,$6,coalesce($7,''),coalesce($8,''),$9,coalesce($10,false)) returning id`,
    [auth(c).user.id, d.label, d.typeKey, d.description, Math.round((d.amount ?? 0) * 100), d.km ?? null, d.fromPlace, d.toPlace, d.clientId ?? null, d.billable]);
  return c.json({ id: r.rows[0].id }, 201);
});

expenseRoutes.delete("/favorites/:id", async (c) => {
  await pool.query("delete from expense_favorites where id::text = $1 and user_id = $2", [c.req.param("id"), auth(c).user.id]);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Reports
function reportState(items: { status: string }[], submittedAt: unknown): "empty" | "open" | "sent" | "decided" | "paid" {
  if (!items.length) return "empty";
  if (items.every((i) => i.status === "paid")) return "paid";
  if (items.some((i) => i.status === "draft" || i.status === "refused") || !submittedAt) return "open";
  if (items.some((i) => i.status === "submitted")) return "sent";
  return "decided";
}

expenseRoutes.get("/reports", async (c) => {
  const me = auth(c).user.id;
  const who = c.req.query("userId") && c.req.query("userId") !== me ? (seesOthers(c) ? c.req.query("userId")! : me) : me;
  const money = who !== me && seesOthers(c);
  const r = await pool.query("select * from expense_reports where user_id = $1 order by period_end desc, created_at desc limit 200", [who]);
  const items = (await pool.query(`${ITEM_SQL} where i.user_id = $1`, [who])).rows as Item[];
  const rows = r.rows.map((rep) => {
    const its = items.filter((i) => i.report_id === rep.id);
    const state = reportState(its, rep.submitted_at);
    return {
      id: rep.id, title: rep.title, periodStart: rep.period_start, periodEnd: rep.period_end, submittedAt: rep.submitted_at, state, count: its.length,
      // Dollars exclude trips; kilometres are shown apart.
      totalCents: its.filter((i) => i.unit !== "km").reduce((a, i) => a + i.amount_cents, 0), totalKm: its.filter((i) => i.unit === "km").reduce((a, i) => a + Number(i.km ?? 0), 0),
      ...(money ? { moneyCents: its.reduce((a, i) => a + i.amount_cents, 0) } : {}),
    };
  });
  return c.json(c.req.query("status") === "all" ? rows : rows.filter((x) => x.state === "open" || x.state === "empty" || x.state === "sent"));
});

const ReportInput = z.object({ title: z.string().min(1).max(120), periodStart: Day, periodEnd: Day });

expenseRoutes.post("/reports", requirePermission("mytools.expenses.use"), async (c) => {
  const d = await body(c, ReportInput);
  if (d.periodEnd < d.periodStart) throw new Fail(400, "period_invalid");
  if ((Date.parse(d.periodEnd) - Date.parse(d.periodStart)) / 86_400_000 > 366) throw new Fail(400, "period_too_long");
  const r = await pool.query("insert into expense_reports (user_id, title, period_start, period_end) values ($1,$2,$3,$4) returning id", [auth(c).user.id, d.title, d.periodStart, d.periodEnd]);
  return c.json({ id: r.rows[0].id }, 201);
});

expenseRoutes.get("/reports/:id", async (c) => {
  const rep = await reportFor(c, c.req.param("id"));
  const money = rep.user_id !== auth(c).user.id && seesOthers(c);
  const items = (await pool.query(`${ITEM_SQL} where i.report_id = $1 order by i.spent_on, i.created_at`, [rep.id])).rows as Item[];
  const state = reportState(items, rep.submitted_at);
  return c.json({
    id: rep.id, title: rep.title, periodStart: rep.period_start, periodEnd: rep.period_end, submittedAt: rep.submitted_at, state, mine: rep.user_id === auth(c).user.id,
    editable: rep.user_id === auth(c).user.id && state !== "paid" && (!rep.submitted_at || items.some((i) => i.status === "draft" || i.status === "refused")),
    items: items.map((i) => shape(i, money)),
    totalCents: items.filter((i) => i.unit !== "km").reduce((a, i) => a + i.amount_cents, 0), totalKm: items.filter((i) => i.unit === "km").reduce((a, i) => a + Number(i.km ?? 0), 0),
  });
});

expenseRoutes.patch("/reports/:id", requirePermission("mytools.expenses.use"), async (c) => {
  const rep = await reportFor(c, c.req.param("id"));
  if (rep.user_id !== auth(c).user.id) throw new Fail(403, "forbidden");
  const d = await body(c, ReportInput.partial());
  const start = d.periodStart ?? rep.period_start, end = d.periodEnd ?? rep.period_end;
  if (end < start) throw new Fail(400, "period_invalid");
  const out = await pool.query("select 1 from expense_items where report_id = $1 and (spent_on < $2 or spent_on > $3) limit 1", [rep.id, start, end]);
  if (out.rowCount) throw new Fail(409, "report_period_items");
  await pool.query("update expense_reports set title = $2, period_start = $3, period_end = $4 where id = $1", [rep.id, d.title ?? rep.title, start, end]);
  return c.json({ ok: true });
});

expenseRoutes.delete("/reports/:id", async (c) => {
  const rep = await reportFor(c, c.req.param("id"));
  const mine = rep.user_id === auth(c).user.id;
  if (!mine && !can(c, "mytools.timesheet.manage")) throw new Fail(403, "forbidden");
  const items = (await pool.query("select status from expense_items where report_id = $1", [rep.id])).rows;
  if (mine && !can(c, "mytools.timesheet.manage") && rep.submitted_at) throw new Fail(409, "report_submitted");
  if (items.some((i) => i.status === "approved" || i.status === "paid")) {
    const billed = await pool.query("select 1 from billing_items b join expense_items i on i.id = b.source_id where b.source = 'expense' and i.report_id = $1 and b.status = 'invoiced'", [rep.id]);
    if (billed.rowCount) throw new Fail(409, "expense_billed");
    await pool.query("delete from billing_items where source = 'expense' and source_id in (select id from expense_items where report_id = $1)", [rep.id]);
  }
  await pool.query("delete from expense_reports where id = $1", [rep.id]);
  await audit("expense.report_deleted", { userId: auth(c).user.id, target: rep.id });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Items
const ItemInput = z.object({
  spentOn: Day, typeKey: z.string().min(1), description: z.string().max(500).optional(), amount: z.number().min(0).max(1_000_000).optional(),
  km: z.number().min(0.1).max(5000).optional(), fromPlace: z.string().max(120).optional(), toPlace: z.string().max(120).optional(),
  clientId: z.string().uuid().nullable().optional(), billable: z.boolean().optional(),
  receipt: z.object({ name: z.string().max(200), type: z.string().max(100), data: z.string().max(MAX_RECEIPT_B64) }).nullable().optional(),
});

const ALLOWED_RECEIPT = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;

async function priced(d: z.infer<typeof ItemInput>) {
  const t = (await pool.query("select unit, rate_cents from expense_types where key = $1 and active", [d.typeKey])).rows[0];
  if (!t) throw new Fail(400, "unknown_type");
  if (t.unit === "km") {
    if (!d.km) throw new Fail(400, "km_required");
    if (!d.fromPlace?.trim() || !d.toPlace?.trim()) throw new Fail(400, "mileage_places_required");
    return { amount_cents: Math.round(d.km * t.rate_cents), km: d.km, from_place: d.fromPlace.trim(), to_place: d.toPlace.trim(), description: d.description?.trim() || `${d.fromPlace.trim()} → ${d.toPlace.trim()}` };
  }
  if (!d.amount || d.amount <= 0) throw new Fail(400, "amount_required");
  return { amount_cents: Math.round(d.amount * 100), km: null, from_place: "", to_place: "", description: d.description ?? "" };
}

async function assertOpen(c: Ctx, rep: Record<string, any>) {
  if (rep.user_id !== auth(c).user.id) throw new Fail(403, "forbidden");
  const items = (await pool.query("select status from expense_items where report_id = $1", [rep.id])).rows;
  if (rep.submitted_at && !items.some((i) => i.status === "draft" || i.status === "refused")) throw new Fail(409, "report_submitted");
}

expenseRoutes.post("/reports/:id/items", requirePermission("mytools.expenses.use"), async (c) => {
  const rep = await reportFor(c, c.req.param("id"));
  await assertOpen(c, rep);
  const d = await body(c, ItemInput);
  if (d.spentOn < rep.period_start || d.spentOn > rep.period_end) throw new Fail(400, "expense_out_of_period");
  if (d.receipt && !ALLOWED_RECEIPT.test(d.receipt.type)) throw new Fail(400, "receipt_type");
  const p = await priced(d);
  if (d.billable && !d.clientId) throw new Fail(400, "client_required");
  const r = await pool.query(
    `insert into expense_items (report_id, user_id, spent_on, type_key, description, amount_cents, km, from_place, to_place, client_id, billable, receipt_name, receipt_type, receipt_b64)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [rep.id, rep.user_id, d.spentOn, d.typeKey, p.description, p.amount_cents, p.km, p.from_place, p.to_place, d.clientId ?? null, Boolean(d.billable), d.receipt?.name ?? null, d.receipt?.type ?? null, d.receipt?.data ?? null]);
  return c.json({ id: r.rows[0].id }, 201);
});

expenseRoutes.patch("/items/:id", requirePermission("mytools.expenses.use"), async (c) => {
  const cur = (await pool.query("select i.*, r.period_start, r.period_end, r.submitted_at, r.user_id as owner from expense_items i join expense_reports r on r.id = i.report_id where i.id::text = $1", [c.req.param("id")])).rows[0];
  if (!cur) throw new Fail(404, "not_found");
  const rep = { id: cur.report_id, user_id: cur.owner, submitted_at: cur.submitted_at };
  await assertOpen(c, rep);
  if (cur.status !== "draft" && cur.status !== "refused") throw new Fail(409, "item_locked");
  const d = await body(c, ItemInput.partial());
  const merged = {
    spentOn: d.spentOn ?? cur.spent_on, typeKey: cur.type_key, description: d.description ?? cur.description, amount: d.amount ?? (cur.amount_cents ? cur.amount_cents / 100 : undefined),
    km: d.km ?? (cur.km != null ? Number(cur.km) : undefined), fromPlace: d.fromPlace ?? cur.from_place, toPlace: d.toPlace ?? cur.to_place,
    clientId: d.clientId !== undefined ? d.clientId : cur.client_id, billable: d.billable ?? cur.billable,
  } as z.infer<typeof ItemInput>;
  if (merged.spentOn < cur.period_start || merged.spentOn > cur.period_end) throw new Fail(400, "expense_out_of_period");
  if (merged.billable && !merged.clientId) throw new Fail(400, "client_required");
  const p = await priced(merged);
  await pool.query(
    "update expense_items set spent_on=$2, description=$3, amount_cents=$4, km=$5, from_place=$6, to_place=$7, client_id=$8, billable=$9, status='draft', reject_reason='' where id=$1",
    [cur.id, merged.spentOn, p.description, p.amount_cents, p.km, p.from_place, p.to_place, merged.clientId ?? null, Boolean(merged.billable)]);
  if (d.receipt !== undefined) {
    if (d.receipt && !ALLOWED_RECEIPT.test(d.receipt.type)) throw new Fail(400, "receipt_type");
    await pool.query("update expense_items set receipt_name=$2, receipt_type=$3, receipt_b64=$4 where id=$1", [cur.id, d.receipt?.name ?? null, d.receipt?.type ?? null, d.receipt?.data ?? null]);
  }
  return c.json({ ok: true });
});

expenseRoutes.delete("/items/:id", async (c) => {
  const cur = (await pool.query("select i.id, i.status, r.user_id as owner, r.submitted_at, r.id as rid from expense_items i join expense_reports r on r.id = i.report_id where i.id::text = $1", [c.req.param("id")])).rows[0];
  if (!cur) return c.json({ ok: true });
  const manager = can(c, "mytools.timesheet.manage");
  if (!manager) { await assertOpen(c, { id: cur.rid, user_id: cur.owner, submitted_at: cur.submitted_at }); if (cur.status !== "draft" && cur.status !== "refused") throw new Fail(409, "item_locked"); }
  const billed = await pool.query("select 1 from billing_items where source = 'expense' and source_id = $1 and status = 'invoiced'", [cur.id]);
  if (billed.rowCount) throw new Fail(409, "expense_billed");
  await pool.query("delete from billing_items where source = 'expense' and source_id = $1", [cur.id]);
  await pool.query("delete from expense_items where id = $1", [cur.id]);
  return c.json({ ok: true });
});

expenseRoutes.get("/items/:id/receipt", async (c) => {
  const r = (await pool.query("select i.receipt_name, i.receipt_type, i.receipt_b64, i.user_id from expense_items i where i.id::text = $1", [c.req.param("id")])).rows[0];
  if (!r?.receipt_b64 || (r.user_id !== auth(c).user.id && !seesOthers(c))) return c.json({ error: "not found" }, 404);
  const type = ALLOWED_RECEIPT.test(r.receipt_type ?? "") ? r.receipt_type : "application/octet-stream";
  return new Response(Buffer.from(r.receipt_b64, "base64"), { headers: { "content-type": type, "x-content-type-options": "nosniff", "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(r.receipt_name ?? "receipt")}` } });
});

expenseRoutes.post("/reports/:id/submit", requirePermission("mytools.expenses.use"), async (c) => {
  const rep = await reportFor(c, c.req.param("id"));
  if (rep.user_id !== auth(c).user.id) throw new Fail(403, "forbidden");
  const r = await pool.query("update expense_items set status = 'submitted', reject_reason = '' where report_id = $1 and status in ('draft','refused') returning id", [rep.id]);
  if (!r.rowCount) throw new Fail(409, "nothing_to_submit");
  await pool.query("update expense_reports set submitted_at = now() where id = $1", [rep.id]);
  return c.json({ submitted: r.rowCount });
});

// ------------------------------------------------------------------ Approval and payment
expenseRoutes.get("/approvals", requirePermission("mytools.expenses.approve"), async (c) => {
  const status = c.req.query("status") === "approved" ? "approved" : "submitted";
  const r = await pool.query(`${ITEM_SQL} where i.status = $1 order by i.user_id, i.report_id, i.spent_on limit 1000`, [status]);
  const reps = (await pool.query("select r.id, r.title, r.user_id, u.name as user_name from expense_reports r join users u on u.id = r.user_id where r.id = any($1::uuid[])", [[...new Set((r.rows as Item[]).map((i) => i.report_id))]])).rows;
  return c.json(reps.map((rep) => ({
    reportId: rep.id, title: rep.title, userId: rep.user_id, userName: rep.user_name,
    items: (r.rows as Item[]).filter((i) => i.report_id === rep.id).map((i) => shape(i, true)),
  })));
});

expenseRoutes.post("/approvals/decision", requirePermission("mytools.expenses.approve"), async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().uuid()).min(1).max(200), decision: z.enum(["approve", "refuse"]), reason: z.string().max(300).optional() }));
  if (d.decision === "refuse" && !d.reason?.trim()) throw new Fail(400, "reason_required");
  const items = (await pool.query("select * from expense_items where id = any($1::uuid[]) and status = 'submitted'", [d.ids])).rows;
  if (items.some((i) => i.user_id === auth(c).user.id)) throw new Fail(403, "own_expense");
  for (const i of items) {
    await pool.query("update expense_items set status = $2, decided_by = $3, decided_at = now(), reject_reason = $4 where id = $1", [i.id, d.decision === "approve" ? "approved" : "refused", auth(c).user.id, d.decision === "refuse" ? d.reason : ""]);
    if (d.decision === "refuse") await pool.query("update expense_reports set submitted_at = null where id = $1", [i.report_id]); // reopens the report
    if (d.decision === "approve" && i.billable && i.client_id) {
      await pool.query(
        `insert into billing_items (client_id, source, source_id, description, quantity, unit_price, work_date, created_by) values ($1,'expense',$2,$3,1,$4,$5,$6) on conflict do nothing`,
        [i.client_id, i.id, i.description || "Dépense", Math.round(i.amount_cents) / 100, i.spent_on, i.user_id]);
    }
  }
  await audit(`expense.${d.decision}`, { userId: auth(c).user.id, target: `${items.length} item(s)` });
  return c.json({ done: items.length });
});

expenseRoutes.post("/approvals/paid", requirePermission("mytools.expenses.approve"), async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().uuid()).min(1).max(500), paid: z.boolean() }));
  if (d.paid) await pool.query("update expense_items set status = 'paid', paid_at = now() where id = any($1::uuid[]) and status = 'approved'", [d.ids]);
  else await pool.query("update expense_items set status = 'approved', paid_at = null where id = any($1::uuid[]) and status = 'paid'", [d.ids]);
  return c.json({ ok: true });
});
