// Local stand-in for Mailjet, Microsoft (sign-in + Graph) and Intuit (sign-in + QuickBooks Online), for development and
// the smoke tests. It checks what the app sends (credentials, headers, bodies), so a mistake shows up here and not in
// front of a client. Started by `npm run dev`; never used in production (the app ignores the *_URL overrides there).
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 9099);
const MS = { clientId: "ms-client-id", secret: "ms-secret", code: "MSCODE" };
const QB = { clientId: "qb-client-id", secret: "qb-secret", code: "QBCODE", realm: "9130000000000001" };
const MJ = { auth: "Basic " + Buffer.from("mock-key:mock-secret").toString("base64") };

const state = { mails: [], seq: 1, msAccess: new Set(), msRefresh: new Set(), qbAccess: new Set(), qbRefresh: new Set(), customers: [], items: [], invoices: [], nextId: 100 };
const reset = () => {
  Object.assign(state, { mails: [], msAccess: new Set(), msRefresh: new Set(), qbAccess: new Set(), qbRefresh: new Set(), nextId: 100 });
  state.customers = [{ Id: "58", DisplayName: "Boulangerie Dupont", SyncToken: "0" }, { Id: "59", DisplayName: "Autre Client Ltée", SyncToken: "0" }];
  state.items = [];
  state.invoices = [];
};
reset();

