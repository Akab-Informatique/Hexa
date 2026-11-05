import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, can } from "./util.ts";
import { balancesOf } from "./time.ts";

export const hrRoutes = new Hono<Env>();

// Reference rule: HR data (wage, the three balances) is for HR only; employees never see their own HR sheet here.
// Balances come from the ledger: timesheet entries move them by themselves, HR can adjust them by hand (confirmed, audited).
hrRoutes.get("/staff", requirePermission("hr.view", "hr.manage"), async (c) => {
  const manage = can(c, "hr.manage");
  const r = await pool.query(
    `select u.id, u.name, u.email, u.active, p.job_title, p.hire_date, p.phone, p.emergency_contact, p.hourly_wage, coalesce(p.overtime_hours, 40) as overtime_hours, coalesce(p.notes, '') as notes
       from users u left join hr_profiles p on p.user_id = u.id where u.kind = 'staff' order by u.active desc, lower(u.name)`);
  const rows = camelRows<{ id: string; hourlyWage: number | null }>(r);
  if (!manage) return c.json(rows.map((x) => ({ ...x, hourlyWage: null, overtimeHours: null, notes: "" })));
  const bal = await pool.query("select user_id, account, sum(delta) as b from hr_ledger group by user_id, account");
  return c.json(rows.map((x) => {
    const mine = bal.rows.filter((b) => b.user_id === x.id);
    const get = (a: string) => Number(mine.find((b) => b.account === a)?.b ?? 0);
    return { ...x, bankCents: get("bank"), vacationCents: get("vacation"), sickHundredths: get("sick") };
  }));
});

const ProfileInput = z.object({
  jobTitle: z.string().max(120).optional(), hireDate: z.string().regex(/^d{4}-d{2}-d{2}$/).nullable().optional(), phone: z.string().max(60).optional(),
  emergencyContact: z.string().max(300).optional(), hourlyWage: z.number().min(0).max(10000).nullable().optional(),
  overtimeHours: z.number().min(1).max(100).optional(), notes: z.string().max(5000).optional(),
});

hrRoutes.put("/staff/:userId", requirePermission("hr.manage"), async (c) => {
  const d = await body(c, ProfileInput);
  await pool.query(
    `insert into hr_profiles (user_id, job_title, hire_date, phone, emergency_contact, hourly_wage, overtime_hours, notes)
     values ($1, coalesce($2,''), $3, coalesce($4,''), coalesce($5,''), $6, coalesce($7,40), coalesce($8,''))
     on conflict (user_id) do update set job_title = coalesce($2, hr_profiles.job_title), hire_date = case when $9 then $3 else hr_profiles.hire_date end,
       phone = coalesce($4, hr_profiles.phone), emergency_contact = coalesce($5, hr_profiles.emergency_contact),
       hourly_wage = case when $10 then $6 else hr_profiles.hourly_wage end, overtime_hours = coalesce($7, hr_profiles.overtime_hours), notes = coalesce($8, hr_profiles.notes)`,
    [c.req.param("userId"), d.jobTitle, d.hireDate ?? null, d.phone, d.emergencyContact, d.hourlyWage ?? null, d.overtimeHours, d.notes, d.hireDate !== undefined, d.hourlyWage !== undefined],
  );
  await audit("hr.profile_updated", { userId: auth(c).user.id, target: c.req.param("userId") });
  return c.json({ ok: true });
});

hrRoutes.get("/staff/:userId/ledger", requirePermission("hr.manage"), async (c) => {
  const r = await pool.query(
    `select l.id, l.account, l.delta, l.kind, l.reason, l.week_start, l.created_at, u.name as by_name from hr_ledger l left join users u on u.id = l.created_by
      where l.user_id = $1 order by l.created_at desc limit 300`, [c.req.param("userId")]);
  return c.json({ balances: await balancesOf(c.req.param("userId")), rows: camelRows(r) });
});

// A hand change needs the confirmation tick and a reason, is audited, and may take a balance below zero (flagged, never blocked).
hrRoutes.post("/staff/:userId/adjust", requirePermission("hr.manage"), async (c) => {
  const d = await body(c, z.object({ account: z.enum(["bank", "vacation", "sick"]), hours: z.number().min(-5000).max(5000).optional(), amount: z.number().min(-1000000).max(1000000).optional(), reason: z.string().min(1).max(300), confirm: z.literal(true) }));
  const userId = c.req.param("userId");
  let delta: number;
  if (d.account === "sick") {
    if (d.hours == null) return c.json({ error: "hours_required" }, 400);
    delta = Math.round(d.hours * 100);
  } else if (d.amount != null) delta = Math.round(d.amount * 100);
  else if (d.hours != null) {
    const w = (await pool.query("select hourly_wage from hr_profiles where user_id = $1", [userId])).rows[0]?.hourly_wage;
    if (w == null) return c.json({ error: "hr_wage_missing" }, 409);
    delta = Math.round(d.hours * Number(w) * 100);
  } else return c.json({ error: "amount_required" }, 400);
  if (delta === 0) return c.json({ error: "nothing_to_change" }, 400);
  await pool.query("insert into hr_ledger (user_id, account, delta, kind, reason, created_by) values ($1,$2,$3,'adjust',$4,$5)", [userId, d.account, delta, d.reason, auth(c).user.id]);
  await audit("hr.adjusted", { userId: auth(c).user.id, target: userId, detail: { account: d.account, delta, reason: d.reason } });
  const bal = await balancesOf(userId);
  const value = d.account === "bank" ? bal.bankCents : d.account === "vacation" ? bal.vacationCents : bal.sickHundredths;
  return c.json({ ok: true, balances: bal, negative: value < 0 });
});

// ---- Absences: visible to HR and to the weekly meeting; anyone in HR can add, HR managers remove ----
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
hrRoutes.get("/absences", requirePermission("hr.view", "hr.manage", "team.meeting.view"), async (c) => {
  const from = c.req.query("from");
  const r = await pool.query(
    "select a.*, u.name as user_name from absences a join users u on u.id = a.user_id where a.ends_on >= coalesce($1::date, current_date - 30) order by a.starts_on",
    [from && Day.safeParse(from).success ? from : null]);
  return c.json(camelRows(r));
});

hrRoutes.post("/absences", requirePermission("hr.view", "hr.manage"), async (c) => {
  const d = await body(c, z.object({ userId: z.string().uuid().optional(), kind: z.enum(["vacation", "sick", "training", "personal", "other"]), startsOn: Day, endsOn: Day, note: z.string().max(500).optional() }));
  if (d.endsOn < d.startsOn) return c.json({ error: "the end date is before the start date" }, 400);
  // Without hr.manage you can only record your own absence.
  const userId = can(c, "hr.manage") ? (d.userId ?? auth(c).user.id) : auth(c).user.id;
  const r = await pool.query("insert into absences (user_id, kind, starts_on, ends_on, note, created_by) values ($1, $2, $3, $4, coalesce($5,''), $6) returning id", [userId, d.kind, d.startsOn, d.endsOn, d.note, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});

hrRoutes.delete("/absences/:id", requirePermission("hr.view", "hr.manage"), async (c) => {
  const a = (await pool.query("select user_id, created_by from absences where id = $1", [c.req.param("id")])).rows[0];
  if (!a) return c.json({ ok: true });
  if (!can(c, "hr.manage") && a.created_by !== auth(c).user.id) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from absences where id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});
