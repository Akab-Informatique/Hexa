import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, buildUpdate, camelRows, can } from "./util.ts";

// The catalogue of what the firm sells besides hours (bookkeeping package, payroll, annual filing...).
// A contract copies a service's name and price when it is added: changing the catalogue never moves a contract.
export const serviceRoutes = new Hono<Env>();

const Input = z.object({
  name: z.string().min(1).max(200), description: z.string().max(2000).optional(), kind: z.enum(["monthly", "yearly", "one_time"]).optional(),
  price: z.number().min(0).max(1e7).optional(), cost: z.number().min(0).max(1e7).optional(), taxable: z.boolean().optional(), active: z.boolean().optional(),
});

serviceRoutes.get("/", requirePermission("services.view", "services.manage", "clients.contracts.view"), async (c) => {
  const r = await pool.query(
    `select s.*, (select count(*)::int from contract_services x join client_contracts k on k.id = x.contract_id where x.service_id = s.id and k.status = 'active') as in_use from services s order by s.active desc, lower(s.name)`);
  // Cost and margin are the firm's own: only service managers see them.
  const rows = camelRows<{ costCents: number | null; priceCents: number }>(r);
  return c.json(can(c, "services.manage") ? rows : rows.map((x) => ({ ...x, costCents: null })));
});

serviceRoutes.post("/", requirePermission("services.manage"), async (c) => {
  const d = await body(c, Input);
  try {
    const r = await pool.query("insert into services (name, description, kind, price_cents, cost_cents, taxable, active) values ($1,coalesce($2,''),coalesce($3,'monthly'),$4,$5,coalesce($6,true),coalesce($7,true)) returning id",
      [d.name, d.description, d.kind, Math.round((d.price ?? 0) * 100), Math.round((d.cost ?? 0) * 100), d.taxable, d.active]);
    await audit("service.created", { userId: auth(c).user.id, target: d.name });
    return c.json({ id: r.rows[0].id }, 201);
  } catch (e) { if ((e as { code?: string }).code === "23505") return c.json({ error: "service_exists" }, 409); throw e; }
});

serviceRoutes.patch("/:id", requirePermission("services.manage"), async (c) => {
  const d = await body(c, Input.partial());
  const patch: Record<string, unknown> = { ...d, price: undefined, cost: undefined };
  if (d.price !== undefined) patch.priceCents = Math.round(d.price * 100);
  if (d.cost !== undefined) patch.costCents = Math.round(d.cost * 100);
  const { sets, values } = buildUpdate(patch, { name: "name", description: "description", kind: "kind", priceCents: "price_cents", costCents: "cost_cents", taxable: "taxable", active: "active" }, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  // A price change never reaches the contracts that already hold the service (they keep what was agreed).
  const r = await pool.query(`update services set ${sets.join(", ")} where id::text = $1 returning id`, [c.req.param("id"), ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

serviceRoutes.delete("/:id", requirePermission("services.manage"), async (c) => {
  const used = await pool.query("select 1 from contract_services where service_id::text = $1 limit 1", [c.req.param("id")]);
  if (used.rowCount) return c.json({ error: "service_in_use" }, 409);
  await pool.query("delete from services where id::text = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});
