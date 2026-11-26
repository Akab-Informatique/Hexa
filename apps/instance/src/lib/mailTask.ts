import { pool } from "../db.ts";
import { graphGet } from "./microsoft.ts";
import { ServiceError } from "./services.ts";

// Turning one of the person's own e-mails into a task. Everything from the e-mail is untrusted: text only, capped, and Graph URLs are built here.
export const MAIL_ID = /^[A-Za-z0-9_=\-]{10,400}$/;
export const MAX_FILE_BYTES = 5_000_000; // same cap as task files (7 MB of base64)
export const MAX_TASK_FILES = 20;
const MAX_DESC = 20_000;
const FREE_DOMAINS = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "yahoo.ca", "icloud.com", "me.com", "videotron.ca", "bell.net", "sympatico.ca", "protonmail.com", "aol.com"]);

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Plain text from whatever Graph sends (it is asked for text; HTML is stripped anyway as a safety net). */
export function toPlainText(content: string, type: string): string {
  let s = String(content ?? "");
  if (String(type).toLowerCase() === "html") {
    s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  }
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export const cleanSubject = (s: string) => clip(String(s ?? "").replace(/^\s*((re|tr|fw|fwd|rv)\s*:\s*)+/i, "").trim() || "(sans objet)", 300);

export interface MailAttachment { id: string; name: string; size: number; contentType: string }

export async function mailForTask(userId: string, id: string) {
  const m = (await graphGet(userId, `/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,receivedDateTime,body,webLink,hasAttachments`, { Prefer: 'outlook.body-content-type="text"' })) as Record<string, any>;
  const fromName = String(m.from?.emailAddress?.name ?? "").slice(0, 200);
  const fromEmail = String(m.from?.emailAddress?.address ?? "").slice(0, 320);
  const receivedAt = String(m.receivedDateTime ?? "");
  const text = toPlainText(m.body?.content ?? "", m.body?.contentType ?? "text");
  const head = `De : ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}\nReçu le : ${receivedAt ? receivedAt.slice(0, 16).replace("T", " ") + " UTC" : ""}\n\n`;
  const webLink = typeof m.webLink === "string" && /^https:\/\//.test(m.webLink) ? m.webLink.slice(0, 2000) : null;
  let attachments: MailAttachment[] = [];
  if (m.hasAttachments) {
    const a = (await graphGet(userId, `/me/messages/${encodeURIComponent(id)}/attachments?$select=id,name,size,contentType,isInline`)) as { value?: Record<string, any>[] };
    attachments = (a.value ?? [])
      .filter((x) => String(x["@odata.type"] ?? "#microsoft.graph.fileAttachment").endsWith("fileAttachment") && !x.isInline && MAIL_ID.test(String(x.id)))
      .slice(0, 50).map((x) => ({ id: String(x.id), name: clip(String(x.name || "fichier").replace(/[\\/\0]/g, "_"), 200), size: Number(x.size) || 0, contentType: clip(String(x.contentType || "application/octet-stream"), 100) }));
  }
  return { subject: cleanSubject(m.subject), description: clip(head + text, MAX_DESC), from: fromName || fromEmail, fromEmail, receivedAt, webLink, attachments, suggestedClientId: await guessClient(fromEmail) };
}

/** A client only when exactly one matches: the sender's address first (contacts, billing e-mail), then a business domain. */
export async function guessClient(email: string): Promise<string | null> {
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return null;
  const exact = await pool.query("select client_id as id from client_contacts where lower(email) = $1 union select id from clients where lower(billing_email) = $1", [e]);
  if (exact.rowCount === 1) return exact.rows[0].id;
  if (exact.rowCount) return null;
  const domain = e.split("@")[1];
  if (!domain || FREE_DOMAINS.has(domain)) return null;
  const dom = await pool.query("select client_id as id from client_contacts where lower(email) like '%@' || $1 union select id from clients where lower(billing_email) like '%@' || $1", [domain.replace(/[%_\\]/g, "")]);
  return dom.rowCount === 1 ? dom.rows[0].id : null;
}

/** Copies the chosen attachments of the person's own message into the task's files. Returns what was stored and what was skipped. */
export async function copyAttachments(userId: string, taskId: string, messageId: string, ids: string[]) {
  const stored: string[] = []; const skipped: string[] = [];
  let count = Number((await pool.query("select count(*) as n from task_files where task_id = $1", [taskId])).rows[0].n);
  for (const aid of [...new Set(ids)].slice(0, 20)) {
    if (!MAIL_ID.test(aid) || count >= MAX_TASK_FILES) { skipped.push(aid); continue; }
    try {
      const a = (await graphGet(userId, `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(aid)}`)) as Record<string, any>;
      const b64 = typeof a.contentBytes === "string" ? a.contentBytes : "";
      const size = Math.floor((b64.length * 3) / 4);
      if (!String(a["@odata.type"] ?? "").endsWith("fileAttachment") || a.isInline || !b64 || size > MAX_FILE_BYTES) { skipped.push(String(a.name ?? aid)); continue; }
      await pool.query("insert into task_files (task_id, name, content_type, size, data_b64, created_by) values ($1,$2,$3,$4,$5,$6)",
        [taskId, clip(String(a.name || "fichier").replace(/[\\/\0]/g, "_"), 200), clip(String(a.contentType || "application/octet-stream"), 100), size, b64, userId]);
      count++; stored.push(String(a.name ?? aid));
    } catch (e) {
      if (e instanceof ServiceError && e.code === "ms_reauth") throw e;
      skipped.push(aid);
    }
  }
  return { stored, skipped };
}
