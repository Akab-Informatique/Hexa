import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { addDays, mondayOf, todayISO } from "@hexa/shared/billing";
import { accruablePaidMinutes, centsOf, holidayBasisMinutes, holidayPayCents, paidMinutes, VACATION_ACCRUAL, workdayMinutes, type PayEntry, type TimeKind } from "@hexa/shared/workday";
import { pool, getSetting } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { applyAutoApprove } from "../lib/autoApprove.ts";
import { auth, body, camelRows, can } from "./util.ts";

// Timesheets modelled on the reference portal: typed entries, a work day with lunch rules, an hours bank,
// weekly sending and approval. Employees only ever see hours: money (wage, bank in $, accrual) stays with
// HR and the approvers. Rows that move money are kept in hr_ledger (see routes/hr.ts).
export const timeRoutes = new Hono<Env>();
timeRoutes.use("*", requirePermission("mytools.timesheet.use", "mytools.timesheet.approve", "mytools.timesheet.manage"));

class Fail extends Error { constructor(public status: number, public code: string) { super(code); } }
timeRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code }, e.status as 400);
  throw e;
});

type Ctx = Context<Env>;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Clock = z.string().regex(/^\d{1,2}:\d{2}$/);
const isManager = (c: Ctx) => can(c, "mytools.timesheet.manage");
const isApprover = (c: Ctx) => can(c, "mytools.timesheet.approve", "mytools.timesheet.manage");
const seesMoney = (c: Ctx) => can(c, "mytools.timesheet.approve", "mytools.timesheet.manage", "hr.manage");

interface Entry {
  id: string; user_id: string; work_date: string; type_key: string; kind: TimeKind; minutes: number; start_time: string | null; end_time: string | null;
  lunch_minutes: number; bank_minutes: number; amount_cents: number | null; client_id: string | null; client_name: string | null; task_id: string | null;
  task_title: string | null; description: string; billable: boolean; billable_minutes: number | null; status: string;
}

/** Whose timesheet a request is about: mine, or (managers and approvers) someone else's. */
function target(c: Ctx, userId?: string | null): string {
  const me = auth(c).user.id;
  if (!userId || userId === me) return me;
  if (!isApprover(c)) throw new Fail(403, "forbidden");
  return userId;
}

async function wageOf(userId: string): Promise<{ cents: number | null; overtime: number }> {
  const r = (await pool.query("select hourly_wage, overtime_hours from hr_profiles where user_id = $1", [userId])).rows[0];
  return { cents: r?.hourly_wage != null ? Math.round(Number(r.hourly_wage) * 100) : null, overtime: Number(r?.overtime_hours ?? 40) };
}

async function weekRow(userId: string, start: string) {
  const r = (await pool.query("select * from timesheet_weeks where user_id = $1 and week_start = $2", [userId, start])).rows[0];
  return { status: (r?.status ?? "draft") as "draft" | "submitted" | "approved" | "rejected" | "paid", rejectReason: (r?.reject_reason ?? "") as string, submittedAt: r?.submitted_at ?? null };
}

async function weekEntries(userId: string, start: string): Promise<Entry[]> {
  const r = await pool.query(
    `select e.*, t.kind, cl.name as client_name, k.title as task_title from timesheet_entries e
       join time_types t on t.key = e.type_key left join clients cl on cl.id = e.client_id left join tasks k on k.id = e.task_id
      where e.user_id = $1 and e.work_date between $2 and $3 order by e.work_date, e.start_time nulls last, e.created_at`, [userId, start, addDays(start, 6)]);
  return r.rows as Entry[];
}

const asPay = (e: Entry): PayEntry => ({ kind: e.kind, minutes: e.minutes, bankMinutes: e.bank_minutes });

function totals(entries: Entry[]) {
  const byType: Record<string, number> = {};
  for (const e of entries) byType[e.type_key] = (byType[e.type_key] ?? 0) + e.minutes;
  return {
    paidMinutes: paidMinutes(entries.map(asPay)),
    workdayMinutes: entries.filter((e) => e.kind === "workday").reduce((a, e) => a + e.minutes, 0),
    bankedMinutes: entries.filter((e) => e.kind === "workday").reduce((a, e) => a + e.bank_minutes, 0),
    clientMinutes: entries.filter((e) => e.kind === "work").reduce((a, e) => a + e.minutes, 0),
    billableMinutes: entries.filter((e) => e.kind === "work" && e.billable).reduce((a, e) => a + (e.billable_minutes ?? e.minutes), 0),
    byType,
  };
}

