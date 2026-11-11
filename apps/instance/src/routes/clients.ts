import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { chargesFor, monthlyEquivalentCents } from "@hexa/shared/contractCharges";
import { canAttach, centsToDecimal, checkSale, isValidDay, MAX_PRICE_CENTS, type ServiceKindDb } from "@hexa/shared/productSale";
import { todayISO } from "@hexa/shared/billing";
import { pool, getSetting, setSetting } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { applyAutoApprove } from "../lib/autoApprove.ts";
import { autoTasksSoon } from "../lib/autoTasks.ts";
import { uuidFromKey } from "../lib/billingKeys.ts";
import { linesOf, refreshContractBilling } from "../lib/contractBilling.ts";
import { auth, body, buildUpdate, camel, camelRows, can, isUuid } from "./util.ts";

export const clientRoutes = new Hono<Env>();

class Fail extends Error { constructor(public status: number, public code: string, public extra?: object) { super(code); } }
clientRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code, ...e.extra }, e.status as 400);
  throw e;
});
type Ctx = Context<Env>;

const Str = z.string().max(500);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ClientInput = z.object({
  name: z.string().min(1).max(200),
  legalName: Str.optional(), parentId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "inactive", "prospect"]).optional(),
  businessNumber: Str.optional(), fiscalYearEnd: Str.optional(), phone: Str.optional(), email: Str.optional(), website: Str.optional(),
  address: Str.optional(), city: Str.optional(), province: Str.optional(), postalCode: Str.optional(), notes: z.string().max(5000).optional(),
  classKey: z.string().max(40).nullable().optional(),
  identificationNumber: Str.optional(), neq: Str.optional(), ccq: Str.optional(), rbq: Str.optional(),
  taxFrequency: z.enum(["", "monthly", "quarterly", "annual"]).optional(), taxDate: Str.optional(),
  dasFrequency: z.enum(["", "monthly", "quarterly", "annual"]).optional(), dasDate: Str.optional(),
  software: Str.optional(),
  contactName: Str.optional(), // create only: becomes the client's primary contact
});
const BillingInput = z.object({
  billingEmail: z.string().max(200).optional(), termsDays: z.number().int().min(0).max(365).nullable().optional(), poRequired: z.boolean().optional(),
  autoApproveKinds: z.array(z.enum(["time", "expense", "contract", "manual"])).max(4).optional(), invoiceNotes: z.string().max(2000).optional(),
});
const COLS: Record<string, string> = {
  name: "name", legalName: "legal_name", parentId: "parent_id", status: "status", businessNumber: "business_number", fiscalYearEnd: "fiscal_year_end",
  phone: "phone", email: "email", website: "website", address: "address", city: "city", province: "province", postalCode: "postal_code", notes: "notes", classKey: "class_key",
  identificationNumber: "identification_number", neq: "neq", ccq: "ccq", rbq: "rbq", taxFrequency: "tax_frequency", taxDate: "tax_date",
  dasFrequency: "das_frequency", dasDate: "das_date", software: "software",
};
const BCOLS: Record<string, string> = { billingEmail: "billing_email", termsDays: "terms_days", poRequired: "po_required", autoApproveKinds: "auto_approve_kinds", invoiceNotes: "invoice_notes" };

// ------------------------------------------------------------------ Static lookups (before /:id)
clientRoutes.get("/classes", requirePermission("clients.view"), async (c) => c.json(camelRows(await pool.query("select * from client_classes order by position, key"))));

