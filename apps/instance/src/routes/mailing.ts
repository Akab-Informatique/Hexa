import { Hono } from "hono";
import { z } from "zod";
import { aging, roundCents, todayISO } from "@hexa/shared/billing";
import { pool, getSetting, setSetting } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import * as license from "../license.ts";
import { boardMail, invoiceMail, mailReady, sendMail, statementMail, validEmail } from "../lib/mail.ts";
import { ServiceError } from "../lib/services.ts";
import { auth, body, isUuid } from "./util.ts";

// Emails to clients through Mailjet: an invoice, a reminder, an account statement, and the automatic reminders
// (one per invoice and level, weekdays only, off until someone turns it on). A message always goes out one email per
// recipient, with the invoice's details in the body.
export const mailingRoutes = new Hono<Env>();
mailingRoutes.onError((e, c) => {
  if (e instanceof ServiceError) return c.json({ error: e.code, detail: e.detail }, e.status as 400);
  throw e;
});
const Lang = z.enum(["fr", "en"]).default("fr");
const firm = () => license.current().branding.appName;

/** Where a client's invoices go: the billing email (the billing contact's), else the client's own email. */
async function clientAddress(clientId: string): Promise<{ name: string; email: string | null }> {
  const r = (await pool.query("select name, billing_email, email from clients where id = $1", [clientId])).rows[0];
  const email = [r?.billing_email, r?.email].find((x) => validEmail(x)) ?? null;
  return { name: r?.name ?? "", email };
}

async function invoiceData(id: string) {
  if (!isUuid(id)) throw new ServiceError(404, "not_found");
  const r = (await pool.query(
    `select i.*, coalesce((select sum(p.amount_cents) from invoice_payments p where p.invoice_id = i.id), 0) as paid_cents from invoices i where i.id = $1`, [id])).rows[0];
  if (!r) throw new ServiceError(404, "not_found");
  const balance = roundCents(Number(r.total) - Number(r.paid_cents) / 100);
  return { row: r, balance, daysLate: aging(String(r.due_date).slice(0, 10), todayISO()).daysLate };
}

mailingRoutes.post("/invoices/:id/email", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ to: z.string().email().optional(), note: z.string().max(2000).optional(), lang: Lang }));
  const { row, balance, daysLate } = await invoiceData(c.req.param("id"));
  if (row.status === "draft" || row.status === "void") throw new ServiceError(409, "invoice_not_sent");
  const addr = await clientAddress(row.client_id);
  const to = d.to ?? addr.email;
  if (!to) throw new ServiceError(409, "no_billing_email");
  if (!(await mailReady())) throw new ServiceError(409, "mailjet_not_configured");
  const m = invoiceMail({ firm: firm(), number: row.number, client: addr.name, total: Number(row.total), balance, issueDate: row.issue_date, dueDate: row.due_date, poNumber: row.po_number, daysLate: 0, note: d.note }, d.lang, "sent");
  const r = await sendMail({ to: [{ email: to, name: addr.name }], ...m });
  if (!r.sent) throw new ServiceError(502, "mail_failed", r.failed[0]?.error);
  await pool.query("update invoices set emailed_at = now() where id = $1", [row.id]);
  await audit("invoice.emailed", { userId: auth(c).user.id, target: row.number, detail: { to } });
  void daysLate;
  return c.json({ ok: true, to });
});

mailingRoutes.post("/invoices/:id/reminder", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ to: z.string().email().optional(), lang: Lang }));
  const { row, balance, daysLate } = await invoiceData(c.req.param("id"));
  if (row.status !== "sent" || balance <= 0 || daysLate < 1) throw new ServiceError(409, "nothing_due");
  const addr = await clientAddress(row.client_id);
  const to = d.to ?? addr.email;
  if (!to) throw new ServiceError(409, "no_billing_email");
  if (!(await mailReady())) throw new ServiceError(409, "mailjet_not_configured");
  const m = invoiceMail({ firm: firm(), number: row.number, client: addr.name, total: Number(row.total), balance, issueDate: row.issue_date, dueDate: row.due_date, poNumber: row.po_number, daysLate }, d.lang, "reminder");
  const r = await sendMail({ to: [{ email: to, name: addr.name }], ...m });
  if (!r.sent) throw new ServiceError(502, "mail_failed", r.failed[0]?.error);
  await audit("invoice.reminder", { userId: auth(c).user.id, target: row.number, detail: { to, daysLate } });
  return c.json({ ok: true, to });
});