/** Employees never get money fields back. */
const publicEntry = (e: Entry) => ({
  id: e.id, workDate: e.work_date, typeKey: e.type_key, kind: e.kind, minutes: e.minutes, startTime: e.start_time, endTime: e.end_time, lunchMinutes: e.lunch_minutes,
  bankMinutes: e.bank_minutes, clientId: e.client_id, clientName: e.client_name, taskId: e.task_id, taskTitle: e.task_title, description: e.description,
  billable: e.billable, billableMinutes: e.billable_minutes, status: e.status,
});

// ------------------------------------------------------------------ Ledger and accrual
async function needWage(userId: string): Promise<number> {
  const w = (await wageOf(userId)).cents;
  if (w == null || w <= 0) throw new Fail(409, "hr_wage_missing");
  return w;
}

/** Rebuilds the ledger rows of one entry (bank in, bank out, vacation taken, sick taken). Returns accounts that went below zero. */
async function applyLedger(e: { id: string; user_id: string; kind: TimeKind; minutes: number; bank_minutes: number; work_date: string }, by: string): Promise<string[]> {
  await pool.query("delete from hr_ledger where entry_id = $1", [e.id]);
  const rows: { account: string; delta: number; reason: string }[] = [];
  if (e.kind === "workday" && e.bank_minutes > 0) rows.push({ account: "bank", delta: centsOf(e.bank_minutes, await needWage(e.user_id)), reason: "bank in" });
  else if (e.kind === "bankpay") rows.push({ account: "bank", delta: -centsOf(e.minutes, await needWage(e.user_id)), reason: "bank payout" });
  else if (e.kind === "vacation") rows.push({ account: "vacation", delta: -centsOf(e.minutes, await needWage(e.user_id)), reason: "vacation taken" });
  else if (e.kind === "sick") rows.push({ account: "sick", delta: -Math.round((e.minutes / 60) * 100), reason: "sick taken" });
  for (const r of rows) await pool.query("insert into hr_ledger (user_id, account, delta, kind, reason, entry_id, created_by) values ($1,$2,$3,'entry',$4,$5,$6)", [e.user_id, r.account, r.delta, `${r.reason} ${e.work_date}`, e.id, by]);
  const negative: string[] = [];
  for (const acct of new Set(rows.map((r) => r.account))) {
    const bal = Number((await pool.query("select coalesce(sum(delta),0) as b from hr_ledger where user_id = $1 and account = $2", [e.user_id, acct])).rows[0].b);
    if (bal < 0) negative.push(acct);
  }
  return negative;
}

/** 4 % of the gross pay of a sent week goes to the vacation bank; one row per week, redone when the week changes. */
async function refreshAccrual(userId: string, start: string): Promise<void> {
  await pool.query("delete from hr_ledger where user_id = $1 and week_start = $2 and kind = 'accrual'", [userId, start]);
  const wk = await weekRow(userId, start);
  if (wk.status === "draft" || wk.status === "rejected") return;
  const wage = (await wageOf(userId)).cents;
  if (!wage) return;
  const minutes = accruablePaidMinutes((await weekEntries(userId, start)).map(asPay));
  const cents = Math.round(centsOf(minutes, wage) * VACATION_ACCRUAL);
  if (cents > 0) await pool.query("insert into hr_ledger (user_id, account, delta, kind, reason, week_start) values ($1,'vacation',$2,'accrual',$3,$4)", [userId, cents, `4 % ${start}`, start]);
}

async function holidayFor(userId: string, date: string): Promise<{ cents: number; minutes: number; wage: number }> {
  const wage = await needWage(userId);
  const { overtime } = await wageOf(userId);
  const thisWeek = mondayOf(date);
  const basis: number[] = [];
  for (let k = 1; k <= 4; k++) basis.push(holidayBasisMinutes((await weekEntries(userId, addDays(thisWeek, -7 * k))).map(asPay), overtime));
  const cents = holidayPayCents(basis, wage);
  if (cents <= 0) throw new Fail(409, "holiday_no_basis");
  return { cents, minutes: Math.max(1, Math.round((cents / wage) * 60)), wage };
}

// ------------------------------------------------------------------ Reads
timeRoutes.get("/types", async (c) => {
  const r = await pool.query("select key, kind, label_fr, label_en from time_types where active order by position, key");
  return c.json(camelRows(r));
});

timeRoutes.get("/people", async (c) => {
  if (!isApprover(c)) return c.json([]);
  const r = await pool.query("select id, name from users where kind = 'staff' and active order by lower(name)");
  return c.json(r.rows);
});

