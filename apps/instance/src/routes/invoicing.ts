import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { aging, computeInvoice, dueAfterSent, roundCents, todayISO } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { applyAutoApprove } from "../lib/autoApprove.ts";
import { settings } from "./accounting.ts";
import { auth, body, buildUpdate, camel, camelRows, isUuid } from "./util.ts";

// Work to bill and invoices, modelled on the reference portal:
// - work to bill is filtered by a time frame, approved (by hand or by a client's auto-approve rule), edited or set aside
//   (with a reason such as "already invoiced"), then turned into invoices of the items of that time frame;
// - an invoice goes out when it is finalized: its due day counts from the day it is sent (sent day + terms + 1);
// - payments can be partial; the status follows the balance; an invoice with payments cannot be voided.
export const invoicingRoutes = new Hono<Env>();

export class Fail extends Error { constructor(public status: number, public code: string, public extra?: object) { super(code); } }
invoicingRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code, ...e.extra }, e.status as 400);
  throw e;
});
type Ctx = Context<Env>;
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const dayOrNull = (v: string | undefined) => (v && Day.safeParse(v).success ? v : null);
const INV_VIEW = ["accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage"];
const dollars = (cents: number) => Math.round(cents) / 100;

// =============================== Work to bill ===============================
const ItemInput = z.object({
  clientId: z.string().uuid(), description: z.string().min(1).max(500), quantity: z.number().min(0.01).max(100000),
  unitPrice: z.number().min(0).max(1e7), workDate: Day.nullable().optional(),
});

/** The time frame applies to the work date; a line with no date is always shown. */
const FRAME = "($3::date is null or b.work_date is null or b.work_date >= $3) and ($4::date is null or b.work_date is null or b.work_date <= $4)";

invoicingRoutes.get("/billing-items", requirePermission("accounting.approvals.view", "accounting.approvals.manage"), async (c) => {
  const status = c.req.query("status") ?? "pending";
  const client = c.req.query("client");
  const r = await pool.query(
    `select b.*, cl.name as client_name, u.name as created_by_name, k.name as contract_name
       from billing_items b join clients cl on cl.id = b.client_id left join users u on u.id = b.created_by left join client_contracts k on k.id = b.contract_id
      where ($1 = 'all' or b.status = $1) and ($2::uuid is null or b.client_id = $2) and ${FRAME}
      order by cl.name, k.name nulls first, b.work_date nulls last, b.created_at limit 2000`,
    [["pending", "approved", "excluded", "invoiced", "all"].includes(status) ? status : "pending", client && isUuid(client) ? client : null, dayOrNull(c.req.query("from")), dayOrNull(c.req.query("to"))]);
  return c.json(camelRows(r));
});

/** Counts and totals per status for the same time frame (the tabs). */
invoicingRoutes.get("/billing-items/summary", requirePermission("accounting.approvals.view", "accounting.approvals.manage"), async (c) => {
  const r = await pool.query(
    `select b.status, count(*)::int as n, coalesce(sum(b.quantity * b.unit_price), 0) as total from billing_items b
      where ($1::date is null or b.work_date is null or b.work_date >= $1) and ($2::date is null or b.work_date is null or b.work_date <= $2) group by b.status`,
    [dayOrNull(c.req.query("from")), dayOrNull(c.req.query("to"))]);
  const out: Record<string, { count: number; total: number }> = { pending: { count: 0, total: 0 }, approved: { count: 0, total: 0 }, excluded: { count: 0, total: 0 }, invoiced: { count: 0, total: 0 } };
  for (const x of r.rows) out[x.status] = { count: x.n, total: roundCents(Number(x.total)) };
  return c.json(out);
});

invoicingRoutes.post("/billing-items", requirePermission("accounting.approvals.manage"), async (c) => {
  const d = await body(c, ItemInput);
  const r = await pool.query("insert into billing_items (client_id, source, description, quantity, unit_price, work_date, created_by) values ($1, 'manual', $2, $3, $4, $5, $6) returning id", [d.clientId, d.description, d.quantity, d.unitPrice, d.workDate ?? null, auth(c).user.id]);
  await applyAutoApprove(d.clientId);
  return c.json({ id: r.rows[0].id }, 201);
});

