import { Hono } from "hono";
import { z } from "zod";
import { addDays, mondayOf, todayISO } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, requireReady, type Env } from "../auth/session.ts";
import { config } from "../config.ts";
import { authorizeUrl, calendarEvents, completeSignIn, connectionOf, graphGet, MS_CALLBACK, msApp, readState } from "../lib/microsoft.ts";
import { redirectUri, ServiceError } from "../lib/services.ts";
import { auth } from "./util.ts";

// Each person's own Microsoft 365 calendar and inbox (read only), through the firm's Entra app.
export const microsoftRoutes = new Hono<Env>();
microsoftRoutes.use("*", requireReady);
microsoftRoutes.onError((e, c) => {
  if (e instanceof ServiceError) return c.json({ error: e.code, detail: e.detail }, e.status as 400);
  throw e;
});
const USE = ["mytools.calendar.use", "mytools.mail.use"];
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

microsoftRoutes.get("/status", requirePermission(...USE), async (c) => {
  const conn = await connectionOf(auth(c).user.id);
  return c.json({ configured: Boolean(await msApp()), connected: Boolean(conn), email: conn?.email ?? null, needsReauth: conn?.needsReauth ?? false, redirectUri: config.publicUrl ? redirectUri(MS_CALLBACK) : null });
});

microsoftRoutes.get("/connect", requirePermission(...USE), async (c) => c.json({ url: await authorizeUrl(auth(c).user.id) }));

/** The return trip from Microsoft. The signed state must belong to the person who is signed in here. */
microsoftRoutes.get("/callback", async (c) => {
  const code = c.req.query("code"), state = c.req.query("state") ?? "";
  const me = auth(c).user.id;
  const back = (q: string) => c.redirect(`/my/calendar?${q}`);
  if (c.req.query("error")) return back(`error=${encodeURIComponent(c.req.query("error_description")?.slice(0, 120) ?? c.req.query("error")!)}`);
  if (!code || readState(state) !== me) return back("error=state");
  try {
    await completeSignIn(me, code);
    await audit("microsoft.connected", { userId: me });
    return back("connected=1");
  } catch (e) { return back(`error=${encodeURIComponent(e instanceof ServiceError ? e.code : "failed")}`); }
});

microsoftRoutes.delete("/disconnect", requirePermission(...USE), async (c) => {
  await pool.query("delete from ms_connections where user_id = $1", [auth(c).user.id]);
  await audit("microsoft.disconnected", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

microsoftRoutes.get("/calendar", requirePermission("mytools.calendar.use"), async (c) => {
  const from = Day.safeParse(c.req.query("from")).success ? c.req.query("from")! : mondayOf(todayISO());
  const to = Day.safeParse(c.req.query("to")).success ? c.req.query("to")! : addDays(from, 6);
  if (to < from || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 62) return c.json({ error: "range_invalid" }, 400);
  return c.json({ from, to, events: await calendarEvents(auth(c).user.id, from, to) });
});

microsoftRoutes.get("/mail", requirePermission("mytools.mail.use"), async (c) => {
  const top = Math.min(50, Math.max(5, Number(c.req.query("top")) || 25));
  const q = new URLSearchParams({ $top: String(top), $orderby: "receivedDateTime desc", $select: "id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments,webLink", ...(c.req.query("unread") === "1" ? { $filter: "isRead eq false" } : {}) });
  const j = (await graphGet(auth(c).user.id, `/me/mailFolders/inbox/messages?${q}`)) as { value?: Record<string, any>[] };
  return c.json({ messages: (j.value ?? []).map((m) => ({ id: m.id, subject: m.subject ?? "", from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "", fromEmail: m.from?.emailAddress?.address ?? "", receivedAt: m.receivedDateTime, isRead: Boolean(m.isRead), preview: m.bodyPreview ?? "", hasAttachments: Boolean(m.hasAttachments), webLink: m.webLink ?? null })) });
});

/** One message as plain text (Microsoft converts it): nothing from a stranger's HTML ever reaches the page. */
microsoftRoutes.get("/mail/:id", requirePermission("mytools.mail.use"), async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_=\-]{10,400}$/.test(id)) return c.json({ error: "not found" }, 404);
  const m = (await graphGet(auth(c).user.id, `/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,toRecipients,receivedDateTime,body,webLink`, { Prefer: 'outlook.body-content-type="text"' })) as Record<string, any>;
  return c.json({ id: m.id, subject: m.subject ?? "", from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || "", fromEmail: m.from?.emailAddress?.address ?? "", to: (m.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean), receivedAt: m.receivedDateTime, body: String(m.body?.content ?? "").slice(0, 100_000), webLink: m.webLink ?? null });
});