timeRoutes.get("/week", async (c) => {
  const userId = target(c, c.req.query("userId"));
  const q = c.req.query("start");
  const start = mondayOf(q && Day.safeParse(q).success ? q : todayISO());
  const [entries, wk] = await Promise.all([weekEntries(userId, start), weekRow(userId, start)]);
  const mine = userId === auth(c).user.id;
  const locked = !isManager(c) && !(wk.status === "draft" || wk.status === "rejected");
  return c.json({
    start, userId, mine, status: wk.status, rejectReason: wk.rejectReason, locked,
    entries: entries.map(publicEntry), totals: totals(entries),
  });
});

/** Money view for accounting and approvers (never for the employee's own copy). */
timeRoutes.get("/week/accounting", async (c) => {
  if (!seesMoney(c)) return c.json({ error: "forbidden" }, 403);
  const userId = target(c, c.req.query("userId") ?? auth(c).user.id);
  if (userId === auth(c).user.id && !isManager(c)) return c.json({ error: "forbidden" }, 403);
  const start = mondayOf(c.req.query("start") ?? todayISO());
  const entries = await weekEntries(userId, start);
  const { cents: wage } = await wageOf(userId);
  const paid = paidMinutes(entries.map(asPay));
  const accr = (await pool.query("select coalesce(sum(delta),0) as d from hr_ledger where user_id = $1 and week_start = $2 and kind = 'accrual'", [userId, start])).rows[0].d;
  const bal = await balancesOf(userId);
  return c.json({ start, userId, wageCents: wage, paidMinutes: paid, grossCents: wage ? centsOf(paid, wage) : null, accrualCents: Number(accr), balances: bal, totals: totals(entries), entries: entries.map(publicEntry) });
});

export async function balancesOf(userId: string) {
  const r = await pool.query("select account, coalesce(sum(delta),0) as b from hr_ledger where user_id = $1 group by account", [userId]);
  const m: Record<string, number> = { bank: 0, vacation: 0, sick: 0 };
  for (const x of r.rows) m[x.account] = Number(x.b);
  return { bankCents: m.bank!, vacationCents: m.vacation!, sickHundredths: m.sick! };
}

// ------------------------------------------------------------------ Writes
const EntryInput = z.object({
  userId: z.string().uuid().optional(), workDate: Day, typeKey: z.string().min(1).max(40),
  minutes: z.number().int().min(1).max(1440).optional(), start: Clock.optional(), end: Clock.optional(), bankMinutes: z.number().int().min(0).max(1440).optional(),
  clientId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(), description: z.string().max(1000).optional(),
  billable: z.boolean().optional(), billableMinutes: z.number().int().min(0).max(1440).nullable().optional(),
});

/** Who may add, change or remove in a week: the owner until it is sent; a manager any time. */
async function assertEditable(c: Ctx, userId: string, start: string) {
  if (isManager(c)) return;
  if (userId !== auth(c).user.id) throw new Fail(403, "forbidden");
  const wk = await weekRow(userId, start);
  if (wk.status !== "draft" && wk.status !== "rejected") throw new Fail(409, "timesheet_locked");
}

type Built = { type_key: string; kind: TimeKind; minutes: number; start_time: string | null; end_time: string | null; lunch_minutes: number; bank_minutes: number; amount_cents: number | null; client_id: string | null; task_id: string | null; description: string; billable: boolean; billable_minutes: number | null };