const TABS = ["info", "contacts", "contracts", "tasks", "invoices", "billing", "tracking"];
clientRoutes.get("/tab-order", requirePermission("clients.view"), async (c) => {
  const saved = (await getSetting<string[]>("crm.tabOrder")) ?? [];
  // A tab the saved order does not name goes at the end.
  return c.json({ order: [...saved.filter((k) => TABS.includes(k)), ...TABS.filter((k) => !saved.includes(k))] });
});
clientRoutes.put("/tab-order", requirePermission("clients.layout.manage"), async (c) => {
  const d = await body(c, z.object({ order: z.array(z.string()).max(20).nullable() }));
  await setSetting("crm.tabOrder", d.order ? d.order.filter((k) => TABS.includes(k)) : []);
  await audit("crm.tab_order", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ List
clientRoutes.get("/", requirePermission("clients.view"), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const status = c.req.query("status");
  const cls = c.req.query("class");
  const sort = c.req.query("sort") === "contracts" ? "contract_count" : c.req.query("sort") === "billing" ? "billing_email" : "lower(c.name)";
  const dir = c.req.query("dir") === "desc" ? "desc" : "asc";
  const paged = c.req.query("page") !== undefined;
  const size = Math.min(100, Math.max(5, Number(c.req.query("size")) || 25));
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const where = `($1 = '' or c.name ilike '%' || $1 || '%' or c.legal_name ilike '%' || $1 || '%' or c.email ilike '%' || $1 || '%')
        and ($2::text is null or c.status = $2) and ($3::text is null or c.class_key = $3)`;
  const params = [q, status && ["active", "inactive", "prospect"].includes(status) ? status : null, cls || null];
  const r = await pool.query(
    `select c.*, p.name as parent_name, k.label_fr as class_label_fr, k.label_en as class_label_en, k.color as class_color,
            (select count(*)::int from client_contacts k2 where k2.client_id = c.id) as contact_count,
            (select count(*)::int from client_contracts q where q.client_id = c.id and q.status = 'active') as contract_count,
            (select count(*)::int from tasks t where t.client_id = c.id and t.status <> 'done') as open_tasks
       from clients c left join clients p on p.id = c.parent_id left join client_classes k on k.key = c.class_key
      where ${where} order by ${sort} ${dir}, lower(c.name) ${paged ? `limit ${size} offset ${(page - 1) * size}` : ""}`, params);
  if (!paged) return c.json(camelRows(r));
  const total = Number((await pool.query(`select count(*) as n from clients c where ${where}`, params)).rows[0].n);
  return c.json({ rows: camelRows(r), total, page, size });
});

clientRoutes.post("/", requirePermission("clients.edit"), async (c) => {
  const d = await body(c, ClientInput);
  const r = await pool.query(
    `insert into clients (name, legal_name, parent_id, status, business_number, fiscal_year_end, phone, email, website, address, city, province, postal_code, notes, class_key, created_by,
       identification_number, neq, ccq, rbq, tax_frequency, tax_date, das_frequency, das_date, software)
     values ($1, coalesce($2,''), $3, coalesce($4,'active'), coalesce($5,''), coalesce($6,''), coalesce($7,''), coalesce($8,''), coalesce($9,''), coalesce($10,''), coalesce($11,''), coalesce($12,''), coalesce($13,''), coalesce($14,''), $15, $16,
       coalesce($17,''), coalesce($18,''), coalesce($19,''), coalesce($20,''), coalesce($21,''), coalesce($22,''), coalesce($23,''), coalesce($24,''), coalesce($25,''))
     returning id`,
    [d.name, d.legalName, d.parentId ?? null, d.status, d.businessNumber, d.fiscalYearEnd, d.phone, d.email, d.website, d.address, d.city, d.province, d.postalCode, d.notes, d.classKey ?? null, auth(c).user.id,
      d.identificationNumber, d.neq, d.ccq, d.rbq, d.taxFrequency, d.taxDate, d.dasFrequency, d.dasDate, d.software],
  );
  if (d.contactName?.trim()) {
    await pool.query("insert into client_contacts (client_id, name, email, phone, is_primary) values ($1, $2, $3, $4, true)", [r.rows[0].id, d.contactName.trim(), d.email ?? "", d.phone ?? ""]);
  }
  autoTasksSoon(r.rows[0].id);
  await audit("client.created", { userId: auth(c).user.id, target: d.name });
  return c.json({ id: r.rows[0].id }, 201);
});

// ------------------------------------------------------------------ Contracts across clients (before /:id)
clientRoutes.get("/contracts/all", requirePermission("clients.contracts.view"), async (c) => {
  const st = c.req.query("status") ?? "active";
  const q = (c.req.query("q") ?? "").trim();
  const r = await pool.query(
    `select k.*, cl.name as client_name from client_contracts k join clients cl on cl.id = k.client_id
      where ($1 = 'all' or ($1 = 'active' and k.status = 'active') or ($1 = 'inactive' and k.status <> 'active'))
        and ($2 = '' or k.name ilike '%' || $2 || '%' or cl.name ilike '%' || $2 || '%') order by lower(cl.name), k.created_at desc`, [st, q]);
  const svc = await pool.query("select contract_id, kind, unit_price_cents, quantity from contract_services");
  return c.json(camelRows(r).map((k: any) => {
    const lines = svc.rows.filter((s) => s.contract_id === k.id).map((s) => ({ kind: s.kind, priceCents: s.unit_price_cents, quantity: Number(s.quantity) }));
    const monthlyCents = lines.length ? monthlyEquivalentCents(lines, k.billingPeriod) : k.cycle === "monthly" ? Math.round(Number(k.amount) * 100) : 0;
    return { ...k, monthlyCents, serviceCount: lines.length };
  }));
});

/** Work to bill from contract services, once per charge (see lib/contractBilling.ts). */
clientRoutes.post("/contracts/refresh-billing", requirePermission("accounting.approvals.manage", "clients.billing.manage"), async (c) => {
  const created = await refreshContractBilling();
  await audit("contracts.billing_refreshed", { userId: auth(c).user.id, detail: { created } });
  return c.json({ created });
});

async function contractRow(id: string) {
  if (!isUuid(id)) throw new Fail(404, "not_found");
  const k = (await pool.query("select k.*, cl.name as client_name from client_contracts k join clients cl on cl.id = k.client_id where k.id = $1", [id])).rows[0];
  if (!k) throw new Fail(404, "not_found");
  return k;
}
async function logEvent(contractId: string, kind: string, detail: string, userId: string) {
  await pool.query("insert into contract_events (contract_id, kind, detail, user_id) values ($1,$2,$3,$4)", [contractId, kind, detail, userId]);
}

clientRoutes.get("/contracts/:cid", requirePermission("clients.contracts.view"), async (c) => {
  const k = await contractRow(c.req.param("cid"));
  const lines = await linesOf(k.id);
  const today = todayISO();
  const until = `${Number(today.slice(0, 4)) + 2}${today.slice(4)}`;
  const charges = chargesFor({ billingPeriod: k.billing_period, startsOn: k.starts_on, endsOn: k.ends_on }, lines, until).map((ch) => ({
    ...ch, billed: Boolean(k.billed_through && ch.date <= k.billed_through), due: ch.date <= today,
  }));
  const events = await pool.query("select e.kind, e.detail, e.created_at, u.name as user_name from contract_events e left join users u on u.id = e.user_id where e.contract_id = $1 order by e.created_at desc limit 100", [k.id]);
  const billed = Number((await pool.query("select count(*) as n from billing_items where contract_id = $1 and status = 'invoiced'", [k.id])).rows[0].n);
  const services = (await pool.query("select * from contract_services where contract_id = $1 order by added_on, created_at", [k.id])).rows;
  const next = charges.find((ch) => !ch.due && !ch.billed);
  return c.json({
    ...camel(k), services: camelRows({ rows: services }), charges, events: camelRows(events), invoicedLines: billed,
    monthlyCents: monthlyEquivalentCents(lines, k.billing_period), nextCharge: next ?? null,
    dueCents: charges.filter((ch) => ch.due && !ch.billed).reduce((a, ch) => a + ch.cents, 0),
  });
});

const ContractInput = z.object({
  name: z.string().min(1).max(200), kind: z.enum(["recurring", "hourly", "fixed", "hours_bank"]).optional(),
  amount: z.number().min(0).max(1e9).optional(), hourlyRate: z.number().min(0).max(1e6).nullable().optional(),
  cycle: z.enum(["monthly", "quarterly", "yearly", "one_time"]).optional(), startsOn: Day.nullable().optional(), endsOn: Day.nullable().optional(),
  status: z.enum(["active", "paused", "ended"]).optional(), notes: z.string().max(5000).optional(),
  billingPeriod: z.enum(["monthly", "yearly"]).optional(), billedThrough: Day.nullable().optional(), supportDefault: z.boolean().optional(), bankHours: z.number().min(0).max(100000).nullable().optional(),
});
const CCOLS = { name: "name", kind: "kind", amount: "amount", hourlyRate: "hourly_rate", cycle: "cycle", startsOn: "starts_on", endsOn: "ends_on", status: "status", notes: "notes", billingPeriod: "billing_period", billedThrough: "billed_through", supportDefault: "support_default", bankHours: "bank_hours" };
/** Rates, amounts and what counts as already invoiced are billing matters: they have their own right. */
const BILLING_FIELDS = ["amount", "hourlyRate", "billingPeriod", "billedThrough", "bankHours"];

clientRoutes.post("/:id/contracts", requirePermission("clients.contracts.edit"), async (c) => {
  const d = await body(c, ContractInput);
  const touched = BILLING_FIELDS.filter((f) => (d as Record<string, unknown>)[f] !== undefined);
  if (touched.length && !can(c, "clients.billing.manage")) throw new Fail(403, "forbidden");
  const start = d.startsOn ?? todayISO();
  if (d.endsOn && d.endsOn < start) throw new Fail(400, "contract_dates");
  const clientId = c.req.param("id");
  if (d.supportDefault) await pool.query("update client_contracts set support_default = false where client_id = $1", [clientId]);
  const r = await pool.query(
    `insert into client_contracts (client_id, name, kind, amount, hourly_rate, cycle, starts_on, ends_on, status, notes, billing_period, billed_through, support_default, bank_hours)
     values ($1,$2,coalesce($3,'recurring'),coalesce($4,0),$5,coalesce($6,'monthly'),$7,$8,coalesce($9,'active'),coalesce($10,''),coalesce($11,'monthly'),$12,coalesce($13,false),$14) returning id`,
    [clientId, d.name, d.kind, d.amount, d.hourlyRate ?? null, d.cycle, start, d.endsOn ?? null, d.status, d.notes, d.billingPeriod, d.billedThrough ?? null, d.supportDefault, d.bankHours ?? null]);
  await logEvent(r.rows[0].id, "created", d.name, auth(c).user.id);
  return c.json({ id: r.rows[0].id }, 201);
});

clientRoutes.patch("/contracts/:cid", requirePermission("clients.contracts.edit"), async (c) => {
  const k = await contractRow(c.req.param("cid"));
  const d = await body(c, ContractInput.partial());
  if (BILLING_FIELDS.some((f) => (d as Record<string, unknown>)[f] !== undefined) && !can(c, "clients.billing.manage")) throw new Fail(403, "forbidden");
  const start = d.startsOn ?? k.starts_on, end = d.endsOn !== undefined ? d.endsOn : k.ends_on;
  if (end && start && end < start) throw new Fail(400, "contract_dates");
  // A date that would leave a service out of the term is refused.
  const out = await pool.query("select 1 from contract_services where contract_id = $1 and (($2::date is not null and added_on < $2) or ($3::date is not null and added_on > $3)) limit 1", [k.id, d.startsOn ?? null, d.endsOn ?? null]);
  if (out.rowCount) throw new Fail(409, "contract_dates_services");
  if (d.supportDefault) await pool.query("update client_contracts set support_default = false where client_id = $1 and id <> $2", [k.client_id, k.id]);
  const { sets, values } = buildUpdate(d, CCOLS, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  await pool.query(`update client_contracts set ${sets.join(", ")} where id = $1`, [k.id, ...values]);
  const stop = d.status && d.status !== k.status;
  await logEvent(k.id, stop ? (d.status === "active" ? "resumed" : "stopped") : "updated", Object.keys(d).join(", "), auth(c).user.id);
  return c.json({ ok: true });
});

clientRoutes.delete("/contracts/:cid", requirePermission("clients.contracts.edit"), async (c) => {
  const k = await contractRow(c.req.param("cid"));
  // Billing started: the contract is stopped, never deleted (its history stays on record).
  const started = Number((await pool.query("select count(*) as n from billing_items where contract_id = $1", [k.id])).rows[0].n);
  if (started > 0) throw new Fail(409, "contract_billed");
  await pool.query("delete from client_contracts where id = $1", [k.id]);
  await audit("contract.deleted", { userId: auth(c).user.id, target: k.name });
  return c.json({ ok: true });
});

// ---- Services on a contract
// Money is integer cents. A line keeps its own price (override of the catalogue price), start, optional end and period.
const PriceCents = z.number().int().min(0).max(MAX_PRICE_CENTS);
const LineInput = z.object({
  serviceId: z.string().uuid().nullable().optional(), name: z.string().trim().min(1).max(200).optional(), kind: z.enum(["monthly", "quarterly", "yearly", "one_time"]).optional(),
  priceCents: PriceCents.optional(), quantity: z.number().min(0.01).max(100000).optional(), addedOn: Day.optional(), endsOn: Day.nullable().optional(),
});

async function assertInTerm(k: Record<string, any>, day: string) {
  if (!isValidDay(day) || day < k.starts_on || (k.ends_on && day > k.ends_on)) throw new Fail(400, "service_outside_term");
}
async function assertClientOpen(clientId: string) {
  const cl = (await pool.query("select name, status from clients where id = $1", [clientId])).rows[0];
  if (!cl) throw new Fail(404, "not_found");
  if (cl.status === "inactive") throw new Fail(409, "client_inactive");
  return cl as { name: string; status: string };
}
/** A catalogue service that can be newly attached: active and recurring. Lines already attached are never checked again (they keep billing). */
async function attachableService(id: string) {
  const s = (await pool.query("select name, kind, price_cents, active from services where id = $1", [id])).rows[0];
  if (!s) throw new Fail(404, "service_not_found");
  if (!s.active) throw new Fail(409, "service_inactive");
  if (!canAttach({ active: s.active, kind: s.kind as ServiceKindDb })) throw new Fail(409, "service_is_product");
  return s as { name: string; kind: ServiceKindDb; price_cents: number };
}

clientRoutes.post("/contracts/:cid/services", requirePermission("clients.contracts.edit"), async (c) => {
  const k = await contractRow(c.req.param("cid"));
  if (k.kind !== "recurring") throw new Fail(409, "contract_not_recurring");
  await assertClientOpen(k.client_id);
  const d = await body(c, LineInput);
  let name = d.name, kind = d.kind, price = d.priceCents;
  if (d.serviceId) {
    const s = await attachableService(d.serviceId);
    name ??= s.name; kind ??= s.kind; price ??= s.price_cents;
  }
  if (!name) throw new Fail(400, "name_required");
  if (d.priceCents !== undefined && !can(c, "clients.billing.manage")) throw new Fail(403, "forbidden");
  const day = d.addedOn ?? (todayISO() < k.starts_on ? k.starts_on : todayISO());
  await assertInTerm(k, day);
  if (d.endsOn && (!isValidDay(d.endsOn) || d.endsOn < day)) throw new Fail(400, "service_dates");
  const r = await pool.query(
    "insert into contract_services (contract_id, service_id, name, kind, unit_price_cents, quantity, added_on, ends_on) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [k.id, d.serviceId ?? null, name, kind ?? "monthly", price ?? 0, d.quantity ?? 1, day, d.endsOn ?? null]);
  await logEvent(k.id, "service_added", `${name} × ${d.quantity ?? 1}`, auth(c).user.id);
  await audit("contract.service_attached", { userId: auth(c).user.id, target: k.client_name, detail: { contractId: k.id, lineId: r.rows[0].id, serviceId: d.serviceId ?? null, priceCents: price ?? 0, startsOn: day, endsOn: d.endsOn ?? null } });
  return c.json({ id: r.rows[0].id }, 201);
});

clientRoutes.patch("/contracts/:cid/services/:sid", requirePermission("clients.contracts.edit"), async (c) => {
  const k = await contractRow(c.req.param("cid"));
  const sid = c.req.param("sid");
  if (!isUuid(sid)) throw new Fail(404, "not_found");
  const d = await body(c, LineInput.pick({ priceCents: true, quantity: true, addedOn: true, endsOn: true }));
  if (d.priceCents !== undefined && !can(c, "clients.billing.manage")) throw new Fail(403, "forbidden");
  if (d.addedOn) await assertInTerm(k, d.addedOn);
  const endsSet = d.endsOn !== undefined;
  if (d.endsOn && !isValidDay(d.endsOn)) throw new Fail(400, "service_dates");
  const r = await pool.query(
    `update contract_services set unit_price_cents = coalesce($3, unit_price_cents), quantity = coalesce($4, quantity), added_on = coalesce($5, added_on),
            ends_on = case when $6 then $7::date else ends_on end
      where id = $2 and contract_id = $1 and (not $6 or $7::date is null or $7::date >= coalesce($5::date, added_on)) returning name`,
    [k.id, sid, d.priceCents ?? null, d.quantity ?? null, d.addedOn ?? null, endsSet, d.endsOn ?? null]);
  if (!r.rowCount) throw new Fail(404, "not_found");
  await logEvent(k.id, "service_changed", r.rows[0].name, auth(c).user.id);
  await audit("contract.service_changed", { userId: auth(c).user.id, target: k.client_name, detail: { contractId: k.id, lineId: sid, priceCents: d.priceCents ?? null, endsOn: d.endsOn ?? null } });
  return c.json({ ok: true });
});

clientRoutes.delete("/contracts/:cid/services/:sid", requirePermission("clients.contracts.edit"), async (c) => {
  const k = await contractRow(c.req.param("cid"));
  const sid = c.req.param("sid");
  if (!isUuid(sid)) throw new Fail(404, "not_found");
  const r = await pool.query("delete from contract_services where id = $2 and contract_id = $1 returning name", [k.id, sid]);
  if (r.rowCount) { await logEvent(k.id, "service_removed", r.rows[0].name, auth(c).user.id); await audit("contract.service_removed", { userId: auth(c).user.id, target: k.client_name, detail: { contractId: k.id, lineId: sid } }); }
  return c.json({ ok: true });
});

// ---- Fixed recurring service attached straight to a client (client page): it lives on the client's "Services à prix fixe" contract,
// found (or created) here, so the existing billing refresh creates its to-bill lines.
const AttachInput = z.object({ serviceId: z.string().uuid(), priceCents: PriceCents.optional(), quantity: z.number().min(0.01).max(1000).optional(), startsOn: Day, endsOn: Day.nullable().optional() }).strict();
const AUTO_CONTRACT = "Services à prix fixe";

clientRoutes.post("/:id/services", requirePermission("clients.contracts.edit"), async (c) => {
  const clientId = c.req.param("id");
  if (!isUuid(clientId)) throw new Fail(404, "not_found");
  const d = await body(c, AttachInput);
  const cl = await assertClientOpen(clientId);
  if (d.priceCents !== undefined && !can(c, "clients.billing.manage")) throw new Fail(403, "forbidden");
  if (!isValidDay(d.startsOn) || (d.endsOn && (!isValidDay(d.endsOn) || d.endsOn < d.startsOn))) throw new Fail(400, "service_dates");
  const s = await attachableService(d.serviceId);
  const price = d.priceCents ?? s.price_cents;
  let k = (await pool.query(
    `select id, starts_on from client_contracts where client_id = $1 and kind = 'recurring' and status = 'active' and name = $2 and starts_on <= $3
        and (ends_on is null or ($4::date is not null and ends_on >= $4::date)) order by created_at limit 1`, [clientId, AUTO_CONTRACT, d.startsOn, d.endsOn ?? null])).rows[0];
  if (!k) {
    k = (await pool.query("insert into client_contracts (client_id, name, kind, cycle, starts_on, billing_period) values ($1,$2,'recurring','monthly',$3,'monthly') returning id, starts_on", [clientId, AUTO_CONTRACT, d.startsOn])).rows[0];
    await logEvent(k.id, "created", AUTO_CONTRACT, auth(c).user.id);
  }
  const r = await pool.query(
    "insert into contract_services (contract_id, service_id, name, kind, unit_price_cents, quantity, added_on, ends_on) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [k.id, d.serviceId, s.name, s.kind, price, d.quantity ?? 1, d.startsOn, d.endsOn ?? null]);
  await logEvent(k.id, "service_added", `${s.name} × ${d.quantity ?? 1}`, auth(c).user.id);
  await audit("contract.service_attached", { userId: auth(c).user.id, target: cl.name, detail: { contractId: k.id, lineId: r.rows[0].id, serviceId: d.serviceId, priceCents: price, startsOn: d.startsOn, endsOn: d.endsOn ?? null } });
  // The first charge may already be due: make it now (idempotent, only this client).
  const created = await refreshContractBilling(clientId).catch(() => 0);
  return c.json({ id: r.rows[0].id, contractId: k.id, created }, 201);
});

// ---- Products: a one-time sale to a client = ONE line of work to bill (source 'manual', service_id set), pending in the approvals queue.
// Idempotency: the form sends a random `idempotencyKey` (kept for the life of the dialog); the line's source_id is a hash of client + key, so
// a double click or a retry returns the same line (200, duplicate: true) instead of selling twice. Without a key, an identical sale
// (same client, product, quantity, price, note) by the same person within 10 seconds is refused (409 duplicate_recent).
// Selling the same product twice on purpose = two different keys = two lines.
const SaleInput = z.object({
  serviceId: z.string().uuid(), quantity: z.number().optional(), priceCents: PriceCents.optional(),
  note: z.string().trim().max(300).optional(), date: Day.optional(), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/).optional(),
}).strict();

clientRoutes.post("/:id/products", requirePermission("clients.billing.manage"), async (c) => {
  const clientId = c.req.param("id");
  if (!isUuid(clientId)) throw new Fail(404, "not_found");
  const d = await body(c, SaleInput);
  const cl = await assertClientOpen(clientId);
  const s = (await pool.query("select name, kind, price_cents, active, taxable from services where id = $1", [d.serviceId])).rows[0];
  if (!s) throw new Fail(404, "service_not_found");
  const sale = checkSale({ active: s.active, kind: s.kind }, d.priceCents ?? s.price_cents, d.quantity ?? 1);
  if ("error" in sale) throw new Fail(sale.error === "service_inactive" || sale.error === "not_a_product" ? 409 : 400, sale.error);
  const day = d.date ?? todayISO();
  if (!isValidDay(day)) throw new Fail(400, "date_invalid");
  const description = (d.note ? `${s.name} — ${d.note}` : s.name).slice(0, 500);
  const unit = centsToDecimal(sale.unitCents), qty = (sale.qtyHundredths / 100).toFixed(2);
  const user = auth(c).user.id;
  let id: string | null = null, duplicate = false;
  if (d.idempotencyKey) {
    const sourceId = uuidFromKey(`product:${clientId}:${d.idempotencyKey}`);
    const ins = await pool.query(
      `insert into billing_items (client_id, source, source_id, description, quantity, unit_price, work_date, status, created_by, service_id, taxable)
       values ($1,'manual',$2,$3,$4,$5,$6,'pending',$7,$8,$9) on conflict do nothing returning id`, [clientId, sourceId, description, qty, unit, day, user, d.serviceId, s.taxable]);
    id = ins.rows[0]?.id ?? null;
    if (!id) { id = (await pool.query("select id from billing_items where source = 'manual' and source_id = $1 and client_id = $2", [sourceId, clientId])).rows[0]?.id ?? null; duplicate = true; }
  } else {
    const ins = await pool.query(
      `insert into billing_items (client_id, source, description, quantity, unit_price, work_date, status, created_by, service_id, taxable)
       select $1,'manual',$2,$3,$4,$5,'pending',$6,$7,$8
        where not exists (select 1 from billing_items where client_id = $1 and service_id = $7 and created_by = $6 and description = $2 and quantity = $3 and unit_price = $4 and created_at > now() - interval '10 seconds')
       returning id`, [clientId, description, qty, unit, day, user, d.serviceId, s.taxable]);
    id = ins.rows[0]?.id ?? null;
    if (!id) throw new Fail(409, "duplicate_recent");
  }
  if (!duplicate) await audit("product.sold", { userId: user, target: cl.name, detail: { clientId, serviceId: d.serviceId, itemId: id, quantity: Number(qty), unitCents: sale.unitCents, totalCents: sale.totalCents } });
  return c.json({ id, duplicate, totalCents: sale.totalCents }, duplicate ? 200 : 201);
});

/** Products sold to a client and where each one stands (pending / approved / invoiced / excluded). Small payload: last 200. */
clientRoutes.get("/:id/products", requirePermission("clients.billing.manage", "clients.contracts.view"), async (c) => {
  const clientId = c.req.param("id");
  if (!isUuid(clientId)) throw new Fail(404, "not_found");
  const r = await pool.query(
    `select b.id, b.service_id, b.description, b.quantity, b.unit_price, b.status, b.work_date, b.created_at, b.invoice_id, u.name as sold_by, i.number as invoice_number
       from billing_items b left join users u on u.id = b.created_by left join invoices i on i.id = b.invoice_id
      where b.client_id = $1 and b.service_id is not null order by b.created_at desc limit 200`, [clientId]);
  return c.json(r.rows.map((x) => {
    const unit = Math.round(Number(x.unit_price) * 100);
    return { id: x.id, serviceId: x.service_id, description: x.description, quantity: Number(x.quantity), unitPriceCents: unit, totalCents: Math.round((Math.round(Number(x.quantity) * 100) * unit) / 100),
      status: x.status, workDate: x.work_date, createdAt: x.created_at, soldBy: x.sold_by, invoiceId: x.invoice_id, invoiceNumber: x.invoice_number ?? null };
  }));
});

// ------------------------------------------------------------------ One client
clientRoutes.get("/:id", requirePermission("clients.view"), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const r = await pool.query(
    `select c.*, p.name as parent_name, k.label_fr as class_label_fr, k.label_en as class_label_en, k.color as class_color
       from clients c left join clients p on p.id = c.parent_id left join client_classes k on k.key = c.class_key where c.id = $1`, [id]);
  if (!r.rows[0]) return c.json({ error: "not found" }, 404);
  const [contacts, contracts, children] = await Promise.all([
    can(c, "clients.contacts.view") ? pool.query("select * from client_contacts where client_id = $1 order by is_primary desc, lower(name)", [id]) : { rows: [] },
    can(c, "clients.contracts.view") ? pool.query(
      `select k.*, (select count(*)::int from contract_services s where s.contract_id = k.id) as service_count from client_contracts k where k.client_id = $1 order by (k.status = 'active') desc, k.created_at desc`, [id]) : { rows: [] },
    pool.query("select id, name, status from clients where parent_id = $1 order by lower(name)", [id]),
  ]);
  const row = camel<Record<string, unknown>>(r.rows[0]);
  // Billing settings are only for those who may edit them (terms, notes, auto-approval).
  if (!can(c, "clients.billing.manage", "accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage")) { delete row.termsDays; delete row.invoiceNotes; delete row.autoApproveKinds; delete row.poRequired; }
  return c.json({ ...row, contacts: camelRows(contacts), contracts: camelRows(contracts), children: camelRows(children) });
});

clientRoutes.patch("/:id", requirePermission("clients.edit"), async (c) => {
  const id = c.req.param("id");
  const d = await body(c, ClientInput.partial().merge(BillingInput));
  // Deactivating or re-parenting is a "manage" action (reference rule: a client with history is never deleted).
  if ((d.status !== undefined || d.parentId !== undefined) && !can(c, "clients.manage")) return c.json({ error: "forbidden" }, 403);
  if (BILLING_FIELDS_CLIENT.some((f) => (d as Record<string, unknown>)[f] !== undefined) && !can(c, "clients.billing.manage")) return c.json({ error: "forbidden" }, 403);
  if (d.parentId === id) return c.json({ error: "a client cannot be its own parent" }, 400);
  if (d.classKey && !(await pool.query("select 1 from client_classes where key = $1", [d.classKey])).rowCount) return c.json({ error: "unknown_class" }, 400);
  const { sets, values } = buildUpdate(d, { ...COLS, ...BCOLS }, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  // Typing another billing address by hand frees the link with the billing contact.
  const free = d.billingEmail !== undefined ? ", billing_contact_id = null" : "";
  const r = await pool.query(`update clients set ${sets.join(", ")}${free}, updated_at = now() where id = $1 returning id`, [id, ...values]);
  // Turning an auto-approve rule on also approves what is already waiting.
  if (r.rowCount && d.autoApproveKinds !== undefined) await applyAutoApprove(id);
  // Becoming active, a tax frequency or a class can imply tasks: create them now instead of waiting for the hourly tick.
  if (r.rowCount && (d.status !== undefined || d.taxFrequency !== undefined || d.classKey !== undefined)) autoTasksSoon(id);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
const BILLING_FIELDS_CLIENT = ["billingEmail", "termsDays", "poRequired", "autoApproveKinds", "invoiceNotes"];

/** The contact whose address is used for invoices: their email becomes the client's billing email and follows later edits. */
clientRoutes.put("/:id/billing-contact", requirePermission("clients.billing.manage"), async (c) => {
  const d = await body(c, z.object({ contactId: z.string().uuid().nullable() }));
  const id = c.req.param("id");
  if (d.contactId === null) {
    await pool.query("update clients set billing_contact_id = null, billing_email = '' where id = $1", [id]);
    await pool.query("update client_contacts set is_billing = false where client_id = $1", [id]);
    return c.json({ ok: true });
  }
  const k = (await pool.query("select email from client_contacts where id = $1 and client_id = $2", [d.contactId, id])).rows[0];
  if (!k) throw new Fail(404, "not_found");
  if (!k.email) throw new Fail(409, "contact_no_email");
  await pool.query("update client_contacts set is_billing = (id = $2) where client_id = $1", [id, d.contactId]);
  await pool.query("update clients set billing_contact_id = $2, billing_email = $3 where id = $1", [id, d.contactId, k.email]);
  await audit("client.billing_contact", { userId: auth(c).user.id, target: id });
  return c.json({ ok: true });
});

clientRoutes.put("/:id/primary-contact", requirePermission("clients.contacts.edit"), async (c) => {
  const d = await body(c, z.object({ contactId: z.string().uuid().nullable() }));
  await pool.query("update client_contacts set is_primary = (id::text = $2) where client_id = $1", [c.req.param("id"), d.contactId ?? ""]);
  return c.json({ ok: true });
});

async function usage(id: string) {
  const r = await pool.query(
    `select (select count(*)::int from client_contacts where client_id = $1) as contacts, (select count(*)::int from client_contracts where client_id = $1) as contracts,
            (select count(*)::int from tasks where client_id = $1) as tasks, (select count(*)::int from invoices where client_id = $1) as invoices,
            (select count(*)::int from billing_items where client_id = $1) as billing_items, (select count(*)::int from timesheet_entries where client_id = $1) as time_entries,
            (select count(*)::int from expense_items where client_id = $1) as expenses`, [id]);
  const u = r.rows[0];
  return { counts: u, blocked: u.invoices + u.billing_items + u.tasks + u.time_entries + u.expenses > 0 };
}

clientRoutes.get("/:id/delete-check", requirePermission("clients.manage"), async (c) => c.json(await usage(c.req.param("id"))));

clientRoutes.delete("/:id", requirePermission("clients.manage"), async (c) => {
  const id = c.req.param("id");
  const u = await usage(id);
  // Reference rule: a client with invoices, work to bill, tasks, time or expenses is never deleted; deactivate it.
  if (u.blocked) return c.json({ error: "client_has_history", counts: u.counts }, 409);
  await pool.query("delete from clients where id = $1", [id]);
  await audit("client.deleted", { userId: auth(c).user.id, target: id, detail: u.counts });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Contacts
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
     values ($1, $2, coalesce($3,''), coalesce($4,''), coalesce($5,''), $6, false, coalesce($7,'')) returning id`,
    [clientId, d.name, d.email, d.phone, d.title, d.isPrimary ?? first, d.notes],
  );
  // The only contact of a client with an address is also its billing contact, until someone picks another.
  if (first && d.email && !(await pool.query("select 1 from clients where id = $1 and billing_email <> ''", [clientId])).rowCount) {
    await pool.query("update client_contacts set is_billing = true where id = $1", [r.rows[0].id]);
    await pool.query("update clients set billing_contact_id = $2, billing_email = $3 where id = $1", [clientId, r.rows[0].id, d.email]);
  }
  if (d.isBilling && d.email) {
    await pool.query("update client_contacts set is_billing = (id = $2) where client_id = $1", [clientId, r.rows[0].id]);
    await pool.query("update clients set billing_contact_id = $2, billing_email = $3 where id = $1", [clientId, r.rows[0].id, d.email]);
  }
  return c.json({ id: r.rows[0].id }, 201);
});

clientRoutes.patch("/contacts/:cid", requirePermission("clients.contacts.edit"), async (c) => {
  const cid = c.req.param("cid");
  const d = await body(c, ContactInput.partial());
  const row = (await pool.query("select client_id from client_contacts where id = $1", [cid])).rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  if (d.isPrimary) await pool.query("update client_contacts set is_primary = false where client_id = $1", [row.client_id]);
  const { isBilling, ...rest } = d;
  const { sets, values } = buildUpdate(rest, { name: "name", email: "email", phone: "phone", title: "title", isPrimary: "is_primary", notes: "notes" }, 2);
  if (sets.length) await pool.query(`update client_contacts set ${sets.join(", ")} where id = $1`, [cid, ...values]);
  // The billing address follows its contact's address, and is cleared with it.
  const cl = (await pool.query("select billing_contact_id from clients where id = $1", [row.client_id])).rows[0];
  if (cl?.billing_contact_id === cid && d.email !== undefined) await pool.query("update clients set billing_email = $2 where id = $1", [row.client_id, d.email ?? ""]);
  if (isBilling !== undefined && can(c, "clients.billing.manage")) {
    const email = (await pool.query("select email from client_contacts where id = $1", [cid])).rows[0].email;
    if (isBilling && !email) throw new Fail(409, "contact_no_email");
    await pool.query("update client_contacts set is_billing = (id = $2 and $3::boolean) where client_id = $1", [row.client_id, cid, isBilling]);
    await pool.query("update clients set billing_contact_id = $2, billing_email = $3 where id = $1", [row.client_id, isBilling ? cid : null, isBilling ? email : ""]);
  }
  return c.json({ ok: true });
});

clientRoutes.delete("/contacts/:cid", requirePermission("clients.contacts.edit"), async (c) => {
  const row = (await pool.query("select client_id from client_contacts where id = $1", [c.req.param("cid")])).rows[0];
  if (row) {
    const cl = (await pool.query("select billing_contact_id from clients where id = $1", [row.client_id])).rows[0];
    if (cl?.billing_contact_id === c.req.param("cid")) await pool.query("update clients set billing_email = '' where id = $1", [row.client_id]);
  }
  await pool.query("delete from client_contacts where id = $1", [c.req.param("cid")]);
  return c.json({ ok: true });
});
