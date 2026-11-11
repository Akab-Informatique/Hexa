import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { addDays, mondayOf, todayISO } from "@hexa/shared/billing";
import { accruablePaidMinutes, centsOf, holidayBasisMinutes, holidayPayCents, paidMinutes, VACATION_ACCRUAL, workdayMinutes, type PayEntry, type TimeKind } from "@hexa/shared/workday";
import { pool, getSetting, setSetting } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { applyAutoApprove } from "../lib/autoApprove.ts";
import { DAY_CAP_MINUTES, DEFAULT_PAY, fitsDayCap, hoursOf, isRealDate, normalizePayConfig, payPeriodOf, toCsv } from "../lib/timesheetPayroll.ts";
import { quebecToday } from "../lib/quebecDate.ts";
import { auth, body, camelRows, can, isUuid } from "./util.ts";

// Timesheets modelled on the reference portal: typed entries, a work day with lunch rules, an hours bank,
// weekly sending and approval. Employees only ever see hours: money (wage, bank in $, accrual) stays with
// HR and the approvers. Rows that move money are kept in hr_ledger (see routes/hr.ts).
export const timeRoutes = new Hono<Env>();
timeRoutes.use("*", requirePermission("mytools.timesheet.use", "mytools.timesheet.approve", "mytools.timesheet.manage"));

export class Fail extends Error { constructor(public status: number, public code: string) { super(code); } }
timeRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code }, e.status as 400);
  throw e;
});

type Ctx = Context<Env>;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "invalid date");
const Clock = z.string().regex(/^\d{1,2}:\d{2}$/);
const isManager = (c: Ctx) => can(c, "mytools.timesheet.manage");
const isApprover = (c: Ctx) => can(c, "mytools.timesheet.approve", "mytools.timesheet.manage");
const seesMoney = (c: Ctx) => can(c, "mytools.timesheet.approve", "mytools.timesheet.manage", "hr.manage");

interface Entry {
  id: string; user_id: string; work_date: string; type_key: string; kind: TimeKind; minutes: number; start_time: string | null; end_time: string | null;
  lunch_minutes: number; bank_minutes: number; amount_cents: number | null; client_id: string | null; client_name: string | null; task_id: string | null;
  task_title: string | null; description: string; billable: boolean; billable_minutes: number | null; status: string;
  source: "timer" | "manual"; measured_minutes: number | null; origin_date: string | null;
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
  billable: e.billable, billableMinutes: e.billable_minutes, status: e.status, source: e.source, measuredMinutes: e.measured_minutes, originDate: e.origin_date,
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
  // Nobody edits another person's entries, and a sent or approved week is locked for everyone (managers reopen it explicitly).
  const locked = !mine || !(wk.status === "draft" || wk.status === "rejected");
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
export const EntryInput = z.object({
  userId: z.string().uuid().optional(), workDate: Day, typeKey: z.string().min(1).max(40),
  minutes: z.number().int().min(1).max(1440).optional(), start: Clock.optional(), end: Clock.optional(), bankMinutes: z.number().int().min(0).max(1440).optional(),
  clientId: z.string().uuid().nullable().optional(), taskId: z.string().uuid().nullable().optional(), description: z.string().max(1000).optional(),
  billable: z.boolean().optional(), billableMinutes: z.number().int().min(0).max(1440).nullable().optional(),
});

/**
 * Who may add, change or remove in a week: only the owner, and only while the week is draft or rejected.
 * A sent or approved week is locked for everyone, managers included: they reopen it through POST /week/reopen (audited).
 */
async function assertEditable(c: Ctx, userId: string, start: string) {
  if (userId !== auth(c).user.id) throw new Fail(403, "forbidden");
  const wk = await weekRow(userId, start);
  if (wk.status !== "draft" && wk.status !== "rejected") throw new Fail(409, "timesheet_locked");
}

/** One person never has more than 24 h on a day (all entries counted). Race between two simultaneous requests is not locked. */
export async function assertDayCap(userId: string, date: string, add: number, exceptId?: string) {
  const r = await pool.query("select coalesce(sum(minutes),0)::int as m from timesheet_entries where user_id = $1 and work_date = $2 and ($3::uuid is null or id <> $3)", [userId, date, exceptId ?? null]);
  if (!fitsDayCap(Number(r.rows[0].m), add, DAY_CAP_MINUTES)) throw new Fail(409, "day_total_exceeded");
}

/** Audit trail of an entry: a history row (full before/after copy) plus an audit_log line. */
export async function recordEntry(action: "create" | "update" | "delete" | "reopen", actor: string, entryId: string, ownerId: string, before: unknown, after: unknown) {
  await pool.query("insert into timesheet_entry_history (entry_id, user_id, actor_id, action, before, after) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
    [entryId, ownerId, actor, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)]);
  await audit(`timesheet.entry_${action}`, { userId: actor, target: entryId, detail: { owner: ownerId } });
}