invoicingRoutes.patch("/billing-items/:id", requirePermission("accounting.approvals.manage"), async (c) => {
  const d = await body(c, ItemInput.omit({ clientId: true }).partial());
  const { sets, values } = buildUpdate(d, { description: "description", quantity: "quantity", unitPrice: "unit_price", workDate: "work_date" }, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const r = await pool.query(`update billing_items set ${sets.join(", ")} where id = $1 and status in ('pending','approved','excluded') returning id`, [c.req.param("id"), ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found or already invoiced" }, 409);
});

/** Set aside with a reason: "billed" = already invoiced elsewhere (never brought back by an import). */
invoicingRoutes.post("/billing-items/decision", requirePermission("accounting.approvals.manage"), async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), decision: z.enum(["approve", "exclude", "restore"]), reason: z.enum(["billed", "aside", "other"]).optional(), note: z.string().max(300).optional() }));
  const status = d.decision === "approve" ? "approved" : d.decision === "exclude" ? "excluded" : "pending";
  const r = await pool.query(
    "update billing_items set status = $2, excluded_reason = case when $2 = 'excluded' then coalesce($3,'other') else '' end, reason = coalesce($4,''), decided_by = $5, decided_at = now() where id = any($1::uuid[]) and status <> 'invoiced' returning id",
    [d.ids, status, d.reason, d.note, auth(c).user.id]);
  return c.json({ updated: r.rowCount });
});

// =============================== Invoices ===============================
const LineInput = z.object({ description: z.string().min(1).max(500), quantity: z.number().min(0.01).max(100000), unitPrice: z.number().min(-1e7).max(1e7), taxable: z.boolean().default(true), billingItemId: z.string().uuid().nullable().optional() });

async function writeInvoiceLines(invoiceId: string, lines: z.infer<typeof LineInput>[]) {
  const s = await settings();
  const calc = computeInvoice(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, taxable: l.taxable })), s);
  await pool.query("delete from invoice_lines where invoice_id = $1", [invoiceId]);
  for (const [i, l] of calc.lines.entries()) {
    await pool.query("insert into invoice_lines (invoice_id, position, description, quantity, unit_price, taxable, amount, billing_item_id) values ($1,$2,$3,$4,$5,$6,$7,$8)", [invoiceId, i, lines[i]!.description, l.quantity, l.unitPrice, l.taxable, l.amount, lines[i]!.billingItemId ?? null]);
  }
  await pool.query("update invoices set subtotal = $2, gst = $3, qst = $4, total = $5 where id = $1", [invoiceId, calc.subtotal, calc.gst, calc.qst, calc.total]);
}

async function termsOf(clientId: string): Promise<number> {
  const k = (await pool.query("select terms_days from clients where id = $1", [clientId])).rows[0];
  return k?.terms_days ?? (await settings()).paymentTermsDays;
}

