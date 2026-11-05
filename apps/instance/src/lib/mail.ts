import { http, loadIntegration, ServiceError, URLS } from "./services.ts";

// Sending email through the firm's own Mailjet account (Send API v3.1). Nothing is ever sent unless the integration
// is saved and switched on; callers check `mailReady()` and keep the message "pending" otherwise.
export interface Recipient { email: string; name?: string }
export interface Mail { to: Recipient[]; subject: string; html: string; text?: string; replyTo?: Recipient; from?: Recipient }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const validEmail = (s: string | null | undefined): s is string => Boolean(s && EMAIL.test(s.trim()));

export async function mailReady(): Promise<boolean> {
  const m = await loadIntegration("mailjet");
  return m.enabled && Boolean(m.secrets.apiKey && m.secrets.secretKey && validEmail(m.config.senderEmail));
}

/** Sends one message to all its recipients (one email each: nobody sees the others' addresses). */
export async function sendMail(mail: Mail): Promise<{ sent: number; failed: { email: string; error: string }[] }> {
  const m = await loadIntegration("mailjet");
  if (!m.enabled || !m.secrets.apiKey || !m.secrets.secretKey || !validEmail(m.config.senderEmail)) throw new ServiceError(409, "mailjet_not_configured");
  const to = mail.to.filter((r) => validEmail(r.email));
  const failed = mail.to.filter((r) => !validEmail(r.email)).map((r) => ({ email: r.email, error: "invalid_address" }));
  let sent = 0;
  const from = mail.from ?? { email: m.config.senderEmail, name: m.config.senderName || undefined };
  // The API takes up to 50 messages a call.
  for (let i = 0; i < to.length; i += 50) {
    const chunk = to.slice(i, i + 50);
    const res = await http(`${URLS.mailjet()}/v3.1/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`${m.secrets.apiKey}:${m.secrets.secretKey}`).toString("base64")}` },
      body: JSON.stringify({ Messages: chunk.map((r) => ({
        From: { Email: from.email, ...(from.name ? { Name: from.name } : {}) }, To: [{ Email: r.email, ...(r.name ? { Name: r.name } : {}) }],
        ...(mail.replyTo ? { ReplyTo: { Email: mail.replyTo.email, ...(mail.replyTo.name ? { Name: mail.replyTo.name } : {}) } } : {}),
        Subject: mail.subject, HTMLPart: mail.html, ...(mail.text ? { TextPart: mail.text } : {}),
      })) }),
    });
    if (res.status === 401 || res.status === 403) throw new ServiceError(502, "mailjet_refused", "the API key or secret key was refused");
    const j = (await res.json().catch(() => null)) as { Messages?: { Status: string; Errors?: { ErrorMessage?: string }[] }[] } | null;
    chunk.forEach((r, idx) => {
      const st = j?.Messages?.[idx];
      if (res.ok && st?.Status === "success") sent++; else failed.push({ email: r.email, error: st?.Errors?.[0]?.ErrorMessage ?? `http_${res.status}` });
    });
  }
  return { sent, failed };
}

// ------------------------------------------------------------------ Message texts (French and English)
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const money = (n: number, lang: "fr" | "en") => new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: "CAD" }).format(n);
const day = (s: string, lang: "fr" | "en") => new Date(`${String(s).slice(0, 10)}T12:00:00`).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { year: "numeric", month: "long", day: "numeric" });
const wrap = (firm: string, inner: string) => `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#1a1a1f;max-width:600px">${inner}<p style="margin-top:28px;color:#666">${esc(firm)}</p></div>`;

export interface InvoiceMailData { firm: string; number: string; client: string; total: number; balance: number; issueDate: string; dueDate: string; poNumber: string; daysLate: number; note?: string }

