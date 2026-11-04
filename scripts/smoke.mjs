// End-to-end API smoke test against a running dev stack (`npm run dev`).
//   node scripts/smoke.mjs <email> <password>
// Creates throwaway data (prefixed "SMOKE") and checks the main business rules.
const BASE = process.env.API ?? "http://127.0.0.1:3000";
const [email, password] = process.argv.slice(2);
let cookie = "";
let failures = 0;

async function call(method, path, data, as = cookie) {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", cookie: as }, body: data === undefined ? undefined : JSON.stringify(data) });
  const set = res.headers.get("set-cookie");
  if (set && as === cookie && path === "/api/auth/login") cookie = set.split(";")[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: set };
}
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); if (!cond) failures++; };

let login = await call("POST", "/api/auth/login", { email, password });
if (login.body?.stage === "password") {
  // Fresh dev database: the first login forces a new password (dev-only value, also printed for you).
  const next = process.argv[4] ?? "Dev-only-pass-2026!";
  const ch = await call("POST", "/api/auth/password", { current: password, next });
  login = { status: ch.status, body: ch.body };
  console.log("(first login: password changed to the dev value)");
}
ok("login", login.status === 200 && login.body.stage === "ready", JSON.stringify(login.body));

// ---- Clients ----
const client = await call("POST", "/api/clients", { name: "SMOKE Client Inc." });
ok("create client", client.status === 201);
const cid = client.body.id;
const contact = await call("POST", `/api/clients/${cid}/contacts`, { name: "Jane Doe", email: "jane@example.com" });
ok("first contact auto-primary", contact.status === 201 && (await call("GET", `/api/clients/${cid}`)).body.contacts[0].isPrimary === true);
const contract = await call("POST", `/api/clients/${cid}/contracts`, { name: "Support", kind: "hourly", hourlyRate: 120 });
ok("create hourly contract", contract.status === 201);

// ---- Tasks ----
const t1 = await call("POST", "/api/tasks", { title: "SMOKE recurring", clientId: cid, dueDate: "2026-11-30", recurrence: { every: 1, unit: "month" } });
ok("create task", t1.status === 201);
const chk = await call("POST", `/api/tasks/${t1.body.id}/checklist`, { text: "step 1" });
const blocked = await call("PATCH", `/api/tasks/${t1.body.id}`, { status: "done" });
ok("open checklist blocks completion", blocked.status === 409);
await call("PATCH", `/api/tasks/checklist/${chk.body.id}`, { done: true });
const done = await call("PATCH", `/api/tasks/${t1.body.id}`, { status: "done" });
ok("completing recurring task spawns the next one", done.status === 200 && done.body.nextId);
const next = (await call("GET", `/api/tasks/${done.body.nextId}`)).body;
ok("next occurrence is a month later with reset checklist", next.dueDate === "2026-12-30" && next.checklist.length === 1 && next.checklist[0].done === false, JSON.stringify(next.dueDate));
const a = await call("POST", "/api/tasks", { title: "SMOKE A" });
const b = await call("POST", "/api/tasks", { title: "SMOKE B", waitsForId: a.body.id });
ok("task waiting on another cannot be completed", (await call("PATCH", `/api/tasks/${b.body.id}`, { status: "done" })).status === 409);
ok("dependency loop refused", (await call("PATCH", `/api/tasks/${a.body.id}`, { waitsForId: b.body.id })).status === 400);
const priv = await call("POST", "/api/tasks", { title: "SMOKE private", visibility: "private" });
ok("private task visible to creator", (await call("GET", `/api/tasks/${priv.body.id}`)).status === 200);

// ---- Team ----
const dashes = await call("GET", "/api/team/dashboards");
ok("starter dashboard auto-created", dashes.status === 200 && dashes.body.length >= 1 && dashes.body[0].canEdit);
const copy = await call("POST", `/api/team/dashboards/${dashes.body[0].id}/copy`);
ok("copy dashboard", copy.status === 201);
const lock = await call("PATCH", `/api/team/dashboards/${copy.body.id}`, { locked: true });
ok("lock dashboard", lock.status === 200);
const meeting = await call("GET", "/api/team/meeting");
ok("meeting loads", meeting.status === 200 && Array.isArray(meeting.body.review) && meeting.body.review.length === 4);
const pt = await call("POST", "/api/team/meeting/points", { weekStart: meeting.body.week, title: "SMOKE point" });
ok("add meeting point", pt.status === 201);