export const snap = (e: Record<string, unknown>) => ({ workDate: e.work_date, typeKey: e.type_key, minutes: e.minutes, clientId: e.client_id, taskId: e.task_id, description: e.description, billable: e.billable, billableMinutes: e.billable_minutes, status: e.status, source: e.source });

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

/** Adds one entry to a timesheet (also used by the task timer). */
export async function addEntry(c: Ctx, d: z.infer<typeof EntryInput>): Promise<{ id: string; negative: string[] }> {
  const me = auth(c).user.id;
  if (d.userId && d.userId !== me) throw new Fail(403, "forbidden"); // nobody adds time on someone else's sheet
  const userId = me;
  const start = mondayOf(d.workDate);
  await assertEditable(c, userId, start);
  const b = await build(d, userId);
  await assertDayCap(userId, d.workDate, b.minutes);
  const r = await pool.query(
    `insert into timesheet_entries (user_id, work_date, type_key, minutes, start_time, end_time, lunch_minutes, bank_minutes, amount_cents, client_id, task_id, description, billable, billable_minutes, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual') returning id`,
    [userId, d.workDate, b.type_key, b.minutes, b.start_time, b.end_time, b.lunch_minutes, b.bank_minutes, b.amount_cents, b.client_id, b.task_id, b.description, b.billable, b.billable_minutes]);
  const id = r.rows[0].id as string;
  let negative: string[] = [];
  try { negative = await applyLedger({ id, user_id: userId, kind: b.kind, minutes: b.minutes, bank_minutes: b.bank_minutes, work_date: d.workDate }, auth(c).user.id); }
  catch (e) { await pool.query("delete from timesheet_entries where id = $1", [id]); throw e; }
  await afterChange(userId, start, auth(c).user.id);
  await recordEntry("create", me, id, userId, null, { workDate: d.workDate, typeKey: b.type_key, minutes: b.minutes, clientId: b.client_id, taskId: b.task_id, description: b.description, billable: b.billable, source: "manual", status: "draft" });
  return { id, negative };
}

timeRoutes.post("/entries", async (c) => c.json(await addEntry(c, await body(c, EntryInput)), 201));

timeRoutes.patch("/entries/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const cur = (await pool.query("select e.*, t.kind from timesheet_entries e join time_types t on t.key = e.type_key where e.id = $1", [id])).rows[0];
  if (!cur) return c.json({ error: "not found" }, 404);
  const me = auth(c).user.id;
  if (cur.user_id !== me) throw new Fail(403, "forbidden"); // ownership first: nobody edits another person's entry
  const d = await body(c, EntryInput.partial().omit({ userId: true }));
  const start = mondayOf(cur.work_date);
  await assertEditable(c, cur.user_id, start);
  if (cur.status !== "draft" && cur.status !== "rejected") throw new Fail(409, "timesheet_locked");
  if ((await pool.query("select 1 from billing_items where source = 'time' and source_id = $1 and status = 'invoiced'", [id])).rowCount) throw new Fail(409, "entry_invoiced");
  const fromTimer = cur.source === "timer"; // a timer entry keeps its day, client and task: only description, minutes and billable change
  const merged = {
    workDate: fromTimer ? cur.work_date : d.workDate ?? cur.work_date, typeKey: cur.type_key, minutes: d.minutes ?? (cur.kind === "workday" || cur.kind === "holiday" ? undefined : cur.minutes),
    start: d.start ?? cur.start_time ?? undefined, end: d.end ?? cur.end_time ?? undefined, bankMinutes: d.bankMinutes ?? cur.bank_minutes,
    clientId: fromTimer ? cur.client_id : d.clientId !== undefined ? d.clientId : cur.client_id, taskId: fromTimer ? cur.task_id : d.taskId !== undefined ? d.taskId : cur.task_id, description: d.description ?? cur.description,
    billable: d.billable ?? cur.billable, billableMinutes: d.billableMinutes !== undefined ? d.billableMinutes : cur.billable_minutes,
  } as z.infer<typeof EntryInput>;
  if (fromTimer && merged.billable && !merged.clientId) merged.billable = false; // no client, nobody to bill
  if (mondayOf(merged.workDate) !== start) throw new Fail(400, "cannot_move_week");
  const b = await build(merged, cur.user_id, cur.id);
  await assertDayCap(cur.user_id, merged.workDate, b.minutes, cur.id);
  await pool.query(
    `update timesheet_entries set work_date=$2, minutes=$3, start_time=$4, end_time=$5, lunch_minutes=$6, bank_minutes=$7, amount_cents=$8, client_id=$9, task_id=$10, description=$11, billable=$12, billable_minutes=$13, updated_at=now() where id=$1`,
    [cur.id, merged.workDate, b.minutes, b.start_time, b.end_time, b.lunch_minutes, b.bank_minutes, b.amount_cents, b.client_id, b.task_id, b.description, b.billable, b.billable_minutes]);
  const negative = await applyLedger({ id: cur.id, user_id: cur.user_id, kind: b.kind, minutes: b.minutes, bank_minutes: b.bank_minutes, work_date: merged.workDate }, me);
  await afterChange(cur.user_id, start, me);
  await recordEntry("update", me, cur.id, cur.user_id, snap(cur), { ...snap(cur), workDate: merged.workDate, minutes: b.minutes, clientId: b.client_id, taskId: b.task_id, description: b.description, billable: b.billable, billableMinutes: b.billable_minutes });
  return c.json({ ok: true, negative });
});

