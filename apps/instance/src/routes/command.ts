import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { open, seal } from "../auth/secrets.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { config } from "../config.ts";
import { auth, body, buildUpdate, camel, camelRows, can } from "./util.ts";

export const commandRoutes = new Hono<Env>();

// =============================== Message board ===============================
// Reference model: one-way broadcast to all clients or a selection, shown in the client portal's home,
// with an optional email copy. The portal view arrives with client users; the email goes out through
// Mailjet once that integration is configured (until then the copy waits as "pending").
const MessageInput = z.object({
  title: z.string().min(1).max(200), body: z.string().max(20000).optional(), pinned: z.boolean().optional(),
  audience: z.enum(["all", "selected"]).default("all"), clientIds: z.array(z.string().uuid()).max(500).default([]), emailCopy: z.boolean().default(false),
});

commandRoutes.get("/board", requirePermission("command.board.view"), async (c) => {
  const r = await pool.query(
    `select m.*, u.name as author_name,
            (select coalesce(json_agg(json_build_object('id', cl.id, 'name', cl.name) order by cl.name), '[]')
               from message_targets mt join clients cl on cl.id = mt.client_id where mt.message_id = m.id) as targets
       from messages m left join users u on u.id = m.author_id order by m.pinned desc, m.created_at desc limit 200`);
  return c.json(camelRows(r));
});

commandRoutes.post("/board", requirePermission("command.board.post", "command.board.manage"), async (c) => {
  const d = await body(c, MessageInput);
  if (d.audience === "selected" && !d.clientIds.length) return c.json({ error: "choose at least one client" }, 400);
  if (d.emailCopy && !can(c, "command.board.email", "command.board.manage")) return c.json({ error: "you may not send emails" }, 403);
  if (d.pinned && !can(c, "command.board.manage")) return c.json({ error: "forbidden" }, 403);
  const r = await pool.query(
    "insert into messages (title, body, pinned, audience, author_id, email_copy, email_status) values ($1, coalesce($2,''), coalesce($3,false), $4, $5, $6, $7) returning id",
    [d.title, d.body, d.pinned, d.audience, auth(c).user.id, d.emailCopy, d.emailCopy ? "pending" : "none"],
  );
  const id = r.rows[0].id as string;
  if (d.audience === "selected") for (const cid of d.clientIds) await pool.query("insert into message_targets values ($1, $2) on conflict do nothing", [id, cid]);
  await audit("message.posted", { userId: auth(c).user.id, target: d.title, detail: { audience: d.audience, emailCopy: d.emailCopy } });
  return c.json({ id }, 201);
});

commandRoutes.patch("/board/:id", requirePermission("command.board.manage"), async (c) => {
  const d = await body(c, z.object({ pinned: z.boolean().optional() }));
  const { sets, values } = buildUpdate(d, { pinned: "pinned" }, 2);
  if (sets.length) await pool.query(`update messages set ${sets.join(", ")} where id = $1`, [c.req.param("id"), ...values]);
  return c.json({ ok: true });
});

commandRoutes.delete("/board/:id", requirePermission("command.board.post", "command.board.manage"), async (c) => {
  const m = (await pool.query("select author_id from messages where id = $1", [c.req.param("id")])).rows[0];
  if (!m) return c.json({ ok: true });
  if (m.author_id !== auth(c).user.id && !can(c, "command.board.manage")) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from messages where id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// =============================== Documentation (SharePoint links) ===============================
const DocInput = z.object({
  title: z.string().min(1).max(200), url: z.string().url().max(2000).refine((u) => /^https?:\/\//i.test(u), "http(s) only"),
  description: z.string().max(1000).optional(), category: z.string().max(80).optional(), clientId: z.string().uuid().nullable().optional(),
});

commandRoutes.get("/docs", requirePermission("docs.view", "docs.edit", "docs.manage"), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const client = c.req.query("client");
  const r = await pool.query(
    `select d.*, cl.name as client_name from doc_links d left join clients cl on cl.id = d.client_id
      where ($1 = '' or d.title ilike '%'||$1||'%' or d.description ilike '%'||$1||'%') and ($2::uuid is null or d.client_id = $2)
      order by d.category, lower(d.title)`,
    [q, client && /^[0-9a-f-]{36}$/i.test(client) ? client : null],
  );
  return c.json(camelRows(r));
});

commandRoutes.post("/docs", requirePermission("docs.edit", "docs.manage"), async (c) => {
  const d = await body(c, DocInput);
  const r = await pool.query("insert into doc_links (title, url, description, category, client_id, created_by) values ($1, $2, coalesce($3,''), coalesce($4,'Général'), $5, $6) returning id", [d.title, d.url, d.description, d.category, d.clientId ?? null, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});

commandRoutes.patch("/docs/:id", requirePermission("docs.edit", "docs.manage"), async (c) => {
  const row = (await pool.query("select created_by from doc_links where id = $1", [c.req.param("id")])).rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.created_by !== auth(c).user.id && !can(c, "docs.manage")) return c.json({ error: "forbidden" }, 403);
  const d = await body(c, DocInput.partial());
  const { sets, values } = buildUpdate(d, { title: "title", url: "url", description: "description", category: "category", clientId: "client_id" }, 2);
  if (sets.length) await pool.query(`update doc_links set ${sets.join(", ")} where id = $1`, [c.req.param("id"), ...values]);
  return c.json({ ok: true });
});

commandRoutes.delete("/docs/:id", requirePermission("docs.edit", "docs.manage"), async (c) => {
  const row = (await pool.query("select created_by from doc_links where id = $1", [c.req.param("id")])).rows[0];
  if (!row) return c.json({ ok: true });
  if (row.created_by !== auth(c).user.id && !can(c, "docs.manage")) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from doc_links where id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

void camel; void open; void seal; void config;