// ---- Timesheet -> work to bill -> invoice ----
const entry = await call("POST", "/api/my/timesheet", { workDate: "2026-11-02", minutes: 90, clientId: cid, description: "SMOKE work" });
ok("add time entry", entry.status === 201);
ok("submit week", (await call("POST", "/api/my/timesheet/submit", { week: "2026-11-02" })).body.submitted >= 1);
ok("cannot approve own time", (await call("POST", `/api/my/timesheet/${entry.body.id}/decision`, { decision: "approve" })).status === 403);

const item = await call("POST", "/api/accounting/billing-items", { clientId: cid, description: "SMOKE consulting", quantity: 2, unitPrice: 100.5 });
ok("create billing item", item.status === 201);
ok("approve billing item", (await call("POST", "/api/accounting/billing-items/decision", { ids: [item.body.id], decision: "approve" })).body.updated === 1);
const inv = await call("POST", "/api/accounting/invoices/from-items", { clientId: cid });
ok("invoice from approved items", inv.status === 200 && inv.body.created.length === 1);
const invoice = (await call("GET", `/api/accounting/invoices/${inv.body.created[0]}`)).body;
ok("invoice totals (2 x 100.50 = 201.00; GST 10.05; QST 20.05; total 231.10)", invoice.subtotal === 201 && invoice.gst === 10.05 && invoice.qst === 20.05 && invoice.total === 231.1, JSON.stringify([invoice.subtotal, invoice.gst, invoice.qst, invoice.total]));
ok("send invoice", (await call("POST", `/api/accounting/invoices/${invoice.id}/action`, { action: "send" })).status === 200);
ok("sent invoice cannot be edited", (await call("PUT", `/api/accounting/invoices/${invoice.id}`, { lines: [{ description: "x", quantity: 1, unitPrice: 1 }] })).status === 409);
ok("void releases work to bill", (await call("POST", `/api/accounting/invoices/${invoice.id}/action`, { action: "void" })).status === 200 && (await call("GET", "/api/accounting/billing-items?status=approved")).body.some((x) => x.id === item.body.id));
ok("client with history cannot be deleted", (await call("DELETE", `/api/clients/${cid}`)).status === 409);

// ---- Vendors ----
const vendor = await call("POST", "/api/accounting/vendors", { name: "SMOKE Vendor" });
const bill = await call("POST", "/api/accounting/bills", { vendorId: vendor.body.id, dueDate: "2026-01-01", amount: 500 });
const bills = await call("GET", "/api/accounting/bills");
ok("overdue bill counted", bill.status === 201 && bills.body.totals.overdue >= 500);

// ---- Board, docs, KB, procedures, HR, integrations ----
ok("post board message", (await call("POST", "/api/command/board", { title: "SMOKE msg", audience: "selected", clientIds: [cid], emailCopy: true })).status === 201);
ok("selected audience needs a client", (await call("POST", "/api/command/board", { title: "x", audience: "selected", clientIds: [] })).status === 400);
ok("doc link only http(s)", (await call("POST", "/api/command/docs", { title: "bad", url: "javascript:alert(1)" })).status === 400);
ok("doc link", (await call("POST", "/api/command/docs", { title: "SMOKE doc", url: "https://example.sharepoint.com/x" })).status === 201);
ok("kb article", (await call("POST", "/api/my/kb", { title: "SMOKE kb", body: "hello" })).status === 201);
const proc = await call("POST", "/api/my/procedures", { title: "SMOKE proc", steps: [{ title: "one" }, { title: "two" }] });
ok("procedure with steps", proc.status === 201 && (await call("GET", `/api/my/procedures/${proc.body.id}`)).body.steps.length === 2);
ok("hr staff list", (await call("GET", "/api/hr/staff")).status === 200);
const put = await call("PUT", "/api/admin/integrations/mailjet", { values: { senderEmail: "a@b.co", apiKey: "k", secretKey: "s" } });
const list = (await call("GET", "/api/admin/integrations")).body.find((x) => x.provider === "mailjet");
ok("integration secrets stored but never returned", put.status === 200 && list.fields.find((f) => f.key === "apiKey").isSet === true && list.fields.find((f) => f.key === "apiKey").value === "" && !JSON.stringify(list).includes('"k"'));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