async function build(d: z.infer<typeof EntryInput>, userId: string, existingId?: string): Promise<Built> {
  const t = (await pool.query("select kind from time_types where key = $1 and active", [d.typeKey])).rows[0];
  if (!t) throw new Fail(400, "unknown_type");
  const kind = t.kind as TimeKind;
  const base = { type_key: d.typeKey, kind, start_time: null as string | null, end_time: null as string | null, lunch_minutes: 0, bank_minutes: 0, amount_cents: null as number | null,
    client_id: d.clientId ?? null, task_id: d.taskId ?? null, description: d.description ?? "", billable: false, billable_minutes: null as number | null };
  if (kind === "workday") {
    if (!d.start || !d.end) throw new Fail(400, "workday_times_required");
    const w = workdayMinutes(d.start, d.end);
    if (!w) throw new Fail(400, "workday_times_invalid");
    const dup = await pool.query("select 1 from timesheet_entries e join time_types t on t.key = e.type_key where e.user_id = $1 and e.work_date = $2 and t.kind = 'workday' and ($3::uuid is null or e.id <> $3)", [userId, d.workDate, existingId ?? null]);
    if (dup.rowCount) throw new Fail(409, "workday_exists");
    const bank = d.bankMinutes ?? 0;
    if (bank > w.paid) throw new Fail(400, "bank_exceeds_day");
    return { ...base, minutes: w.paid, start_time: d.start, end_time: d.end, lunch_minutes: w.lunchTaken, bank_minutes: bank, client_id: null, task_id: null };
  }
  if (kind === "holiday") {
    const h = await holidayFor(userId, d.workDate);
    return { ...base, minutes: h.minutes, amount_cents: h.cents, client_id: null, task_id: null };
  }
  if (!d.minutes) throw new Fail(400, "minutes_required");
  if (kind === "work") {
    const billable = d.billable ?? true;
    if (d.billableMinutes != null && d.billableMinutes > d.minutes * 3) throw new Fail(400, "billable_too_high");
    return { ...base, minutes: d.minutes, billable, billable_minutes: billable ? d.billableMinutes ?? null : null };
  }
  if (kind === "travel") {
    if (d.billable && !d.clientId) throw new Fail(400, "travel_client_required");
    return { ...base, minutes: d.minutes, billable: Boolean(d.billable) };
  }
  return { ...base, minutes: d.minutes, client_id: null, task_id: null };
}

async function afterChange(userId: string, start: string, by: string) {
  const wk = await weekRow(userId, start);
  if (wk.status !== "draft" && wk.status !== "rejected") await refreshAccrual(userId, start);
  void by;
}

