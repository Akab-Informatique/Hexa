import { Hono } from "hono";
import { z } from "zod";
import { addDays, buildForecast, recurrenceDates, roundCents, todayISO, type Freq } from "@nexo/shared/billing";
import { pool, getSetting, setSetting } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, can } from "./util.ts";

// Vendor payments, modelled on the reference: the list with summary tiles and filters, a month calendar of what is due,
// recurring payments (with a paste-from-spreadsheet import), a weekly payroll plan (HR only) and a day-by-day cash forecast.
export const vendorPaymentRoutes = new Hono<Env>();
const VIEW = ["accounting.vendors.view", "accounting.vendors.manage"];
vendorPaymentRoutes.use("/bills", requirePermission(...VIEW));
vendorPaymentRoutes.use("/bills/*", requirePermission(...VIEW));
vendorPaymentRoutes.use("/recurring", requirePermission(...VIEW));
vendorPaymentRoutes.use("/recurring/*", requirePermission(...VIEW));
vendorPaymentRoutes.use("/forecast", requirePermission(...VIEW));
vendorPaymentRoutes.use("/forecast/*", requirePermission(...VIEW));
const needManage = requirePermission("accounting.vendors.manage");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cents = (n: number | string) => Math.round(Number(n) * 100);

// ------------------------------------------------------------------ The list and its tiles
vendorPaymentRoutes.get("/bills", async (c) => {
  const status = c.req.query("status") ?? "open";
  const q = (c.req.query("q") ?? "").trim();
  const from = Day.safeParse(c.req.query("from")).success ? c.req.query("from")! : null;
  const to = Day.safeParse(c.req.query("to")).success ? c.req.query("to")! : null;
  const today = todayISO();
  const r = await pool.query(
    `select b.*, v.name as vendor_name from vendor_bills b join vendors v on v.id = b.vendor_id
      where ($1 = 'all' or ($1 = 'open' and b.status <> 'paid') or ($1 = 'overdue' and b.status <> 'paid' and b.due_date < $2::date) or b.status = $1)
        and ($3 = '' or v.name ilike '%' || $3 || '%' or b.number ilike '%' || $3 || '%' or b.notes ilike '%' || $3 || '%')
        and ($4::date is null or b.due_date >= $4) and ($5::date is null or b.due_date <= $5)
      order by b.status = 'paid', b.due_date nulls last, lower(v.name) limit 1000`,
    [["open", "all", "overdue", "unpaid", "scheduled", "paid"].includes(status) ? status : "open", today, q, from, to]);
  // The tiles always cover every open bill, whatever the filter.
  const open = (await pool.query("select due_date, amount from vendor_bills where status <> 'paid'")).rows;
  const sum = (xs: typeof open) => ({ count: xs.length, amount: roundCents(xs.reduce((a, b) => a + Number(b.amount), 0)) });
  const d = (b: { due_date: string | null }) => (b.due_date ? String(b.due_date).slice(0, 10) : null);
  const in7 = addDays(today, 7), in30 = addDays(today, 30);
  const tiles = {
    late: sum(open.filter((b) => d(b) !== null && d(b)! < today)), today: sum(open.filter((b) => d(b) === today)),
    next7: sum(open.filter((b) => d(b) !== null && d(b)! > today && d(b)! <= in7)), next30: sum(open.filter((b) => d(b) !== null && d(b)! > today && d(b)! <= in30)),
    noDate: sum(open.filter((b) => d(b) === null)), open: sum(open),
  };
  return c.json({
    bills: camelRows(r), today, tiles,
    // Kept for the dashboard widget.
    totals: { open: tiles.open.amount, overdue: tiles.late.amount, dueThisWeek: roundCents(tiles.today.amount + tiles.next7.amount) },
  });
});

