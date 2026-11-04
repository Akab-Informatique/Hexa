import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, buildUpdate, camel, camelRows, can, isUuid } from "./util.ts";

export const clientRoutes = new Hono<Env>();

const Str = z.string().max(500);
const ClientInput = z.object({
  name: z.string().min(1).max(200),
  legalName: Str.optional(), parentId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "inactive", "prospect"]).optional(),
  businessNumber: Str.optional(), fiscalYearEnd: Str.optional(), phone: Str.optional(), email: Str.optional(), website: Str.optional(),
  address: Str.optional(), city: Str.optional(), province: Str.optional(), postalCode: Str.optional(), notes: z.string().max(5000).optional(),
});
const COLS: Record<string, string> = {
  name: "name", legalName: "legal_name", parentId: "parent_id", status: "status", businessNumber: "business_number", fiscalYearEnd: "fiscal_year_end",
  phone: "phone", email: "email", website: "website", address: "address", city: "city", province: "province", postalCode: "postal_code", notes: "notes",
};

clientRoutes.get("/", requirePermission("clients.view"), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const status = c.req.query("status");
  const r = await pool.query(
    `select c.*, p.name as parent_name,
            (select count(*)::int from client_contacts k where k.client_id = c.id) as contact_count,
            (select count(*)::int from tasks t where t.client_id = c.id and t.status <> 'done') as open_tasks
       from clients c left join clients p on p.id = c.parent_id
      where ($1 = '' or c.name ilike '%' || $1 || '%' or c.legal_name ilike '%' || $1 || '%' or c.email ilike '%' || $1 || '%')
        and ($2::text is null or c.status = $2)
      order by lower(c.name)`,
    [q, status && ["active", "inactive", "prospect"].includes(status) ? status : null],
  );
  return c.json(camelRows(r));
});

clientRoutes.post("/", requirePermission("clients.edit"), async (c) => {
  const d = await body(c, ClientInput);
  const r = await pool.query(
    `insert into clients (name, legal_name, parent_id, status, business_number, fiscal_year_end, phone, email, website, address, city, province, postal_code, notes, created_by)
     values ($1, coalesce($2,''), $3, coalesce($4,'active'), coalesce($5,''), coalesce($6,''), coalesce($7,''), coalesce($8,''), coalesce($9,''), coalesce($10,''), coalesce($11,''), coalesce($12,''), coalesce($13,''), coalesce($14,''), $15)
     returning id`,
    [d.name, d.legalName, d.parentId ?? null, d.status, d.businessNumber, d.fiscalYearEnd, d.phone, d.email, d.website, d.address, d.city, d.province, d.postalCode, d.notes, auth(c).user.id],
  );
  await audit("client.created", { userId: auth(c).user.id, target: d.name });
  return c.json({ id: r.rows[0].id }, 201);
});

clientRoutes.get("/:id", requirePermission("clients.view"), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const r = await pool.query("select c.*, p.name as parent_name from clients c left join clients p on p.id = c.parent_id where c.id = $1", [id]);
  if (!r.rows[0]) return c.json({ error: "not found" }, 404);
  const [contacts, contracts, children] = await Promise.all([
    can(c, "clients.contacts.view") ? pool.query("select * from client_contacts where client_id = $1 order by is_primary desc, lower(name)", [id]) : { rows: [] },
    can(c, "clients.contracts.view") ? pool.query("select * from client_contracts where client_id = $1 order by status, created_at desc", [id]) : { rows: [] },
    pool.query("select id, name, status from clients where parent_id = $1 order by lower(name)", [id]),
  ]);
  return c.json({ ...camel(r.rows[0]), contacts: camelRows(contacts), contracts: camelRows(contracts), children: camelRows(children) });
});