mailingRoutes.post("/clients/:id/statement/email", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ to: z.string().email().optional(), lang: Lang }));
  const id = c.req.param("id");
  if (!isUuid(id)) throw new ServiceError(404, "not_found");
  const addr = await clientAddress(id);
  const to = d.to ?? addr.email;
  if (!to) throw new ServiceError(409, "no_billing_email");
  const today = todayISO();
  const r = await pool.query(
    `select i.number, i.due_date, round(i.total * 100) - coalesce((select sum(p.amount_cents) from invoice_payments p where p.invoice_id = i.id), 0) as bal from invoices i where i.client_id = $1 and i.status = 'sent' order by i.due_date`, [id]);
  const rows = r.rows.filter((x) => Number(x.bal) > 0).map((x) => ({ number: x.number as string, dueDate: String(x.due_date).slice(0, 10), balance: Number(x.bal) / 100, daysLate: aging(String(x.due_date).slice(0, 10), today).daysLate }));
  if (!rows.length) throw new ServiceError(409, "nothing_due");
  if (!(await mailReady())) throw new ServiceError(409, "mailjet_not_configured");
  const total = roundCents(rows.reduce((a, x) => a + x.balance, 0));
  const m = statementMail({ firm: firm(), client: addr.name, total, pastDue: roundCents(rows.filter((x) => x.daysLate > 0).reduce((a, x) => a + x.balance, 0)), rows }, d.lang);
  const s = await sendMail({ to: [{ email: to, name: addr.name }], ...m });
  if (!s.sent) throw new ServiceError(502, "mail_failed", s.failed[0]?.error);
  await audit("statement.emailed", { userId: auth(c).user.id, target: addr.name, detail: { to } });
  return c.json({ ok: true, to });
});

// ------------------------------------------------------------------ Automatic reminders
interface ReminderSettings { enabled: boolean; from: string | null; levels: number[]; lang: "fr" | "en"; lastRun: string | null }
const RDEFAULT: ReminderSettings = { enabled: false, from: null, levels: [5, 15, 30, 60, 90], lang: "fr", lastRun: null };
const rsettings = async (): Promise<ReminderSettings> => ({ ...RDEFAULT, ...((await getSetting<Partial<ReminderSettings>>("invoice.reminders")) ?? {}) });

