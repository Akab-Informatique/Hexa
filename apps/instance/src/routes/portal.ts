import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { roundCents, todayISO } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { hashPassword, randomToken, sha256, temporaryPassword } from "../auth/crypto.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { config } from "../config.ts";
import * as license from "../license.ts";
import { mailReady, sendMail, validEmail, welcomeMail } from "../lib/mail.ts";
import { Fail, invoiceDetail, statementOf, WITH_PAID } from "./invoicing.ts";
import { auth, body, camel, camelRows, isUuid } from "./util.ts";

// Two halves live here:
//  - /api/portal/*  what a signed-in CLIENT user sees. Every query is bound to the user's own client_id (taken from the
//    session, never from the request), so one client can never reach another client's data.
//  - /api/clients/:id/portal*  how STAFF give and remove a CRM contact's portal access.
export const portalRoutes = new Hono<Env>();
export const portalAdminRoutes = new Hono<Env>();

const TOKEN_HOURS = 72;

portalRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code }, e.status as 400);
  throw e;
});
portalAdminRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code }, e.status as 400);
  throw e;
});

/** A client user with a ready session and the given right. */
const clientGuard = (right: string): MiddlewareHandler<Env> => async (c, next) => {
  const a = c.get("auth");
  if (!a || a.stage !== "ready") return c.json({ error: "unauthorized" }, 401);
  if (a.user.kind !== "client" || !a.user.clientId || !a.rights.includes("clientportal.view") || !a.rights.includes(right)) return c.json({ error: "forbidden" }, 403);
  await next();
};
const clientOf = (c: Parameters<typeof auth>[0]) => auth(c).user.clientId as string;

// ------------------------------------------------------------------ Client side
portalRoutes.get("/me", clientGuard("clientportal.view"), async (c) => {
  const a = auth(c);
  const cl = (await pool.query("select id, name, email, phone, address, city, province, postal_code from clients where id = $1", [a.user.clientId])).rows[0];
  const balance = (await pool.query(`${WITH_PAID} select coalesce(sum(round(total*100) - paid_cents),0) as b, count(*) filter (where view = 'overdue')::int as late from v where client_id = $2 and view in ('open','overdue','partial')`, [todayISO(), a.user.clientId])).rows[0];
  return c.json({ client: camel(cl), balance: Number(balance.b) / 100, overdueCount: balance.late });
});

portalRoutes.get("/board", clientGuard("clientportal.board.view"), async (c) => {
  const r = await pool.query(
    `select m.id, m.title, m.body, m.pinned, m.created_at, u.name as author_name
       from messages m left join users u on u.id = m.author_id
      where m.audience = 'all' or exists (select 1 from message_targets t where t.message_id = m.id and t.client_id = $1)
      order by m.pinned desc, m.created_at desc limit 100`, [clientOf(c)]);
  return c.json(camelRows(r));
});

portalRoutes.get("/invoices", clientGuard("clientportal.invoices.view"), async (c) => {
  const status = c.req.query("status") ?? "";
  const r = await pool.query(
    `${WITH_PAID} select id, number, issue_date, due_date, po_number, total, paid_cents, view from v
      where client_id = $2 and view in ('open','overdue','partial','paid') and ($3 = '' or ($3 = 'open' and view in ('open','overdue','partial')) or view = $3)
      order by issue_date desc, length(number) desc, number desc limit 500`, [todayISO(), clientOf(c), ["open", "paid", "overdue", "partial"].includes(status) ? status : ""]);
  const rows = camelRows<{ total: string; paidCents: string }>(r).map((x) => ({ ...x, paidCents: undefined, paid: Number(x.paidCents) / 100, balance: roundCents(Number(x.total) - Number(x.paidCents) / 100) }));
  return c.json(rows);
});

portalRoutes.get("/invoices/:id", clientGuard("clientportal.invoices.view"), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new Fail(404, "not_found");
  // Ownership is checked before any detail is built; a draft or voided invoice is never shown.
  const own = (await pool.query("select 1 from invoices where id = $1 and client_id = $2 and status in ('sent','paid')", [id, clientOf(c)])).rowCount;
  if (!own) throw new Fail(404, "not_found");
  const d = (await invoiceDetail(id)) as Record<string, unknown> & { lines: Record<string, unknown>[]; payments: Record<string, unknown>[] };
  const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return c.json({
    ...pick(d, ["id", "number", "clientName", "issueDate", "dueDate", "poNumber", "notes", "subtotal", "gst", "qst", "total", "paid", "balance", "view", "address", "city", "province", "postalCode"]),
    lines: d.lines.map((l) => pick(l, ["id", "description", "quantity", "unitPrice", "taxable", "amount"])),
    payments: d.payments.map((p) => pick(p, ["id", "paidOn", "amountCents", "method", "reference"])),
  });
});

portalRoutes.get("/statement", clientGuard("clientportal.invoices.view"), async (c) => c.json(await statementOf(clientOf(c))));

portalRoutes.get("/contracts", clientGuard("clientportal.contracts.view"), async (c) => {
  const r = await pool.query(
    `select id, name, kind, amount, hourly_rate, cycle, billing_period, starts_on, ends_on, status, bank_hours from client_contracts
      where client_id = $1 and (status <> 'ended' or ends_on >= current_date - 365) order by status, lower(name)`, [clientOf(c)]);
  return c.json(camelRows(r));
});

// ------------------------------------------------------------------ Staff side: give and remove portal access
const MANAGE = requirePermission("clients.users.manage");
const PORTAL_VIEW = requirePermission("clients.users.manage", "clients.contacts.view", "clients.view");