/** A month of due bills (Monday-first grid is drawn by the page), with recurring payments and paydays projected. */
vendorPaymentRoutes.get("/bills/calendar", async (c) => {
  const m = /^\d{4}-\d{2}$/.test(c.req.query("month") ?? "") ? c.req.query("month")! : todayISO().slice(0, 7);
  const from = `${m}-01`;
  const next = new Date(`${from}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
  const to = addDays(next.toISOString().slice(0, 10), -1);
  const [bills, rec, plan] = await Promise.all([
    pool.query("select b.id, b.number, b.amount, b.status, b.due_date, v.name as vendor_name from vendor_bills b join vendors v on v.id = b.vendor_id where b.due_date between $1 and $2 order by v.name", [from, to]),
    pool.query("select label, amount, frequency, next_date, in_quickbooks from recurring_payments where active", []),
    can(c, "hr.manage") ? pool.query("select coalesce(sum(weekly_amount), 0) as w from payroll_plan") : Promise.resolve({ rows: [{ w: 0 }] }),
  ]);
  const payday = can(c, "hr.manage") ? ((await getSetting<{ weekday: number }>("payroll"))?.weekday ?? 4) : null;
  const days = new Map<string, { date: string; bills: Record<string, unknown>[]; recurring: { label: string; amount: number; inQuickbooks: boolean }[]; payroll: number | null }>();
  const get = (date: string) => { if (!days.has(date)) days.set(date, { date, bills: [], recurring: [], payroll: null }); return days.get(date)!; };
  for (const b of bills.rows) get(String(b.due_date).slice(0, 10)).bills.push({ id: b.id, vendorName: b.vendor_name, number: b.number, amount: Number(b.amount), status: b.status });
  for (const r of rec.rows) for (const date of recurrenceDates(String(r.next_date).slice(0, 10), r.frequency as Freq, from, to)) get(date).recurring.push({ label: r.label, amount: Number(r.amount), inQuickbooks: r.in_quickbooks });
  if (payday !== null && Number(plan.rows[0].w) > 0) for (let k = 0; k <= 31; k++) { const date = addDays(from, k); if (date > to) break; if ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7 === payday) get(date).payroll = Number(plan.rows[0].w); }
  return c.json({ month: m, from, to, today: todayISO(), days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) });
});

// ------------------------------------------------------------------ Recurring payments
const RecInput = z.object({
  vendorId: z.string().uuid().nullable().optional(), label: z.string().min(1).max(200), amount: z.number().min(0).max(1e9), frequency: z.enum(["weekly", "monthly", "yearly"]),
  nextDate: Day, active: z.boolean().optional(), inQuickbooks: z.boolean().optional(), notes: z.string().max(1000).optional(),
});

vendorPaymentRoutes.get("/recurring", async (c) => {
  const r = await pool.query("select p.*, v.name as vendor_name from recurring_payments p left join vendors v on v.id = p.vendor_id order by p.active desc, lower(p.label)");
  const today = todayISO();
  const rows = camelRows<{ frequency: Freq; nextDate: string; amount: number }>(r).map((x: any) => ({ ...x, upcoming: recurrenceDates(String(x.nextDate).slice(0, 10), x.frequency, today, addDays(today, 400))[0] ?? null }));
  return c.json(rows);
});
vendorPaymentRoutes.post("/recurring", needManage, async (c) => {
  const d = await body(c, RecInput);
  const r = await pool.query("insert into recurring_payments (vendor_id, label, amount, frequency, next_date, active, in_quickbooks, notes) values ($1,$2,$3,$4,$5,coalesce($6,true),coalesce($7,false),coalesce($8,'')) returning id", [d.vendorId ?? null, d.label, d.amount, d.frequency, d.nextDate, d.active, d.inQuickbooks, d.notes]);
  return c.json({ id: r.rows[0].id }, 201);
});
vendorPaymentRoutes.patch("/recurring/:id", needManage, async (c) => {
  const d = await body(c, RecInput.partial());
  const r = await pool.query(
    `update recurring_payments set vendor_id = case when $2 then $3::uuid else vendor_id end, label = coalesce($4,label), amount = coalesce($5,amount), frequency = coalesce($6,frequency), next_date = coalesce($7,next_date),
        active = coalesce($8,active), in_quickbooks = coalesce($9,in_quickbooks), notes = coalesce($10,notes) where id::text = $1`,
    [c.req.param("id"), d.vendorId !== undefined, d.vendorId ?? null, d.label ?? null, d.amount ?? null, d.frequency ?? null, d.nextDate ?? null, d.active ?? null, d.inQuickbooks ?? null, d.notes ?? null]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
vendorPaymentRoutes.delete("/recurring/:id", needManage, async (c) => {
  await pool.query("delete from recurring_payments where id::text = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

/**
 * Paste rows from a spreadsheet: vendor, label, amount, frequency (weekly | monthly | yearly), date, already in QuickBooks.
 * Tab, semicolon or comma separated; a header row is skipped. `commit: false` only checks and shows what would be made.
 */
const FREQ: Record<string, Freq> = { weekly: "weekly", hebdomadaire: "weekly", hebdo: "weekly", semaine: "weekly", monthly: "monthly", mensuel: "monthly", mois: "monthly", yearly: "yearly", annuel: "yearly", annual: "yearly", an: "yearly" };
vendorPaymentRoutes.post("/recurring/import", needManage, async (c) => {
  const d = await body(c, z.object({ text: z.string().min(1).max(200_000), commit: z.boolean().default(false) }));
  const lines = d.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const vendors = (await pool.query("select id, name from vendors")).rows as { id: string; name: string }[];
  const find = (n: string) => vendors.find((v) => v.name.toLowerCase() === n.toLowerCase());
  const rows = lines.map((line, i) => {
    const cols = line.split(line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",").map((x) => x.trim());
    const [vendor = "", label = "", amountRaw = "", freqRaw = "", dateRaw = "", qbRaw = ""] = cols;
    const header = i === 0 && /vendor|fournisseur/i.test(vendor) && !/\d/.test(amountRaw);
    const amount = Number(amountRaw.replace(/\s/g, "").replace(/\$/g, "").replace(",", "."));
    const freq = FREQ[freqRaw.toLowerCase()];
    let error = "";
    if (!vendor && !label) error = "empty";
    else if (!Number.isFinite(amount) || amount < 0 || amountRaw === "") error = "amount";
    else if (!freq) error = "frequency";
    else if (!Day.safeParse(dateRaw).success) error = "date";
    return { line: i + 1, header, vendor, label: label || vendor, amount, frequency: freq ?? null, nextDate: dateRaw, inQuickbooks: /^(oui|yes|y|o|1|x|true)$/i.test(qbRaw), vendorExists: Boolean(vendor && find(vendor)), error };
  }).filter((r) => !r.header);
  const good = rows.filter((r) => !r.error);
  if (!d.commit) return c.json({ rows, ok: good.length, errors: rows.length - good.length, newVendors: [...new Set(good.filter((r) => r.vendor && !r.vendorExists).map((r) => r.vendor))] });
  if (rows.length !== good.length) return c.json({ error: "import_has_errors", rows }, 409);
  let created = 0, newVendors = 0;
  for (const r of good) {
    let vid = r.vendor ? find(r.vendor)?.id ?? null : null;
    if (r.vendor && !vid) { vid = (await pool.query("insert into vendors (name) values ($1) returning id", [r.vendor])).rows[0].id; vendors.push({ id: vid!, name: r.vendor }); newVendors++; }
    await pool.query("insert into recurring_payments (vendor_id, label, amount, frequency, next_date, in_quickbooks) values ($1,$2,$3,$4,$5,$6)", [vid, r.label, r.amount, r.frequency, r.nextDate, r.inQuickbooks]);
    created++;
  }
  await audit("recurring.imported", { userId: auth(c).user.id, detail: { created, newVendors } });
  return c.json({ created, newVendors });
});

// ------------------------------------------------------------------ Payroll plan (HR only)
vendorPaymentRoutes.get("/payroll", requirePermission("hr.manage"), async (c) => {
  const r = await pool.query("select u.id as user_id, u.name, coalesce(p.weekly_amount, 0) as weekly_amount from users u left join payroll_plan p on p.user_id = u.id where u.kind = 'staff' and u.active order by lower(u.name)");
  const set = (await getSetting<{ weekday: number }>("payroll")) ?? { weekday: 4 };
  const rows = camelRows<{ weeklyAmount: number }>(r).map((x: any) => ({ ...x, weeklyAmount: Number(x.weeklyAmount) }));
  return c.json({ weekday: set.weekday, rows, total: roundCents(rows.reduce((a, x) => a + x.weeklyAmount, 0)) });
});
vendorPaymentRoutes.put("/payroll", requirePermission("hr.manage"), async (c) => {
  const d = await body(c, z.object({ weekday: z.number().int().min(0).max(6), amounts: z.array(z.object({ userId: z.string().uuid(), weekly: z.number().min(0).max(1e7) })).max(500) }));
  await setSetting("payroll", { weekday: d.weekday });
  for (const a of d.amounts) await pool.query("insert into payroll_plan (user_id, weekly_amount) values ($1,$2) on conflict (user_id) do update set weekly_amount = excluded.weekly_amount", [a.userId, a.weekly]);
  await audit("payroll.plan", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Cash forecast
interface ForecastSettings { balance: number; payDelayDays: number; lateDelayDays: number }
const FDEFAULT: ForecastSettings = { balance: 0, payDelayDays: 0, lateDelayDays: 10 };
const fsettings = async (): Promise<ForecastSettings> => ({ ...FDEFAULT, ...((await getSetting<Partial<ForecastSettings>>("vendor.forecast")) ?? {}) });

vendorPaymentRoutes.put("/forecast/settings", needManage, async (c) => {
  const d = await body(c, z.object({ balance: z.number().min(-1e9).max(1e9), payDelayDays: z.number().int().min(0).max(120), lateDelayDays: z.number().int().min(0).max(180) }));
  await setSetting("vendor.forecast", d);
  return c.json({ ok: true });
});

vendorPaymentRoutes.get("/forecast", async (c) => {
  const days = Math.min(120, Math.max(14, Number(c.req.query("days")) || 60));
  const s = await fsettings();
  const today = todayISO();
  const hr = can(c, "hr.manage");
  const [bills, invoices, recurring, plan] = await Promise.all([
    pool.query("select v.name as vendor, b.due_date, b.amount from vendor_bills b join vendors v on v.id = b.vendor_id where b.status <> 'paid'"),
    pool.query(`select cl.name as client, i.due_date, round(i.total * 100) - coalesce((select sum(p.amount_cents) from invoice_payments p where p.invoice_id = i.id), 0) as balance
                  from invoices i join clients cl on cl.id = i.client_id where i.status = 'sent'`),
    pool.query("select label, amount, frequency, next_date from recurring_payments where active and not in_quickbooks"),
    hr ? pool.query("select coalesce(sum(weekly_amount), 0) as w from payroll_plan") : Promise.resolve({ rows: [{ w: 0 }] }),
  ]);
  const weekday = hr ? ((await getSetting<{ weekday: number }>("payroll"))?.weekday ?? 4) : null;
  const f = buildForecast({
    today, days, balanceCents: cents(s.balance), payDelayDays: s.payDelayDays, lateDelayDays: s.lateDelayDays,
    bills: bills.rows.map((b) => ({ vendor: b.vendor, dueDate: b.due_date ? String(b.due_date).slice(0, 10) : null, amountCents: cents(b.amount) })),
    invoices: invoices.rows.filter((i) => Number(i.balance) > 0).map((i) => ({ client: i.client, dueDate: String(i.due_date).slice(0, 10), balanceCents: Number(i.balance) })),
    recurring: recurring.rows.map((r) => ({ label: r.label, anchor: String(r.next_date).slice(0, 10), freq: r.frequency as Freq, amountCents: cents(r.amount) })),
    payrollWeekday: weekday, payrollWeeklyCents: cents(plan.rows[0].w),
  });
  return c.json({ settings: s, days, payrollIncluded: hr && Number(plan.rows[0].w) > 0, payrollHidden: !hr, ...f });
});
