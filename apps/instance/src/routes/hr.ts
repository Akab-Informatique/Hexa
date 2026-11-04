import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, can } from "./util.ts";

export const hrRoutes = new Hono<Env>();

// Reference rule: HR data (wage, banks) is for HR only; employees never see their own HR sheet here.
hrRoutes.get("/staff", requirePermission("hr.view", "hr.manage"), async (c) => {
  const r = await pool.query(
    `select u.id, u.name, u.email, u.active, p.job_title, p.hire_date, p.phone, p.emergency_contact, p.hourly_wage, coalesce(p.vacation_hours, 0) as vacation_hours, coalesce(p.sick_days, 0) as sick_days, coalesce(p.notes, '') as notes
       from users u left join hr_profiles p on p.user_id = u.id where u.kind = 'staff' order by u.active desc, lower(u.name)`);
  // Wage is the most sensitive field: only hr.manage sees it.
  const rows = camelRows<{ hourlyWage: number | null }>(r);
  return c.json(can(c, "hr.manage") ? rows : rows.map((x) => ({ ...x, hourlyWage: null })));
});

const ProfileInput = z.object({
  jobTitle: z.string().max(120).optional(), hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), phone: z.string().max(60).optional(),
  emergencyContact: z.string().max(300).optional(), hourlyWage: z.number().min(0).max(10000).nullable().optional(),
  vacationHours: z.number().min(0).max(5000).optional(), sickDays: z.number().min(0).max(1000).optional(), notes: z.string().max(5000).optional(),
});

hrRoutes.put("/staff/:userId", requirePermission("hr.manage"), async (c) => {
  const d = await body(c, ProfileInput);
  await pool.query(
    `insert into hr_profiles (user_id, job_title, hire_date, phone, emergency_contact, hourly_wage, vacation_hours, sick_days, notes)
     values ($1, coalesce($2,''), $3, coalesce($4,''), coalesce($5,''), $6, coalesce($7,0), coalesce($8,0), coalesce($9,''))
     on conflict (user_id) do update set job_title = coalesce($2, hr_profiles.job_title), hire_date = case when $10 then $3 else hr_profiles.hire_date end,
       phone = coalesce($4, hr_profiles.phone), emergency_contact = coalesce($5, hr_profiles.emergency_contact),
       hourly_wage = case when $11 then $6 else hr_profiles.hourly_wage end, vacation_hours = coalesce($7, hr_profiles.vacation_hours),
       sick_days = coalesce($8, hr_profiles.sick_days), notes = coalesce($9, hr_profiles.notes)`,
    [c.req.param("userId"), d.jobTitle, d.hireDate ?? null, d.phone, d.emergencyContact, d.hourlyWage ?? null, d.vacationHours, d.sickDays, d.notes, d.hireDate !== undefined, d.hourlyWage !== undefined],
  );
  return c.json({ ok: true });
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