async function issueLink(userId: string): Promise<string> {
  const token = randomToken();
  await pool.query("delete from password_tokens where user_id = $1 and used_at is null", [userId]);
  await pool.query("insert into password_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' hours')::interval)", [sha256(token), userId, String(TOKEN_HOURS)]);
  return `${config.publicUrl || ""}/set-password?token=${token}`;
}

async function sendWelcome(user: { id: string; name: string; email: string; locale: string }): Promise<{ emailed: boolean; link: string }> {
  const link = await issueLink(user.id);
  if (!(await mailReady())) return { emailed: false, link };
  const m = welcomeMail({ firm: license.current().branding.appName, name: user.name, link, hours: TOKEN_HOURS }, user.locale === "en" ? "en" : "fr");
  const res = await sendMail({ to: [{ email: user.email, name: user.name }], ...m }).catch(() => ({ sent: 0, failed: [{ email: user.email, error: "failed" }] }));
  return { emailed: res.sent > 0, link };
}

/** Contacts of a client with their portal state, and the folder rules given to the whole client. */
portalAdminRoutes.get("/:id/portal", PORTAL_VIEW, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new Fail(404, "not_found");
  const r = await pool.query(
    `select k.id, k.name, k.email, k.title, k.user_id, u.active, u.last_login_at, u.must_change_password
       from client_contacts k left join users u on u.id = k.user_id where k.client_id = $1 order by k.is_primary desc, lower(k.name)`, [id]);
  const rules = await pool.query(
    "select id, drive_id, drive_name, path, level from doc_access where principal_type = 'client' and principal_id = $1 order by drive_name, lower(path)", [id]);
  return c.json({ contacts: camelRows(r), rules: camelRows(rules), mail: await mailReady() });
});

portalAdminRoutes.post("/:id/portal/:cid", MANAGE, async (c) => {
  const id = c.req.param("id"), cid = c.req.param("cid");
  if (!isUuid(id) || !isUuid(cid)) throw new Fail(404, "not_found");
  const lang = (await body(c, z.object({ lang: z.enum(["fr", "en"]).default("fr") }).default({}))).lang;
  const k = (await pool.query("select * from client_contacts where id = $1 and client_id = $2", [cid, id])).rows[0];
  if (!k) throw new Fail(404, "not_found");
  if (!validEmail(k.email)) throw new Fail(400, "contact_email_missing");
  let userId: string = k.user_id;
  if (userId) {
    await pool.query("update users set active = true, name = $2, email = $3 where id = $1 and kind = 'client'", [userId, k.name, k.email.trim()]).catch(() => { throw new Fail(409, "email_used"); });
  } else {
    const taken = (await pool.query("select 1 from users where lower(email) = lower($1)", [k.email.trim()])).rowCount;
    if (taken) throw new Fail(409, "email_used");
    // A random password nobody knows: the contact chooses their own through the emailed link.
    const u = await pool.query(
      "insert into users (kind, client_id, email, name, password_hash, must_change_password, locale) values ('client', $1, $2, $3, $4, false, $5) returning id",
      [id, k.email.trim(), k.name, await hashPassword(temporaryPassword() + randomToken(8)), lang]);
    userId = u.rows[0].id;
    await pool.query("update client_contacts set user_id = $2 where id = $1", [cid, userId]);
    await pool.query("insert into user_groups select $1, g.id from groups g where g.slug = 'client-portal' on conflict do nothing", [userId]);
  }
  const u = (await pool.query("select id, name, email, locale from users where id = $1", [userId])).rows[0];
  const sent = await sendWelcome(u);
  await audit("portal.access_granted", { userId: auth(c).user.id, target: k.email, detail: { clientId: id, emailed: sent.emailed } });
  // The link is returned only when no email could be sent, so staff can pass it on by hand.
  return c.json({ userId, emailed: sent.emailed, link: sent.emailed ? undefined : sent.link }, 201);
});

portalAdminRoutes.delete("/:id/portal/:cid", MANAGE, async (c) => {
  const id = c.req.param("id"), cid = c.req.param("cid");
  if (!isUuid(id) || !isUuid(cid)) throw new Fail(404, "not_found");
  const k = (await pool.query("select user_id, email from client_contacts where id = $1 and client_id = $2", [cid, id])).rows[0];
  if (!k) throw new Fail(404, "not_found");
  if (k.user_id) {
    await pool.query("update users set active = false where id = $1 and kind = 'client' and client_id = $2", [k.user_id, id]);
    await pool.query("delete from sessions where user_id = $1", [k.user_id]);
    await pool.query("delete from password_tokens where user_id = $1", [k.user_id]);
  }
  await audit("portal.access_removed", { userId: auth(c).user.id, target: k.email, detail: { clientId: id } });
  return c.json({ ok: true });
});

/** Same as the invitation, for a contact that already has access (lost link or password). */
portalAdminRoutes.post("/:id/portal/:cid/resend", MANAGE, async (c) => {
  const id = c.req.param("id"), cid = c.req.param("cid");
  if (!isUuid(id) || !isUuid(cid)) throw new Fail(404, "not_found");
  const u = (await pool.query(
    "select u.id, u.name, u.email, u.locale, u.active from client_contacts k join users u on u.id = k.user_id where k.id = $1 and k.client_id = $2", [cid, id])).rows[0];
  if (!u || !u.active) throw new Fail(404, "not_found");
  const sent = await sendWelcome(u);
  await audit("portal.access_resent", { userId: auth(c).user.id, target: u.email });
  return c.json({ emailed: sent.emailed, link: sent.emailed ? undefined : sent.link });
});