interface Dates { issueDate?: string; dueDate?: string; poNumber?: string }
async function newInvoice(clientId: string, userId: string, lines: z.infer<typeof LineInput>[], o: Dates & { notes?: string } = {}): Promise<string> {
  const s = await settings();
  const today = todayISO();
  // The due day counts from the day it goes out (today), not from the issue date written on it. A due date typed by hand is kept.
  const due = o.dueDate ?? dueAfterSent(today, await termsOf(clientId));
  const seq = (await pool.query("select nextval('invoice_number_seq') as n")).rows[0].n;
  const r = await pool.query(
    "insert into invoices (number, client_id, issue_date, due_date, due_manual, po_number, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [`${s.invoicePrefix}${seq}`, clientId, o.issueDate ?? today, due, Boolean(o.dueDate), o.poNumber ?? "", o.notes ?? "", userId]);
  await writeInvoiceLines(r.rows[0].id, lines);
  return r.rows[0].id as string;
}

/** Invoices with what was paid, the balance and a view status: open | overdue | partial | paid | voided | draft. */
export const WITH_PAID = `with v as (
  select i.*, cl.name as client_name, coalesce(p.paid, 0) as paid_cents,
    case when i.status = 'void' then 'voided' when i.status = 'draft' then 'draft'
         when coalesce(p.paid, 0) >= round(i.total * 100) then 'paid'
         when coalesce(p.paid, 0) > 0 then 'partial'
         when i.due_date < $1::date then 'overdue' else 'open' end as view
    from invoices i join clients cl on cl.id = i.client_id
    left join (select invoice_id, sum(amount_cents) as paid from invoice_payments group by invoice_id) p on p.invoice_id = i.id)`;

const SORTS: Record<string, string> = {
  number: "length(number), number", client: "lower(client_name)", issued: "issue_date", due: "due_date", total: "total", balance: "(round(total * 100) - paid_cents)",
};

invoicingRoutes.get("/invoices", requirePermission(...INV_VIEW), async (c) => {
  const today = todayISO();
  const status = c.req.query("status") ?? "";
  const client = c.req.query("client");
  const q = (c.req.query("q") ?? "").trim();
  const emailed = c.req.query("emailed");
  const paged = c.req.query("page") !== undefined;
  const size = [10, 25, 50, 100].includes(Number(c.req.query("size"))) ? Number(c.req.query("size")) : 25;
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const sort = SORTS[c.req.query("sort") ?? ""] ?? "length(number), number";
  const dir = c.req.query("dir") === "asc" ? "asc" : "desc";
  // "open" = every sent invoice that still has a balance (open, overdue, partial); "due" = due today.
  const where = `where ($2::text = '' or ($2 = 'open' and view in ('open','overdue','partial')) or ($2 = 'due' and view in ('open','partial') and due_date = $1::date) or view = $2)
    and ($3::uuid is null or client_id = $3) and ($4::date is null or issue_date >= $4) and ($5::date is null or issue_date <= $5)
    and ($6 = '' or number ilike '%' || $6 || '%' or po_number ilike '%' || $6 || '%')
    and ($7 = '' or ($7 = 'yes' and emailed_at is not null) or ($7 = 'no' and emailed_at is null))`;
  const params = [today, ["open", "due", "overdue", "partial", "paid", "voided", "draft"].includes(status) ? status : "", client && isUuid(client) ? client : null, dayOrNull(c.req.query("from")), dayOrNull(c.req.query("to")), q, emailed === "yes" || emailed === "no" ? emailed : ""];
  const r = await pool.query(`${WITH_PAID} select * from v ${where} order by ${sort} ${dir}${paged ? ` limit ${size} offset ${(page - 1) * size}` : " limit 500"}`, params);
  const rows = camelRows<{ total: number; paidCents: number }>(r).map((x: any) => ({ ...x, paid: dollars(x.paidCents), balance: roundCents(Number(x.total) - dollars(x.paidCents)) }));
  if (!paged) return c.json(rows);
  const t = (await pool.query(`${WITH_PAID} select count(*)::int as n, coalesce(sum(total),0) as total, coalesce(sum(round(total*100) - paid_cents) filter (where view in ('open','overdue','partial')),0) as balance from v ${where}`, params)).rows[0];
  return c.json({ rows, total: t.n, page, size, totals: { amount: roundCents(Number(t.total)), balance: dollars(Number(t.balance)) } });
});

export async function invoiceDetail(id: string) {
  if (!isUuid(id)) throw new Fail(404, "not_found");
  const r = (await pool.query(`${WITH_PAID} select v.*, cl.address, cl.city, cl.province, cl.postal_code, cl.billing_email, cl.email as client_email, cl.terms_days from v join clients cl on cl.id = v.client_id where v.id = $2`, [todayISO(), id])).rows[0];
  if (!r) throw new Fail(404, "not_found");
  const [lines, payments] = await Promise.all([
    pool.query("select l.*, k.name as contract_name from invoice_lines l left join billing_items b on b.id = l.billing_item_id left join client_contracts k on k.id = b.contract_id where l.invoice_id = $1 order by l.position", [id]),
    pool.query("select p.id, p.paid_on, p.amount_cents, p.method, p.reference, p.note, u.name as by_name from invoice_payments p left join users u on u.id = p.created_by where p.invoice_id = $1 order by p.paid_on, p.created_at", [id]),
  ]);
  return { ...camel<Record<string, unknown>>(r), paid: dollars(Number(r.paid_cents)), balance: roundCents(Number(r.total) - dollars(Number(r.paid_cents))), lines: camelRows(lines), payments: camelRows(payments), rates: await settings() };
}

invoicingRoutes.get("/invoices/:id", requirePermission(...INV_VIEW), async (c) => c.json(await invoiceDetail(c.req.param("id"))));

invoicingRoutes.post("/invoices", requirePermission("accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ clientId: z.string().uuid(), lines: z.array(LineInput).min(1).max(200), issueDate: Day.optional(), dueDate: Day.optional(), poNumber: z.string().max(60).optional(), notes: z.string().max(2000).optional() }));
  const id = await newInvoice(d.clientId, auth(c).user.id, d.lines, d);
  return c.json({ id }, 201);
});

/**
 * Turns approved work to bill into draft invoices, one per client: only the items of the time frame (or the ids given).
 * `preview: true` works out the totals without creating anything. A client that requires a PO number and has none is skipped.
 */
invoicingRoutes.post("/invoices/from-items", requirePermission("accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({
    from: Day.nullable().optional(), to: Day.nullable().optional(), ids: z.array(z.string().uuid()).max(2000).optional(), preview: z.boolean().optional(),
    clientId: z.string().uuid().optional(),
    clients: z.array(z.object({ clientId: z.string().uuid(), issueDate: Day.optional(), dueDate: Day.optional(), poNumber: z.string().max(60).optional(), notes: z.string().max(2000).optional() })).max(500).optional(),
  }));
  const items = (await pool.query(
    `select b.*, k.name as contract_name from billing_items b left join client_contracts k on k.id = b.contract_id
      where b.status = 'approved' and ($1::uuid is null or b.client_id = $1) and (cardinality($2::uuid[]) = 0 or b.id = any($2::uuid[]))
        and ($3::date is null or b.work_date is null or b.work_date >= $3) and ($4::date is null or b.work_date is null or b.work_date <= $4)
      order by b.client_id, b.work_date nulls last, b.created_at`, [d.clientId ?? null, d.ids ?? [], d.from ?? null, d.to ?? null])).rows;
  const byClient = new Map<string, typeof items>();
  for (const it of items) byClient.set(it.client_id, [...(byClient.get(it.client_id) ?? []), it]);
  const s = await settings();
  const created: string[] = [], skipped: { clientId: string; name: string; reason: string }[] = [], preview: object[] = [];
  for (const [clientId, rows] of byClient) {
    const cl = (await pool.query("select name, po_required, invoice_notes from clients where id = $1", [clientId])).rows[0];
    const o = d.clients?.find((x) => x.clientId === clientId) ?? { clientId };
    if (cl.po_required && !o.poNumber?.trim()) { skipped.push({ clientId, name: cl.name, reason: "po_required" }); continue; }
    const lines = rows.map((it) => ({
      description: `${it.contract_name ? `${it.contract_name} · ` : ""}${it.description}${it.work_date ? ` (${String(it.work_date).slice(0, 10)})` : ""}`,
      quantity: Number(it.quantity), unitPrice: Number(it.unit_price), taxable: true, billingItemId: it.id as string,
    }));
    const calc = computeInvoice(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, taxable: l.taxable })), s);
    const due = o.dueDate ?? dueAfterSent(todayISO(), await termsOf(clientId));
    if (d.preview) { preview.push({ clientId, name: cl.name, count: rows.length, subtotal: calc.subtotal, gst: calc.gst, qst: calc.qst, total: calc.total, dueDate: due, poRequired: cl.po_required, defaultNotes: cl.invoice_notes }); continue; }
    const id = await newInvoice(clientId, auth(c).user.id, lines, { issueDate: o.issueDate, dueDate: o.dueDate, poNumber: o.poNumber, notes: o.notes ?? cl.invoice_notes });
    await pool.query("update billing_items set status = 'invoiced', invoice_id = $2 where id = any($1::uuid[])", [rows.map((r) => r.id), id]);
    created.push(id);
  }
  return c.json(d.preview ? { clients: preview, skipped } : { created, skipped });
});