const send = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
const fault = (res, status, code, message, detail = "") => send(res, status, { Fault: { Error: [{ Message: message, Detail: detail, code }], type: "ValidationFault" } });
const bearer = (req, set) => { const h = req.headers.authorization ?? ""; return h.startsWith("Bearer ") && set.has(h.slice(7)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const raw = req.method === "POST" || req.method === "PUT" ? await readBody(req) : "";
  const json = () => { try { return JSON.parse(raw); } catch { return {}; } };
  const form = () => new URLSearchParams(raw);

  // ---------------- test controls
  if (p === "/_mock/reset") { reset(); return send(res, 200, { ok: true }); }
  if (p === "/_mock/mail") return send(res, 200, state.mails);
  if (p === "/_mock/expire") { state.msAccess.clear(); state.qbAccess.clear(); return send(res, 200, { ok: true }); }
  if (p === "/_mock/revoke") { state.msRefresh.clear(); state.msAccess.clear(); state.qbRefresh.clear(); state.qbAccess.clear(); return send(res, 200, { ok: true }); }
  if (p === "/_mock/qbo/pay") { const b = json(); const inv = state.invoices.find((i) => i.Id === b.invoiceId); if (inv) inv.Balance = Math.max(0, Math.round((inv.Balance - Number(b.amount)) * 100) / 100); return send(res, 200, { ok: Boolean(inv), balance: inv?.Balance }); }
  if (p === "/_mock/qbo/state") return send(res, 200, { customers: state.customers, invoices: state.invoices, items: state.items });

  // ---------------- Mailjet
  if (p === "/v3.1/send" && req.method === "POST") {
    if (req.headers.authorization !== MJ.auth) return send(res, 401, { ErrorMessage: "API key authentication/authorization failure" });
    const b = json();
    const out = (b.Messages ?? []).map((m) => {
      const bad = !m.From?.Email || !m.To?.[0]?.Email || !m.Subject || !(m.HTMLPart || m.TextPart);
      if (bad || String(m.To[0].Email).startsWith("reject@")) return { Status: "error", Errors: [{ ErrorMessage: bad ? "Missing field" : "Recipient rejected" }] };
      state.mails.push({ id: state.seq++, from: m.From, to: m.To, replyTo: m.ReplyTo ?? null, subject: m.Subject, html: m.HTMLPart ?? "", text: m.TextPart ?? "" });
      return { Status: "success", To: m.To.map((t) => ({ Email: t.Email, MessageID: 1000 + state.seq })) };
    });
    return send(res, out.some((o) => o.Status === "error") ? 400 : 200, { Messages: out });
  }

  // ---------------- Microsoft sign-in
  let m = /^\/mslogin\/([^/]+)\/oauth2\/v2\.0\/(authorize|token)$/.exec(p);
  if (m) {
    if (m[2] === "authorize") {
      if (url.searchParams.get("client_id") !== MS.clientId) return send(res, 400, { error: "invalid_client" });
      const to = new URL(url.searchParams.get("redirect_uri"));
      to.searchParams.set("code", MS.code); to.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: to.toString() }); return res.end();
    }
    const f = form();
    if (f.get("client_id") !== MS.clientId || f.get("client_secret") !== MS.secret) return send(res, 401, { error: "invalid_client" });
    const grant = f.get("grant_type");
    const issue = (refresh) => { const a = `ms-access-${state.seq++}`; state.msAccess.add(a); const r = refresh ? `ms-refresh-${state.seq++}` : undefined; if (r) state.msRefresh.add(r); return { access_token: a, ...(r ? { refresh_token: r } : {}), expires_in: 3600, scope: f.get("scope") }; };
    if (grant === "authorization_code") { if (f.get("code") !== MS.code || !f.get("redirect_uri")) return send(res, 400, { error: "invalid_grant", error_description: "bad code" }); return send(res, 200, issue(true)); }
    if (grant === "refresh_token") { const rt = f.get("refresh_token"); if (!state.msRefresh.has(rt)) return send(res, 400, { error: "invalid_grant", error_description: "refresh token revoked" }); state.msRefresh.delete(rt); return send(res, 200, issue(true)); }
    if (grant === "client_credentials") return send(res, 200, issue(false));
    return send(res, 400, { error: "unsupported_grant_type" });
  }

  // ---------------- Microsoft Graph
  if (p.startsWith("/graph/v1.0/")) {
    if (!bearer(req, state.msAccess)) return send(res, 401, { error: { code: "InvalidAuthenticationToken" } });
    const path = p.slice("/graph/v1.0".length);
    if (path === "/me") return send(res, 200, { displayName: "Marie Test", mail: "marie@acme.test", userPrincipalName: "marie@acme.test" });
    if (path === "/me/calendarView") {
      const day = String(url.searchParams.get("startDateTime") ?? "2026-01-05").slice(0, 10);
      if (!req.headers.prefer?.includes("America/Toronto")) return send(res, 400, { error: { code: "MissingPrefer" } });
      return send(res, 200, { value: [
        { id: "ev1", subject: "Réunion client", start: { dateTime: `${day}T09:00:00.0000000`, timeZone: "Eastern Standard Time" }, end: { dateTime: `${day}T10:00:00.0000000`, timeZone: "Eastern Standard Time" }, isAllDay: false, location: { displayName: "Salle A" }, showAs: "busy", sensitivity: "normal", webLink: "https://outlook.example/ev1" },
        { id: "ev2", subject: "Rendez-vous médical", start: { dateTime: `${day}T14:00:00.0000000`, timeZone: "Eastern Standard Time" }, end: { dateTime: `${day}T15:00:00.0000000`, timeZone: "Eastern Standard Time" }, isAllDay: false, location: { displayName: "Clinique" }, showAs: "busy", sensitivity: "private", webLink: "https://outlook.example/ev2" },
        { id: "ev3", subject: "Congé férié", start: { dateTime: `${day}T00:00:00.0000000`, timeZone: "Eastern Standard Time" }, end: { dateTime: `${day}T23:59:00.0000000`, timeZone: "Eastern Standard Time" }, isAllDay: true, location: { displayName: "" }, showAs: "free", sensitivity: "normal", webLink: null },
      ] });
    }
    if (path === "/me/mailFolders/inbox/messages") return send(res, 200, { value: [
      { id: "AAMkAGMock0000001", subject: "Pièces justificatives T2", from: { emailAddress: { name: "Luc Lavoie", address: "luc@lavoie.example" } }, receivedDateTime: "2026-11-04T14:00:00Z", isRead: false, bodyPreview: "Voici les pièces demandées…", hasAttachments: true, webLink: "https://outlook.example/m1" },
      { id: "AAMkAGMock0000002", subject: "Question sur la TPS", from: { emailAddress: { name: "Marie Dupont", address: "marie@dupont.example" } }, receivedDateTime: "2026-11-03T10:30:00Z", isRead: true, bodyPreview: "Bonjour, une question…", hasAttachments: false, webLink: "https://outlook.example/m2" },
    ] });
    const msg = /^\/me\/messages\/(.+)$/.exec(path);
    if (msg) {
      if (!req.headers.prefer?.includes('body-content-type="text"')) return send(res, 400, { error: { code: "MissingPrefer" } });
      return send(res, 200, { id: msg[1], subject: "Pièces justificatives T2", from: { emailAddress: { name: "Luc Lavoie", address: "luc@lavoie.example" } }, toRecipients: [{ emailAddress: { address: "marie@acme.test" } }], receivedDateTime: "2026-11-04T14:00:00Z", body: { contentType: "text", content: "Bonjour,\nVoici les pièces demandées.\n<script>alert(1)</script>" }, webLink: "https://outlook.example/m1" });
    }
    return send(res, 404, { error: { code: "NotFound" } });
  }

  // ---------------- Intuit sign-in
  if (p === "/intuit/connect/oauth2") {
    if (url.searchParams.get("client_id") !== QB.clientId) return send(res, 400, { error: "invalid_client" });
    const to = new URL(url.searchParams.get("redirect_uri"));
    to.searchParams.set("code", QB.code); to.searchParams.set("state", url.searchParams.get("state") ?? ""); to.searchParams.set("realmId", QB.realm);
    res.writeHead(302, { location: to.toString() }); return res.end();
  }
  if (p === "/intuit/oauth2/v1/tokens/bearer" && req.method === "POST") {
    if (req.headers.authorization !== "Basic " + Buffer.from(`${QB.clientId}:${QB.secret}`).toString("base64")) return send(res, 401, { error: "invalid_client" });
    const f = form();
    const issue = () => { const a = `qb-access-${state.seq++}`, r = `qb-refresh-${state.seq++}`; state.qbAccess.add(a); state.qbRefresh.add(r); return { access_token: a, refresh_token: r, expires_in: 3600, x_refresh_token_expires_in: 8726400, token_type: "bearer" }; };
    if (f.get("grant_type") === "authorization_code") return f.get("code") === QB.code && f.get("redirect_uri") ? send(res, 200, issue()) : send(res, 400, { error: "invalid_grant" });
    if (f.get("grant_type") === "refresh_token") { const rt = f.get("refresh_token"); if (!state.qbRefresh.has(rt)) return send(res, 400, { error: "invalid_grant" }); state.qbRefresh.delete(rt); return send(res, 200, issue()); }
    return send(res, 400, { error: "unsupported_grant_type" });
  }

  // ---------------- QuickBooks Online
  m = /^\/qbo\/v3\/company\/([^/]+)(\/.*)$/.exec(p);
  if (m) {
    if (!bearer(req, state.qbAccess)) return send(res, 401, { Fault: { Error: [{ Message: "AuthenticationFailed", code: "100" }], type: "AUTHENTICATION" } });
    if (m[1] !== QB.realm) return fault(res, 400, "610", "Company not found");
    if (!url.searchParams.get("minorversion")) return fault(res, 400, "2020", "minorversion missing");
    const path = m[2];
    if (path === "/query") {
      const sql = url.searchParams.get("query") ?? "";
      if (/from Customer/i.test(sql)) {
        const name = /DisplayName = '((?:[^'\\]|\\.)*)'/i.exec(sql)?.[1]?.replace(/\\'/g, "'");
        return send(res, 200, { QueryResponse: { Customer: name ? state.customers.filter((c) => c.DisplayName === name) : state.customers } });
      }
      if (/from Item/i.test(sql)) return send(res, 200, { QueryResponse: { Item: state.items.filter((i) => /Name = 'Services'/.test(sql) ? i.Name === "Services" : true) } });
      if (/from Account/i.test(sql)) return send(res, 200, { QueryResponse: { Account: [{ Id: "1", Name: "Services", AccountType: "Income" }] } });
      return send(res, 200, { QueryResponse: {} });
    }
    if (path === "/customer" && req.method === "POST") {
      const b = json();
      if (!b.DisplayName) return fault(res, 400, "2020", "DisplayName required");
      if (state.customers.some((c) => c.DisplayName === b.DisplayName)) return fault(res, 400, "6240", "Duplicate Name Exists Error", `The name supplied already exists. : Id=${state.customers.find((c) => c.DisplayName === b.DisplayName).Id}`);
      const c = { Id: String(state.nextId++), SyncToken: "0", ...b };
      state.customers.push(c);
      return send(res, 200, { Customer: c });
    }
    if (path === "/item" && req.method === "POST") { const b = json(); if (!b.IncomeAccountRef?.value) return fault(res, 400, "2020", "IncomeAccountRef required"); const it = { Id: String(state.nextId++), SyncToken: "0", ...b }; state.items.push(it); return send(res, 200, { Item: it }); }
    if (path === "/invoice" && req.method === "POST") {
      const b = json();
      if (!b.CustomerRef?.value || !state.customers.some((c) => c.Id === b.CustomerRef.value)) return fault(res, 400, "2500", "Invalid Reference Id", "CustomerRef");
      if (!Array.isArray(b.Line) || !b.Line.length || b.Line.some((l) => !l.SalesItemLineDetail?.ItemRef?.value)) return fault(res, 400, "2020", "Line with ItemRef required");
      const total = Math.round(b.Line.reduce((a, l) => a + Number(l.Amount), 0) * 100) / 100;
      if (b.Id) {
        const cur = state.invoices.find((i) => i.Id === b.Id);
        if (!cur) return fault(res, 400, "610", "Object Not Found");
        if (b.SyncToken !== cur.SyncToken) return fault(res, 400, "5010", "Stale Object Error");
        const paid = Math.round((cur.TotalAmt - cur.Balance) * 100) / 100;
        Object.assign(cur, b, { TotalAmt: total, Balance: Math.round((total - paid) * 100) / 100, SyncToken: String(Number(cur.SyncToken) + 1) });
        return send(res, 200, { Invoice: cur });
      }
      const inv = { Id: String(state.nextId++), SyncToken: "0", TotalAmt: total, Balance: total, ...b };
      state.invoices.push(inv);
      return send(res, 200, { Invoice: inv });
    }
    const one = /^\/invoice\/(.+)$/.exec(path);
    if (one && req.method === "GET") { const inv = state.invoices.find((i) => i.Id === one[1]); return inv ? send(res, 200, { Invoice: inv }) : fault(res, 404, "610", "Object Not Found"); }
    return send(res, 404, { Fault: { Error: [{ Message: "Not found" }] } });
  }

  send(res, 404, { error: "not found", path: p });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[mock-services] on :${PORT} (Mailjet, Microsoft, Intuit)`));