export function invoiceMail(d: InvoiceMailData, lang: "fr" | "en", kind: "sent" | "reminder"): { subject: string; html: string; text: string } {
  const fr = lang === "fr";
  const late = kind === "reminder" && d.daysLate > 0;
  const subject = kind === "sent" ? (fr ? `Facture ${d.number}` : `Invoice ${d.number}`) : (fr ? `Rappel : facture ${d.number} en retard de ${d.daysLate} jours` : `Reminder: invoice ${d.number} is ${d.daysLate} days late`);
  const intro = kind === "sent" ? (fr ? "Veuillez trouver ci-dessous le détail de votre facture." : "Please find the details of your invoice below.")
    : (fr ? `Sauf erreur, la facture ci-dessous est en retard de ${d.daysLate} jour(s). Si vous l'avez déjà payée, merci d'ignorer ce message.` : `Unless we are mistaken, the invoice below is ${d.daysLate} day(s) late. If you have already paid it, please ignore this message.`);
  const rows: [string, string][] = [[fr ? "Facture" : "Invoice", d.number], [fr ? "Date" : "Date", day(d.issueDate, lang)], [fr ? "Échéance" : "Due", day(d.dueDate, lang)], ...(d.poNumber ? [[fr ? "Bon de commande" : "PO number", d.poNumber] as [string, string]] : []), [fr ? "Total" : "Total", money(d.total, lang)], [fr ? "Solde dû" : "Balance due", money(d.balance, lang)]];
  const html = wrap(d.firm, `<p>${fr ? "Bonjour" : "Hello"} ${esc(d.client)},</p><p>${intro}</p><table style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#666">${esc(k)}</td><td style="padding:4px 0;${k === (fr ? "Solde dû" : "Balance due") ? "font-weight:700" : ""}">${esc(v)}</td></tr>`).join("")}</table>${d.note ? `<p>${esc(d.note).replace(/\n/g, "<br>")}</p>` : ""}<p>${fr ? "Merci de votre confiance." : "Thank you for your business."}</p>`);
  const text = `${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}${d.note ? `\n\n${d.note}` : ""}`;
  void late;
  return { subject, html, text };
}

export interface StatementMailData { firm: string; client: string; total: number; pastDue: number; rows: { number: string; dueDate: string; balance: number; daysLate: number }[] }
export function statementMail(d: StatementMailData, lang: "fr" | "en") {
  const fr = lang === "fr";
  const subject = fr ? `Relevé de compte : ${money(d.total, lang)} à payer` : `Account statement: ${money(d.total, lang)} owed`;
  const html = wrap(d.firm, `<p>${fr ? "Bonjour" : "Hello"} ${esc(d.client)},</p><p>${fr ? "Voici l'état de votre compte." : "Here is the state of your account."}</p><table style="border-collapse:collapse"><tr style="color:#666"><td style="padding:4px 14px 4px 0">${fr ? "Facture" : "Invoice"}</td><td style="padding:4px 14px">${fr ? "Échéance" : "Due"}</td><td style="padding:4px 14px">${fr ? "Retard" : "Late"}</td><td style="padding:4px 0;text-align:right">${fr ? "Solde" : "Balance"}</td></tr>${d.rows.map((r) => `<tr><td style="padding:4px 14px 4px 0">${esc(r.number)}</td><td style="padding:4px 14px">${esc(day(r.dueDate, lang))}</td><td style="padding:4px 14px">${r.daysLate ? `${r.daysLate} ${fr ? "j" : "d"}` : "—"}</td><td style="padding:4px 0;text-align:right">${esc(money(r.balance, lang))}</td></tr>`).join("")}</table><p><b>${fr ? "Total dû" : "Total owed"}: ${esc(money(d.total, lang))}</b>${d.pastDue ? ` (${fr ? "dont en retard" : "of which late"}: ${esc(money(d.pastDue, lang))})` : ""}</p>`);
  const text = `${d.rows.map((r) => `${r.number}  ${day(r.dueDate, lang)}  ${money(r.balance, lang)}`).join("\n")}\n\n${fr ? "Total dû" : "Total owed"}: ${money(d.total, lang)}`;
  return { subject, html, text };
}

export function boardMail(firm: string, title: string, bodyText: string, lang: "fr" | "en") {
  void lang;
  return { subject: title, html: wrap(firm, `<h2 style="margin:0 0 12px">${esc(title)}</h2><p>${esc(bodyText).replace(/\n/g, "<br>")}</p>`), text: `${title}\n\n${bodyText}` };
}
