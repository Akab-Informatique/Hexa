import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { open, seal } from "../auth/secrets.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { config } from "../config.ts";
import { emailBoardMessage } from "./mailing.ts";
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
  // The email copy goes out right away when Mailjet is set up; otherwise it waits as "pending".
  const email = d.emailCopy ? await emailBoardMessage(id).catch(() => ({ status: "failed" as const, sent: 0, failed: 0 })) : null;
  return c.json({ id, email }, 201);
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

void camel; void open; void seal; void config;