invoicingRoutes.put("/invoices/:id", requirePermission("accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  const inv = (await pool.query("select status, due_date from invoices where id = $1", [c.req.param("id")])).rows[0];
  if (!inv) return c.json({ error: "not found" }, 404);
  if (inv.status !== "draft") return c.json({ error: "only drafts can be edited" }, 409);
  const d = await body(c, z.object({ lines: z.array(LineInput).min(1).max(200), issueDate: Day.optional(), dueDate: Day.optional(), poNumber: z.string().max(60).optional(), notes: z.string().max(2000).optional() }));
  // A due date the user changed is theirs: it is not recomputed when the invoice goes out.
  const manual = d.dueDate !== undefined && d.dueDate !== String(inv.due_date).slice(0, 10);
  await pool.query("update invoices set issue_date = coalesce($2, issue_date), due_date = coalesce($3, due_date), due_manual = due_manual or $4, po_number = coalesce($5, po_number), notes = coalesce($6, notes) where id = $1", [c.req.param("id"), d.issueDate ?? null, d.dueDate ?? null, manual, d.poNumber ?? null, d.notes ?? null]);
  await writeInvoiceLines(c.req.param("id"), d.lines);
  return c.json({ ok: true });
});

async function paidCents(id: string) {
  return Number((await pool.query("select coalesce(sum(amount_cents),0) as p from invoice_payments where invoice_id = $1", [id])).rows[0].p);
}