timeRoutes.post("/entries", async (c) => {
  const d = await body(c, EntryInput);
  const userId = target(c, d.userId);
  const start = mondayOf(d.workDate);
  await assertEditable(c, userId, start);
  const b = await build(d, userId);
  const r = await pool.query(
    `insert into timesheet_entries (user_id, work_date, type_key, minutes, start_time, end_time, lunch_minutes, bank_minutes, amount_cents, client_id, task_id, description, billable, billable_minutes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [userId, d.workDate, b.type_key, b.minutes, b.start_time, b.end_time, b.lunch_minutes, b.bank_minutes, b.amount_cents, b.client_id, b.task_id, b.description, b.billable, b.billable_minutes]);
  const id = r.rows[0].id as string;
  let negative: string[] = [];
  try { negative = await applyLedger({ id, user_id: userId, kind: b.kind, minutes: b.minutes, bank_minutes: b.bank_minutes, work_date: d.workDate }, auth(c).user.id); }
  catch (e) { await pool.query("delete from timesheet_entries where id = $1", [id]); throw e; }
  await afterChange(userId, start, auth(c).user.id);
  if (userId !== auth(c).user.id) await audit("timesheet.entry_added_for", { userId: auth(c).user.id, target: userId });
  return c.json({ id, negative }, 201);
});

timeRoutes.patch("/entries/:id", async (c) => {
  const cur = (await pool.query("select e.*, t.kind from timesheet_entries e join time_types t on t.key = e.type_key where e.id = $1", [c.req.param("id")])).rows[0];
  if (!cur) return c.json({ error: "not found" }, 404);
  const d = await body(c, EntryInput.partial().omit({ userId: true }));
  const start = mondayOf(cur.work_date);
  await assertEditable(c, cur.user_id, start);
  const merged = {
    workDate: d.workDate ?? cur.work_date, typeKey: cur.type_key, minutes: d.minutes ?? (cur.kind === "workday" || cur.kind === "holiday" ? undefined : cur.minutes),
    start: d.start ?? cur.start_time ?? undefined, end: d.end ?? cur.end_time ?? undefined, bankMinutes: d.bankMinutes ?? cur.bank_minutes,
    clientId: d.clientId !== undefined ? d.clientId : cur.client_id, taskId: d.taskId !== undefined ? d.taskId : cur.task_id, description: d.description ?? cur.description,
    billable: d.billable ?? cur.billable, billableMinutes: d.billableMinutes !== undefined ? d.billableMinutes : cur.billable_minutes,
  } as z.infer<typeof EntryInput>;
  if (mondayOf(merged.workDate) !== start) throw new Fail(400, "cannot_move_week");
  const b = await build(merged, cur.user_id, cur.id);
  await pool.query(
    `update timesheet_entries set work_date=$2, minutes=$3, start_time=$4, end_time=$5, lunch_minutes=$6, bank_minutes=$7, amount_cents=$8, client_id=$9, task_id=$10, description=$11, billable=$12, billable_minutes=$13 where id=$1`,
    [cur.id, merged.workDate, b.minutes, b.start_time, b.end_time, b.lunch_minutes, b.bank_minutes, b.amount_cents, b.client_id, b.task_id, b.description, b.billable, b.billable_minutes]);
  const negative = await applyLedger({ id: cur.id, user_id: cur.user_id, kind: b.kind, minutes: b.minutes, bank_minutes: b.bank_minutes, work_date: merged.workDate }, auth(c).user.id);
  await afterChange(cur.user_id, start, auth(c).user.id);
  return c.json({ ok: true, negative });
});

timeRoutes.delete("/entries/:id", async (c) => {
  const cur = (await pool.query("select user_id, work_date from timesheet_entries where id = $1", [c.req.param("id")])).rows[0];
  if (!cur) return c.json({ ok: true });
  const start = mondayOf(cur.work_date);
  await assertEditable(c, cur.user_id, start);
  const used = (await pool.query("select 1 from billing_items where source = 'time' and source_id = $1 and status = 'invoiced'", [c.req.param("id")])).rowCount;
  if (used) throw new Fail(409, "entry_invoiced");
  await pool.query("delete from timesheet_entries where id = $1", [c.req.param("id")]); // ledger rows go with it (cascade)
  await afterChange(cur.user_id, start, auth(c).user.id);
  if (cur.user_id !== auth(c).user.id) await audit("timesheet.entry_removed_for", { userId: auth(c).user.id, target: cur.user_id });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Sending and approval
async function handOffToBilling(userId: string, start: string) {
  const rows = (await weekEntries(userId, start)).filter((e) => e.kind === "work" && e.billable && e.client_id);
  for (const e of rows) {
    const rate = (await pool.query("select hourly_rate from client_contracts where client_id = $1 and kind = 'hourly' and status = 'active' and hourly_rate is not null order by created_at desc limit 1", [e.client_id])).rows[0]?.hourly_rate ?? 0;
    await pool.query(
      `insert into billing_items (client_id, source, source_id, description, quantity, unit_price, work_date, created_by)
       values ($1,'time',$2,$3,$4,$5,$6,$7) on conflict do nothing`,
      [e.client_id, e.id, e.description || e.task_title || "Temps de travail", Math.round((((e.billable_minutes ?? e.minutes) / 60)) * 100) / 100, rate, e.work_date, userId]);
  }
  for (const clientId of new Set(rows.map((e) => e.client_id!))) await applyAutoApprove(clientId);
}

async function setWeek(userId: string, start: string, status: string, fields: { by?: string | null; reason?: string; submit?: boolean; paid?: boolean } = {}) {
  await pool.query(
    `insert into timesheet_weeks (user_id, week_start, status, submitted_at, decided_by, decided_at, reject_reason, paid_at)
     values ($1,$2,$3, case when $4 then now() end, $5, case when $5::uuid is not null then now() end, coalesce($6,''), case when $7 then now() end)
     on conflict (user_id, week_start) do update set status = excluded.status,
       submitted_at = case when $4 then now() else timesheet_weeks.submitted_at end,
       decided_by = case when $5::uuid is not null then $5 else timesheet_weeks.decided_by end,
       decided_at = case when $5::uuid is not null then now() else timesheet_weeks.decided_at end,
       reject_reason = case when $3 = 'rejected' then coalesce($6,'') else '' end,
       paid_at = case when $7 then now() when $3 = 'paid' then timesheet_weeks.paid_at else null end`,
    [userId, start, status, Boolean(fields.submit), fields.by ?? null, fields.reason ?? "", Boolean(fields.paid)]);
  await pool.query("update timesheet_entries set status = $3 where user_id = $1 and work_date between $2 and $4", [userId, start, status === "paid" ? "approved" : status === "rejected" ? "rejected" : status, addDays(start, 6)]);
}

timeRoutes.post("/week/submit", async (c) => {
  const d = await body(c, z.object({ start: Day, userId: z.string().uuid().optional() }));
  const userId = target(c, d.userId);
  const start = mondayOf(d.start);
  await assertEditable(c, userId, start);
  const entries = await weekEntries(userId, start);
  if (!entries.length) throw new Fail(409, "week_empty");
  const auto = (await getSetting<boolean>("time.autoApprove")) === true;
  await setWeek(userId, start, auto ? "approved" : "submitted", { submit: true, by: auto ? null : null });
  if (auto) await handOffToBilling(userId, start);
  await refreshAccrual(userId, start);
  return c.json({ status: auto ? "approved" : "submitted" });
});

timeRoutes.get("/approvals", requirePermission("mytools.timesheet.approve", "mytools.timesheet.manage"), async (c) => {
  const status = c.req.query("status") === "approved" ? ["approved"] : c.req.query("status") === "all" ? ["submitted", "approved", "paid"] : ["submitted"];
  const w = await pool.query(
    `select w.user_id, w.week_start, w.status, w.submitted_at, u.name as user_name from timesheet_weeks w join users u on u.id = w.user_id
      where w.status = any($1) order by w.week_start desc, lower(u.name) limit 300`, [status]);
  const out = [];
  for (const row of w.rows) {
    const t = totals(await weekEntries(row.user_id, row.week_start));
    out.push({ userId: row.user_id, userName: row.user_name, weekStart: row.week_start, status: row.status, submittedAt: row.submitted_at, paidMinutes: t.paidMinutes, workdayMinutes: t.workdayMinutes, clientMinutes: t.clientMinutes, billableMinutes: t.billableMinutes });
  }
  return c.json(out);
});

timeRoutes.post("/approvals/decision", requirePermission("mytools.timesheet.approve", "mytools.timesheet.manage"), async (c) => {
  const d = await body(c, z.object({ userId: z.string().uuid(), start: Day, decision: z.enum(["approve", "reject"]), reason: z.string().max(300).optional() }));
  if (d.userId === auth(c).user.id) throw new Fail(403, "own_time");
  const start = mondayOf(d.start);
  const wk = await weekRow(d.userId, start);
  if (wk.status !== "submitted") throw new Fail(409, "not_submitted");
  if (d.decision === "reject" && !d.reason?.trim()) throw new Fail(400, "reason_required");
  await setWeek(d.userId, start, d.decision === "approve" ? "approved" : "rejected", { by: auth(c).user.id, reason: d.reason });
  if (d.decision === "approve") await handOffToBilling(d.userId, start);
  await refreshAccrual(d.userId, start);
  await audit(`timesheet.${d.decision}`, { userId: auth(c).user.id, target: `${d.userId} ${start}` });
  return c.json({ ok: true });
});

timeRoutes.post("/approvals/paid", requirePermission("mytools.timesheet.approve", "mytools.timesheet.manage", "hr.manage"), async (c) => {
  const d = await body(c, z.object({ items: z.array(z.object({ userId: z.string().uuid(), start: Day })).min(1).max(200), paid: z.boolean() }));
  for (const it of d.items) {
    const wk = await weekRow(it.userId, mondayOf(it.start));
    if (d.paid && wk.status === "approved") await setWeek(it.userId, mondayOf(it.start), "paid", { by: auth(c).user.id, paid: true });
    if (!d.paid && wk.status === "paid") await setWeek(it.userId, mondayOf(it.start), "approved", { by: auth(c).user.id });
  }
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Report (hours only)
timeRoutes.get("/report", async (c) => {
  const userId = target(c, c.req.query("userId"));
  const from = Day.safeParse(c.req.query("from")).success ? c.req.query("from")! : addDays(mondayOf(todayISO()), -28);
  const to = Day.safeParse(c.req.query("to")).success ? c.req.query("to")! : todayISO();
  const r = await pool.query(
    `select e.*, t.kind, cl.name as client_name from timesheet_entries e join time_types t on t.key = e.type_key left join clients cl on cl.id = e.client_id
      where e.user_id = $1 and e.work_date between $2 and $3`, [userId, from, to]);
  const entries = r.rows as Entry[];
  const byClient = new Map<string, { clientId: string | null; name: string; minutes: number; billableMinutes: number }>();
  for (const e of entries.filter((x) => x.kind === "work")) {
    const k = e.client_id ?? "none";
    const row = byClient.get(k) ?? { clientId: e.client_id, name: e.client_name ?? "—", minutes: 0, billableMinutes: 0 };
    row.minutes += e.minutes;
    if (e.billable) row.billableMinutes += e.billable_minutes ?? e.minutes;
    byClient.set(k, row);
  }
  const t = totals(entries);
  // Productivity: billable hours over work-day hours (may pass 100 %).
  return c.json({ from, to, userId, ...t, productivityPct: t.workdayMinutes ? Math.round((t.billableMinutes / t.workdayMinutes) * 100) : null, byClient: [...byClient.values()].sort((a, b) => b.minutes - a.minutes) });
});