clientRoutes.patch("/:id", requirePermission("clients.edit"), async (c) => {
  const id = c.req.param("id");
  const d = await body(c, ClientInput.partial());
  // Deactivating or re-parenting is a "manage" action (reference rule: a client with history is never deleted).
  if ((d.status !== undefined || d.parentId !== undefined) && !can(c, "clients.manage")) return c.json({ error: "forbidden" }, 403);
  if (d.parentId === id) return c.json({ error: "a client cannot be its own parent" }, 400);
  const { sets, values } = buildUpdate(d, COLS, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const r = await pool.query(`update clients set ${sets.join(", ")}, updated_at = now() where id = $1 returning id`, [id, ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

clientRoutes.delete("/:id", requirePermission("clients.manage"), async (c) => {
  const id = c.req.param("id");
  const used = await pool.query(
    `select (select count(*) from invoices where client_id = $1) + (select count(*) from billing_items where client_id = $1)
          + (select count(*) from tasks where client_id = $1) + (select count(*) from timesheet_entries where client_id = $1) as n`, [id]);
  if (used.rows[0].n > 0) return c.json({ error: "this client has history; deactivate it instead" }, 409);
  await pool.query("delete from clients where id = $1", [id]);
  await audit("client.deleted", { userId: auth(c).user.id, target: id });
  return c.json({ ok: true });
});

// ---------------- Contacts ----------------
const ContactInput = z.object({
  name: z.string().min(1).max(200), email: Str.optional(), phone: Str.optional(), title: Str.optional(),
  isPrimary: z.boolean().optional(), isBilling: z.boolean().optional(), notes: Str.optional(),
});

clientRoutes.post("/:id/contacts", requirePermission("clients.contacts.edit"), async (c) => {
  const clientId = c.req.param("id");
  const d = await body(c, ContactInput);
  if (d.isPrimary) await pool.query("update client_contacts set is_primary = false where client_id = $1", [clientId]);
  // The first contact of a client becomes its primary contact automatically.
  const first = (await pool.query("select count(*)::int as n from client_contacts where client_id = $1", [clientId])).rows[0].n === 0;
  const r = await pool.query(
    `insert into client_contacts (client_id, name, email, phone, title, is_primary, is_billing, notes)
     values ($1, $2, coalesce($3,''), coalesce($4,''), coalesce($5,''), $6, coalesce($7,false), coalesce($8,'')) returning id`,
    [clientId, d.name, d.email, d.phone, d.title, d.isPrimary ?? first, d.isBilling, d.notes],
  );
  return c.json({ id: r.rows[0].id }, 201);
});

clientRoutes.patch("/contacts/:cid", requirePermission("clients.contacts.edit"), async (c) => {
  const cid = c.req.param("cid");
  const d = await body(c, ContactInput.partial());
  if (d.isPrimary) {
    const row = (await pool.query("select client_id from client_contacts where id = $1", [cid])).rows[0];
    if (row) await pool.query("update client_contacts set is_primary = false where client_id = $1", [row.client_id]);
  }
  const { sets, values } = buildUpdate(d, { name: "name", email: "email", phone: "phone", title: "title", isPrimary: "is_primary", isBilling: "is_billing", notes: "notes" }, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const r = await pool.query(`update client_contacts set ${sets.join(", ")} where id = $1 returning id`, [cid, ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

clientRoutes.delete("/contacts/:cid", requirePermission("clients.contacts.edit"), async (c) => {
  await pool.query("delete from client_contacts where id = $1", [c.req.param("cid")]);
  return c.json({ ok: true });
});

// ---------------- Contracts ----------------
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const ContractInput = z.object({
  name: z.string().min(1).max(200), kind: z.enum(["recurring", "hourly", "fixed", "hours_bank"]).optional(),
  amount: z.number().min(0).max(1e9).optional(), hourlyRate: z.number().min(0).max(1e6).nullable().optional(),
  cycle: z.enum(["monthly", "quarterly", "yearly", "one_time"]).optional(), startsOn: Day.optional(), endsOn: Day.optional(),
  status: z.enum(["active", "paused", "ended"]).optional(), notes: z.string().max(5000).optional(),
});
const CCOLS = { name: "name", kind: "kind", amount: "amount", hourlyRate: "hourly_rate", cycle: "cycle", startsOn: "starts_on", endsOn: "ends_on", status: "status", notes: "notes" };

clientRoutes.post("/:id/contracts", requirePermission("clients.contracts.edit"), async (c) => {
  const d = await body(c, ContractInput);
  const r = await pool.query(
    `insert into client_contracts (client_id, name, kind, amount, hourly_rate, cycle, starts_on, ends_on, status, notes)
     values ($1, $2, coalesce($3,'recurring'), coalesce($4,0), $5, coalesce($6,'monthly'), $7, $8, coalesce($9,'active'), coalesce($10,'')) returning id`,
    [c.req.param("id"), d.name, d.kind, d.amount, d.hourlyRate ?? null, d.cycle, d.startsOn ?? null, d.endsOn ?? null, d.status, d.notes],
  );
  return c.json({ id: r.rows[0].id }, 201);
});

clientRoutes.patch("/contracts/:cid", requirePermission("clients.contracts.edit"), async (c) => {
  const d = await body(c, ContractInput.partial());
  const { sets, values } = buildUpdate(d, CCOLS, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const r = await pool.query(`update client_contracts set ${sets.join(", ")} where id = $1 returning id`, [c.req.param("cid"), ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

clientRoutes.delete("/contracts/:cid", requirePermission("clients.contracts.edit"), async (c) => {
  await pool.query("delete from client_contracts where id = $1", [c.req.param("cid")]);
  return c.json({ ok: true });
});