invoicingRoutes.post("/invoices/:id/action", requirePermission("accounting.invoices.manage"), async (c) => {
  const { action } = await body(c, z.object({ action: z.enum(["send", "pay", "void"]) }));
  const id = c.req.param("id");
  const inv = (await pool.query("select status, total, client_id, due_manual from invoices where id = $1", [id])).rows[0];
  if (!inv) return c.json({ error: "not found" }, 404);
  const allowed: Record<string, string[]> = { send: ["draft"], pay: ["sent"], void: ["draft", "sent"] };
  if (!allowed[action]!.includes(inv.status)) return c.json({ error: `cannot ${action} an invoice that is ${inv.status}` }, 409);
  if (action === "send") {
    // Finalizing sends it today: the due day is today + terms + 1, unless someone typed one.
    const due = inv.due_manual ? null : dueAfterSent(todayISO(), await termsOf(inv.client_id));
    await pool.query("update invoices set status = 'sent', sent_at = now(), due_date = coalesce($2, due_date) where id = $1", [id, due]);
  }
  if (action === "pay") {
    const balance = Math.round(Number(inv.total) * 100) - (await paidCents(id));
    if (balance > 0) await pool.query("insert into invoice_payments (invoice_id, amount_cents, method, note, created_by) values ($1,$2,'other','paid in full',$3)", [id, balance, auth(c).user.id]);
    await pool.query("update invoices set status = 'paid', paid_at = now() where id = $1", [id]);
  }
  if (action === "void") {
    // Reference rule: an invoice with payments cannot be voided (record the refund instead).
    if ((await paidCents(id)) > 0) return c.json({ error: "invoice_has_payments" }, 409);
    await pool.query("update invoices set status = 'void' where id = $1", [id]);
    // Voiding releases the work so it can be billed again.
    await pool.query("update billing_items set status = 'approved', invoice_id = null where invoice_id = $1", [id]);
  }
  await audit(`invoice.${action}`, { userId: auth(c).user.id, target: id });
  return c.json({ ok: true });
});