mailingRoutes.get("/reminders/settings", requirePermission("accounting.invoices.manage"), async (c) => c.json(await rsettings()));
mailingRoutes.put("/reminders/settings", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ enabled: z.boolean(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), levels: z.array(z.number().int().min(1).max(365)).min(1).max(8), lang: Lang }));
  const cur = await rsettings();
  await setSetting("invoice.reminders", { ...cur, ...d, levels: [...new Set(d.levels)].sort((a, b) => a - b) });
  await audit("reminders.settings", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

/**
 * Sends each overdue unpaid invoice the highest reminder level it reached, once per invoice and level, never a lower level
 * after a higher one, only for invoices dated on or after the "from" day, and never to a client with no address.
 */
export async function runReminders(): Promise<{ sent: number; skipped: number }> {
  const s = await rsettings();
  if (!(await mailReady())) return { sent: 0, skipped: 0 };
  const today = todayISO();
  const r = await pool.query(
    `select i.id, i.number, i.client_id, i.total, i.issue_date, i.due_date, i.po_number,
            coalesce((select sum(p.amount_cents) from invoice_payments p where p.invoice_id = i.id), 0) as paid_cents,
            (select max(level) from invoice_reminders x where x.invoice_id = i.id) as last_level
       from invoices i where i.status = 'sent' and i.due_date < $1::date and ($2::date is null or i.issue_date >= $2)`, [today, s.from]);
  let sent = 0, skipped = 0;
  for (const inv of r.rows) {
    const balance = roundCents(Number(inv.total) - Number(inv.paid_cents) / 100);
    const daysLate = aging(String(inv.due_date).slice(0, 10), today).daysLate;
    const level = [...s.levels].sort((a, b) => b - a).find((l) => daysLate >= l);
    if (balance <= 0 || !level || (inv.last_level !== null && level <= inv.last_level)) { skipped++; continue; }
    const addr = await clientAddress(inv.client_id);
    if (!addr.email) { skipped++; continue; }
    // Claim the level before sending, so a second run (or a second server) can never send it twice.
    const claim = await pool.query("insert into invoice_reminders (invoice_id, level) values ($1,$2) on conflict do nothing returning level", [inv.id, level]);
    if (!claim.rowCount) { skipped++; continue; }
    const m = invoiceMail({ firm: firm(), number: inv.number, client: addr.name, total: Number(inv.total), balance, issueDate: inv.issue_date, dueDate: inv.due_date, poNumber: inv.po_number, daysLate }, s.lang, "reminder");
    try {
      const res = await sendMail({ to: [{ email: addr.email, name: addr.name }], ...m });
      if (res.sent) sent++; else { await pool.query("delete from invoice_reminders where invoice_id = $1 and level = $2", [inv.id, level]); skipped++; }
    } catch { await pool.query("delete from invoice_reminders where invoice_id = $1 and level = $2", [inv.id, level]); skipped++; }
  }
  return { sent, skipped };
}

/** Every few minutes; sends on weekdays after 8:30 (Quebec time), once a day, and only when switched on. */
export async function reminderTick(): Promise<void> {
  const s = await rsettings();
  if (!s.enabled) return;
  const now = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => now.find((p) => p.type === t)?.value ?? "";
  if (["Sat", "Sun"].includes(get("weekday")) || (Number(get("hour")) % 24) * 60 + Number(get("minute")) < 8 * 60 + 30) return;
  const today = todayISO();
  if (s.lastRun === today) return;
  await setSetting("invoice.reminders", { ...s, lastRun: today });
  await runReminders();
}

mailingRoutes.post("/reminders/run", requirePermission("accounting.invoices.manage"), async (c) => {
  const r = await runReminders();
  await audit("reminders.run", { userId: auth(c).user.id, detail: r });
  return c.json(r);
});

// ------------------------------------------------------------------ Board messages by email (called by the board route)
export async function emailBoardMessage(id: string, lang: "fr" | "en" = "fr"): Promise<{ status: "sent" | "failed" | "pending"; sent: number; failed: number }> {
  const m = (await pool.query("select title, body, audience from messages where id = $1", [id])).rows[0];
  if (!m) return { status: "failed", sent: 0, failed: 0 };
  if (!(await mailReady())) return { status: "pending", sent: 0, failed: 0 };
  const clients = (await pool.query(
    `select c.id, c.name, c.billing_email, c.email, (select k.email from client_contacts k where k.client_id = c.id and k.is_primary and k.email <> '' limit 1) as primary_email
       from clients c where c.status <> 'inactive' and ($1 = 'all' or c.id in (select client_id from message_targets where message_id = $2))`, [m.audience, id])).rows;
  const seen = new Set<string>();
  const to = clients.flatMap((c) => { const e = [c.primary_email, c.billing_email, c.email].find((x) => validEmail(x)); if (!e || seen.has(e.toLowerCase())) return []; seen.add(e.toLowerCase()); return [{ email: e as string, name: c.name as string }]; });
  const mail = boardMail(firm(), m.title, m.body, lang);
  const res = to.length ? await sendMail({ to, ...mail }) : { sent: 0, failed: [] as unknown[] };
  const status = res.failed.length === 0 && (res.sent > 0 || to.length === 0) ? "sent" : "failed";
  await pool.query("update messages set email_status = $2 where id = $1", [id, status]);
  return { status, sent: res.sent, failed: res.failed.length };
}
