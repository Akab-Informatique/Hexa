import { Hono } from "hono";
import { z } from "zod";
import { kindFor, MAX_PRICE_CENTS, periodOf, typeOf, type ServiceKindDb } from "@hexa/shared/productSale";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, can, isUuid } from "./util.ts";

// The catalogue of what the firm sells besides hours. Two types:
//   recurring = fixed fee charged every period (monthly / quarterly / yearly), attached to a client with its own price;
//   product   = one-time sale (a tax return...), sold to a client in one action, one line of work to bill each time.
// A contract line or a sale copies the service's name and price when it is made: changing the catalogue never moves them.
// Stored in the existing `kind` column ('one_time' = product); `type` and `period` are derived for the API.
export const serviceRoutes = new Hono<Env>();

const Cents = z.number().int().min(0).max(MAX_PRICE_CENTS);
const Input = z.object({
  name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(),
  type: z.enum(["recurring", "product"]), period: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  priceCents: Cents, costCents: Cents.optional(), taxable: z.boolean().optional(), active: z.boolean().optional(),
}).strict();

serviceRoutes.get("/", requirePermission("services.view", "services.manage", "clients.contracts.view", "clients.billing.manage"), async (c) => {
  // One query: the catalogue with its usage (clients with an active contract line, and products sold).
  const r = await pool.query(
    `select s.*,
            coalesce(u.clients, 0)::int as clients_using, coalesce(p.sold, 0)::int as sold_count
       from services s
       left join (select x.service_id, count(distinct k.client_id) as clients from contract_services x join client_contracts k on k.id = x.contract_id
                   where k.status = 'active' and (x.ends_on is null or x.ends_on >= current_date) group by x.service_id) u on u.service_id = s.id
       left join (select service_id, count(*) as sold from billing_items where service_id is not null group by service_id) p on p.service_id = s.id
      order by s.active desc, lower(s.name)`);
  // Cost and margin are the firm's own: only service managers see them.
  const mgr = can(c, "services.manage");
  return c.json(camelRows<{ kind: ServiceKindDb; costCents: number | null; clientsUsing: number; soldCount: number }>(r).map((x) => ({
    ...x, type: typeOf(x.kind), period: periodOf(x.kind), inUse: x.clientsUsing, costCents: mgr ? x.costCents : null,
  })));
});

serviceRoutes.post("/", requirePermission("services.manage"), async (c) => {
  const d = await body(c, Input);
  if (d.type === "recurring" && !d.period) return c.json({ error: "period_required" }, 400);
  try {
    const r = await pool.query("insert into services (name, description, kind, price_cents, cost_cents, taxable, active) values ($1,coalesce($2,''),$3,$4,$5,coalesce($6,true),coalesce($7,true)) returning id",
      [d.name, d.description, kindFor(d.type, d.period), d.priceCents, d.costCents ?? 0, d.taxable, d.active]);
    await audit("service.created", { userId: auth(c).user.id, target: d.name, detail: { type: d.type, period: d.period ?? null, priceCents: d.priceCents } });
    return c.json({ id: r.rows[0].id }, 201);
  } catch (e) { if ((e as { code?: string }).code === "23505") return c.json({ error: "service_exists" }, 409); throw e; }
});

serviceRoutes.patch("/:id", requirePermission("services.manage"), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const d = await body(c, Input.partial());
  const cur = (await pool.query("select kind, active from services where id = $1", [id])).rows[0];
  if (!cur) return c.json({ error: "not found" }, 404);
  const sets: string[] = [], values: unknown[] = [id];
  const add = (col: string, v: unknown) => { values.push(v); sets.push(`${col} = $${values.length}`); };
  if (d.name !== undefined) add("name", d.name);
  if (d.description !== undefined) add("description", d.description);
  if (d.type !== undefined || d.period !== undefined) {
    const type = d.type ?? typeOf(cur.kind);
    const period = d.period ?? periodOf(cur.kind) ?? undefined;
    if (type === "recurring" && !period) return c.json({ error: "period_required" }, 400);
    add("kind", kindFor(type, period));
  }
  if (d.priceCents !== undefined) add("price_cents", d.priceCents);
  if (d.costCents !== undefined) add("cost_cents", d.costCents);
  if (d.taxable !== undefined) add("taxable", d.taxable);
  if (d.active !== undefined) add("active", d.active);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  try {
    // A price change never reaches the contract lines and sales that already exist (they keep what was agreed).
    await pool.query(`update services set ${sets.join(", ")} where id = $1`, values);
  } catch (e) { if ((e as { code?: string }).code === "23505") return c.json({ error: "service_exists" }, 409); throw e; }
  const action = d.active !== undefined && d.active !== cur.active ? (d.active ? "service.activated" : "service.deactivated") : "service.updated";
  await audit(action, { userId: auth(c).user.id, target: id, detail: { fields: Object.keys(d) } });
  return c.json({ ok: true });
});

serviceRoutes.delete("/:id", requirePermission("services.manage"), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const used = await pool.query("select 1 from contract_services where service_id = $1 union all select 1 from billing_items where service_id = $1 limit 1", [id]);
  if (used.rowCount) return c.json({ error: "service_in_use" }, 409);
  const r = await pool.query("delete from services where id = $1 returning name", [id]);
  if (r.rowCount) await audit("service.deleted", { userId: auth(c).user.id, target: r.rows[0].name });
  return c.json({ ok: true });
});