// ---- Payments
invoicingRoutes.post("/invoices/:id/payments", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ paidOn: Day.optional(), amount: z.number().positive().max(1e8), method: z.string().max(40).optional(), reference: z.string().max(100).optional(), note: z.string().max(300).optional() }));
  const id = c.req.param("id");
  const inv = (await pool.query("select status, total from invoices where id = $1", [id])).rows[0];
  if (!inv) throw new Fail(404, "not_found");
  if (inv.status !== "sent" && inv.status !== "paid") throw new Fail(409, "invoice_not_sent");
  const balance = Math.round(Number(inv.total) * 100) - (await paidCents(id));
  const cents = Math.round(d.amount * 100);
  // Never more than what is still owed.
  if (cents > balance) throw new Fail(409, "payment_exceeds_balance", { balance: balance / 100 });
  await pool.query("insert into invoice_payments (invoice_id, paid_on, amount_cents, method, reference, note, created_by) values ($1,coalesce($2, current_date),$3,coalesce($4,'other'),coalesce($5,''),coalesce($6,''),$7)", [id, d.paidOn ?? null, cents, d.method, d.reference, d.note, auth(c).user.id]);
  if (cents === balance) await pool.query("update invoices set status = 'paid', paid_at = now() where id = $1", [id]);
  await audit("invoice.payment", { userId: auth(c).user.id, target: id, detail: { cents } });
  return c.json({ ok: true, paidInFull: cents === balance }, 201);
});

invoicingRoutes.delete("/invoices/:id/payments/:pid", requirePermission("accounting.invoices.manage"), async (c) => {
  const id = c.req.param("id");
  const r = await pool.query("delete from invoice_payments where id::text = $2 and invoice_id = $1 returning amount_cents", [id, c.req.param("pid")]);
  if (!r.rowCount) return c.json({ ok: true });
  // A paid invoice that loses a payment is open again.
  await pool.query("update invoices set status = 'sent', paid_at = null where id = $1 and status = 'paid'", [id]);
  await audit("invoice.payment_removed", { userId: auth(c).user.id, target: id });
  return c.json({ ok: true });
});

/** Until the portal emails invoices itself (Mailjet), the "sent by email" mark is kept by hand. */
invoicingRoutes.post("/invoices/:id/emailed", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ emailed: z.boolean() }));
  await pool.query("update invoices set emailed_at = case when $2 then now() else null end where id = $1", [c.req.param("id"), d.emailed]);
  return c.json({ ok: true });
});

// ---- Account statement: what a client still owes, by due day, with the aging of the debt
invoicingRoutes.get("/clients/:id/statement", requirePermission(...INV_VIEW), async (c) => c.json(await statementOf(c.req.param("id"))));

export async function statementOf(id: string) {
  if (!isUuid(id)) throw new Fail(404, "not_found");
  const today = todayISO();
  const cl = (await pool.query("select id, name, address, city, province, postal_code, billing_email, email from clients where id = $1", [id])).rows[0];
  if (!cl) throw new Fail(404, "not_found");
  const r = await pool.query(`${WITH_PAID} select * from v where client_id = $2 and view in ('open','overdue','partial') order by due_date, number`, [today, id]);
  const buckets = { notDue: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
  const rows = camelRows<{ id: string; number: string; issueDate: string; dueDate: string; total: number; paidCents: number; poNumber: string }>(r).map((x) => {
    const balance = dollars(Math.round(Number(x.total) * 100) - Number(x.paidCents));
    const a = aging(String(x.dueDate).slice(0, 10), today);
    buckets[a.bucket] = roundCents(buckets[a.bucket] + balance);
    return { id: x.id, number: x.number, issueDate: x.issueDate, dueDate: x.dueDate, poNumber: x.poNumber, total: Number(x.total), balance, daysLate: a.daysLate, bucket: a.bucket };
  });
  const total = roundCents(rows.reduce((a, x) => a + x.balance, 0));
  return { client: camel(cl), today, rows, buckets, total, pastDue: roundCents(total - buckets.notDue) };
}