/** Deleting: the owner only, while the week is open. An entry made by the timer can only go while it is still a draft. */
timeRoutes.delete("/entries/:id", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ ok: true });
  const cur = (await pool.query("select * from timesheet_entries where id = $1", [id])).rows[0];
  if (!cur) return c.json({ ok: true });
  const me = auth(c).user.id;
  if (cur.user_id !== me) throw new Fail(403, "forbidden");
  const start = mondayOf(cur.work_date);
  await assertEditable(c, cur.user_id, start);
  if (cur.source === "timer" && cur.status !== "draft") throw new Fail(409, "timer_entry_locked");
  if (cur.status !== "draft" && cur.status !== "rejected") throw new Fail(409, "timesheet_locked");
  const used = (await pool.query("select 1 from billing_items where source = 'time' and source_id = $1 and status = 'invoiced'", [id])).rowCount;
  if (used) throw new Fail(409, "entry_invoiced");
  await recordEntry("delete", me, id, cur.user_id, snap(cur), null); // written first: the trail exists even if the delete fails half way
  await pool.query("delete from timesheet_entries where id = $1", [id]); // ledger rows go with it (cascade)
  await afterChange(cur.user_id, start, me);
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
    await audit(d.paid ? "timesheet.paid" : "timesheet.unpaid", { userId: auth(c).user.id, target: `${it.userId} ${mondayOf(it.start)}` });
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

