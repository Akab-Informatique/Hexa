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

// ---- Documentation (SharePoint through the API, folder rules in the portal) ----
const groupsList = (await call("GET", "/api/admin/groups")).body;
const staffGroup = groupsList.find((g) => g.slug === "staff");
const dEmail = `smoke-docs-${Date.now()}@example.com`;
const dUser = await call("POST", "/api/admin/users", { email: dEmail, name: "SMOKE Docs User", groupIds: [staffGroup.id] });
ok("create restricted user", dUser.status === 201, JSON.stringify(dUser.body));
let uc = "";
{
  const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: dEmail, password: dUser.body.temporaryPassword }) });
  uc = r.headers.get("set-cookie").split(";")[0];
  await call("POST", "/api/auth/password", { current: dUser.body.temporaryPassword, next: "Dev-only-pass-2026!" }, uc);
}
const adminLibs = (await call("GET", "/api/docs/libraries")).body;
const clientsLib = adminLibs.find((l) => l.name.startsWith("Dossiers clients"))?.id;
ok("admin (docs.manage) sees every library", adminLibs.length === 3 && Boolean(clientsLib));
ok("no rule: a user sees no library", (await call("GET", "/api/docs/libraries", undefined, uc)).body.length === 0);
ok("no rule: browsing is refused", (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Acme%20Corp`, undefined, uc)).status === 403);
ok("a user cannot manage access", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Acme Corp", principalType: "user", principalId: dUser.body.id, level: "edit" }, uc)).status === 403);
ok("rule on a missing folder is refused", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Nope", principalType: "user", principalId: dUser.body.id, level: "view" })).status === 404);
ok("give read access to one client folder", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Acme Corp", principalType: "user", principalId: dUser.body.id, level: "view" })).status === 200);
const ulibs = (await call("GET", "/api/docs/libraries", undefined, uc)).body;
ok("user now sees only that library", ulibs.length === 1 && ulibs[0].id === clientsLib);
const root = (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=`, undefined, uc)).body;
ok("library root shows only the way to the allowed folder", root.level === "path" && root.items.length === 1 && root.items[0].name === "Acme Corp", JSON.stringify(root));
const sub = await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Acme%20Corp%2F2025`, undefined, uc);
ok("access is inherited by sub-folders", sub.status === 200 && sub.body.level === "view" && sub.body.items.some((i) => i.name === "Bilan.txt"));
ok("another client's folder is refused", (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Boulangerie%20Dupont`, undefined, uc)).status === 403);
const dl = await fetch(BASE + `/api/docs/file?drive=${clientsLib}&path=${encodeURIComponent("Acme Corp/2025/Bilan.txt")}`, { headers: { cookie: uc } });
ok("download within access", dl.status === 200 && (await dl.text()).includes("Bilan"));
const dl2 = await fetch(BASE + `/api/docs/file?drive=${clientsLib}&path=${encodeURIComponent("Boulangerie Dupont/2025/Déclaration TPS-TVQ.txt")}`, { headers: { cookie: uc } });
ok("download outside access refused", dl2.status === 403);
const up = (c0, p0, n) => fetch(BASE + `/api/docs/file?drive=${clientsLib}&path=${encodeURIComponent(p0)}&name=${encodeURIComponent(n)}`, { method: "PUT", headers: { cookie: c0, "content-type": "application/octet-stream", "x-nexo-upload": "1" }, body: "hello" });
ok("read-only access cannot upload", (await up(uc, "Acme Corp/2025", "x.txt")).status === 403);
ok("path traversal refused", (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Acme%20Corp%2F..%2FBoulangerie`, undefined, uc)).status === 400);
ok("edit access on a sub-folder", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Acme Corp/2025", principalType: "user", principalId: dUser.body.id, level: "edit" })).status === 200);
ok("edit access can upload", (await up(uc, "Acme Corp/2025", "smoke.txt")).status === 200);
ok("…but not above that folder", (await up(uc, "Acme Corp", "smoke.txt")).status === 403);
ok("create a sub-folder", (await call("POST", "/api/docs/folder", { drive: clientsLib, path: "Acme Corp/2025", name: `SMOKE-${Date.now()}` }, uc)).status === 200);
const rules = (await call("GET", `/api/docs/access?drive=${clientsLib}`)).body;
for (const r of rules.filter((x) => x.principalId === dUser.body.id)) await call("DELETE", `/api/docs/access/${r.id}`);
ok("removing the rules removes the access", (await call("GET", "/api/docs/libraries", undefined, uc)).body.length === 0);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