// ------------------------------------------------------------------ Reopening an approved week (managers, audited)
/** The only way to change a sent or approved week: a manager reopens it with a reason. Never for a paid week, an invoiced entry, or one's own time. */
timeRoutes.post("/week/reopen", requirePermission("mytools.timesheet.manage"), async (c) => {
  const d = await body(c, z.object({ userId: z.string().uuid(), start: Day, reason: z.string().trim().min(3).max(300) }));
  const me = auth(c).user.id;
  if (d.userId === me) throw new Fail(403, "own_time");
  const start = mondayOf(d.start);
  const wk = await weekRow(d.userId, start);
  if (wk.status === "paid") throw new Fail(409, "week_paid");
  if (wk.status !== "approved" && wk.status !== "submitted") throw new Fail(409, "not_reopenable");
  const rows = await weekEntries(d.userId, start);
  const ids = rows.map((e) => e.id);
  if ((await pool.query("select 1 from billing_items where source = 'time' and source_id = any($1::uuid[]) and status = 'invoiced' limit 1", [ids])).rowCount) throw new Fail(409, "entry_invoiced");
  await pool.query("delete from billing_items where source = 'time' and source_id = any($1::uuid[]) and status <> 'invoiced'", [ids]); // handed off again at the next approval
  await setWeek(d.userId, start, "draft", { by: me });
  await refreshAccrual(d.userId, start);
  for (const e of rows) await recordEntry("reopen", me, e.id, d.userId, { status: e.status }, { status: "draft", reason: d.reason });
  await audit("timesheet.reopen", { userId: me, target: `${d.userId} ${start}`, detail: { reason: d.reason, entries: rows.length } });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Payroll view and export
const PAY_KEY = "time.payPeriod";
const PayQuery = z.object({ date: Day.optional() });
const payConfig = async () => normalizePayConfig((await getSetting<unknown>(PAY_KEY)) ?? DEFAULT_PAY);

timeRoutes.get("/payroll/settings", async (c) => c.json({ ...(await payConfig()), canEdit: isManager(c) }));

timeRoutes.put("/payroll/settings", requirePermission("mytools.timesheet.manage"), async (c) => {
  const d = await body(c, z.object({ type: z.enum(["weekly", "biweekly"]), anchor: Day }));
  const before = await payConfig();
  await setSetting(PAY_KEY, { type: d.type, anchor: d.anchor });
  await audit("timesheet.pay_period_setting", { userId: auth(c).user.id, detail: { before, after: d } });
  return c.json({ ...d, canEdit: true });
});

// Payroll counts "tracked" time (work, travel, other) and, separately, the paid minutes of the existing pay rule.
const TRACKED = "t.kind in ('work','travel','other')";
const BILLED = "case when e.billable and t.kind in ('work','travel') then least(coalesce(e.billable_minutes, e.minutes), e.minutes) else 0 end";
const PAID = "case t.kind when 'workday' then e.minutes - e.bank_minutes when 'vacation' then e.minutes when 'sick' then e.minutes when 'holiday' then e.minutes when 'bankpay' then e.minutes else 0 end";

interface Emp {
  userId: string; name: string; trackedMinutes: number; billableMinutes: number; nonBillableMinutes: number; paidMinutes: number; timerMinutes: number;
  days: { date: string; trackedMinutes: number; billableMinutes: number; paidMinutes: number }[];
  byClient: { clientId: string | null; name: string; minutes: number; billableMinutes: number }[];
  byTask: { taskId: string; title: string; clientName: string | null; minutes: number; billableMinutes: number }[];
  statuses: Record<string, { count: number; minutes: number }>; weeks: { start: string; status: string }[];
}

/** Employees only ever get their own rows; approvers and managers get everybody. Four grouped queries, no per-employee loop. */
timeRoutes.get("/payroll", async (c) => {
  const q = PayQuery.safeParse({ date: c.req.query("date") || undefined });
  if (!q.success) return c.json({ error: "invalid_date" }, 400);
  const cfg = await payConfig();
  const period = payPeriodOf(q.data.date ?? quebecToday(), cfg);
  const only = isApprover(c) ? null : auth(c).user.id;
  const args = [period.start, period.end, only];
  const [days, parts, statuses, weeks] = await Promise.all([
    pool.query(
      `select e.user_id, u.name, e.work_date,
              coalesce(sum(e.minutes) filter (where ${TRACKED}), 0)::int as tracked, coalesce(sum(${BILLED}), 0)::int as billed,
              coalesce(sum(e.minutes) filter (where e.source = 'timer'), 0)::int as timer, coalesce(sum(${PAID}), 0)::int as paid
         from timesheet_entries e join time_types t on t.key = e.type_key join users u on u.id = e.user_id
        where e.work_date between $1 and $2 and ($3::uuid is null or e.user_id = $3)
        group by e.user_id, u.name, e.work_date order by lower(u.name), e.work_date`, args),
    pool.query(
      `select e.user_id, e.client_id, cl.name as client_name, e.task_id, k.title as task_title,
              sum(e.minutes)::int as minutes, coalesce(sum(${BILLED}), 0)::int as billed
         from timesheet_entries e join time_types t on t.key = e.type_key left join clients cl on cl.id = e.client_id left join tasks k on k.id = e.task_id
        where e.work_date between $1 and $2 and ($3::uuid is null or e.user_id = $3) and ${TRACKED}
        group by e.user_id, e.client_id, cl.name, e.task_id, k.title`, args),
    pool.query(
      `select e.user_id, e.status, count(*)::int as n, sum(e.minutes)::int as minutes from timesheet_entries e
        where e.work_date between $1 and $2 and ($3::uuid is null or e.user_id = $3) group by e.user_id, e.status`, args),
    pool.query(
      "select user_id, week_start, status from timesheet_weeks where week_start between $1::date - 6 and $2 and ($3::uuid is null or user_id = $3)", args),
  ]);
  const emps = new Map<string, Emp>();
  const get = (id: string, name?: string) => {
    let e = emps.get(id);
    if (!e) { e = { userId: id, name: name ?? "", trackedMinutes: 0, billableMinutes: 0, nonBillableMinutes: 0, paidMinutes: 0, timerMinutes: 0, days: [], byClient: [], byTask: [], statuses: {}, weeks: [] }; emps.set(id, e); }
    return e;
  };
  for (const r of days.rows) {
    const e = get(r.user_id, r.name);
    e.trackedMinutes += r.tracked; e.billableMinutes += r.billed; e.paidMinutes += r.paid; e.timerMinutes += r.timer;
    e.days.push({ date: r.work_date, trackedMinutes: r.tracked, billableMinutes: r.billed, paidMinutes: r.paid });
  }
  const byClient = new Map<string, Emp["byClient"][number]>();
  for (const r of parts.rows) {
    const e = get(r.user_id);
    const k = `${r.user_id}|${r.client_id ?? ""}`;
    let row = byClient.get(k);
    if (!row) { row = { clientId: r.client_id, name: r.client_name ?? "", minutes: 0, billableMinutes: 0 }; byClient.set(k, row); e.byClient.push(row); }
    row.minutes += r.minutes; row.billableMinutes += r.billed;
    if (r.task_id) e.byTask.push({ taskId: r.task_id, title: r.task_title ?? "", clientName: r.client_name, minutes: r.minutes, billableMinutes: r.billed });
  }
  for (const r of statuses.rows) get(r.user_id).statuses[r.status] = { count: r.n, minutes: r.minutes };
  for (const r of weeks.rows) { const e = emps.get(r.user_id); if (e) e.weeks.push({ start: r.week_start, status: r.status }); }
  const employees = [...emps.values()].map((e) => ({
    ...e, nonBillableMinutes: Math.max(0, e.trackedMinutes - e.billableMinutes),
    byClient: e.byClient.sort((a, b) => b.minutes - a.minutes), byTask: e.byTask.sort((a, b) => b.minutes - a.minutes).slice(0, 100),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return c.json({ period, config: cfg, employees });
});

/** CSV of the period, one row per entry. Approvers and managers only; every export is audited. The file name comes from the computed period, never from the request. */
timeRoutes.get("/payroll/export", requirePermission("mytools.timesheet.approve", "mytools.timesheet.manage"), async (c) => {
  const q = PayQuery.safeParse({ date: c.req.query("date") || undefined });
  if (!q.success) return c.json({ error: "invalid_date" }, 400);
  const period = payPeriodOf(q.data.date ?? quebecToday(), await payConfig());
  const r = await pool.query(
    `select u.name as employee, e.work_date, t.label_fr as type, cl.name as client, k.title as task, e.description, e.minutes,
            ${BILLED} as billed, e.billable, e.source, e.measured_minutes, e.status, ${PAID} as paid
       from timesheet_entries e join time_types t on t.key = e.type_key join users u on u.id = e.user_id
       left join clients cl on cl.id = e.client_id left join tasks k on k.id = e.task_id
      where e.work_date between $1 and $2 order by lower(u.name), e.work_date, e.created_at limit 20000`, [period.start, period.end]);
  const rows: unknown[][] = [["Employé", "Date", "Type", "Client", "Tâche", "Description", "Minutes", "Heures", "Minutes facturables", "Facturable", "Source", "Minutes mesurées (chrono)", "Statut", "Minutes payées"]];
  for (const x of r.rows) rows.push([x.employee, x.work_date, x.type, x.client ?? "", x.task ?? "", x.description, x.minutes, hoursOf(x.minutes), x.billed, x.billable ? "oui" : "non", x.source === "timer" ? "chrono" : "manuel", x.measured_minutes ?? "", x.status, x.paid]);
  await audit("timesheet.payroll_export", { userId: auth(c).user.id, target: `${period.start} ${period.end}`, detail: { rows: r.rows.length } });
  return new Response(toCsv(rows), { headers: {
    "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="paie_${period.start}_${period.end}.csv"`,
    "cache-control": "no-store", "x-content-type-options": "nosniff" } });
});
