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
ok("meeting loads", meeting.status === 200 && Array.isArray(meeting.body.points));
const pt = await call("POST", "/api/team/meeting/points", { title: "SMOKE point" });
ok("add meeting point", pt.status === 201);

// ---- Timesheet -> work to bill -> invoice ----
const entry = await call("POST", "/api/time/entries", { workDate: "2026-11-02", typeKey: "work", minutes: 90, clientId: cid, description: "SMOKE work" });
ok("add time entry", entry.status === 201);
ok("submit week", (await call("POST", "/api/time/week/submit", { start: "2026-11-02" })).body.status === "submitted");
ok("cannot approve own time", (await call("POST", "/api/time/approvals/decision", { userId: (await call("GET", "/api/hr/staff")).body.find((x) => x.email === email).id, start: "2026-11-02", decision: "approve" })).status === 403);

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
const up = (c0, p0, n) => fetch(BASE + `/api/docs/file?drive=${clientsLib}&path=${encodeURIComponent(p0)}&name=${encodeURIComponent(n)}`, { method: "PUT", headers: { cookie: c0, "content-type": "application/octet-stream", "x-hexa-upload": "1" }, body: "hello" });
ok("read-only access cannot upload", (await up(uc, "Acme Corp/2025", "x.txt")).status === 403);
ok("path traversal refused", (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Acme%20Corp%2F..%2FBoulangerie`, undefined, uc)).status === 400);
ok("edit access on a sub-folder", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Acme Corp/2025", principalType: "user", principalId: dUser.body.id, level: "edit" })).status === 200);
ok("edit access can upload", (await up(uc, "Acme Corp/2025", "smoke.txt")).status === 200);
ok("…but not above that folder", (await up(uc, "Acme Corp", "smoke.txt")).status === 403);
ok("create a sub-folder", (await call("POST", "/api/docs/folder", { drive: clientsLib, path: "Acme Corp/2025", name: `SMOKE-${Date.now()}` }, uc)).status === 200);
const rules = (await call("GET", `/api/docs/access?drive=${clientsLib}`)).body;
for (const r of rules.filter((x) => x.principalId === dUser.body.id)) await call("DELETE", `/api/docs/access/${r.id}`);
ok("removing the rules removes the access", (await call("GET", "/api/docs/libraries", undefined, uc)).body.length === 0);

// ---- Timesheets, hours bank, HR ledger ----
const U = dUser.body.id;
const post = (path, data, as) => call("POST", path, data, as);
const wd = { workDate: "2026-01-05", typeKey: "workday", start: "08:00", end: "16:00", bankMinutes: 60 };
ok("work day needs a wage to bank hours", (await post("/api/time/entries", wd, uc)).body?.error === "hr_wage_missing");
await call("PUT", `/api/hr/staff/${U}`, { hourlyWage: 30, jobTitle: "Comptable" });
const wdr = await post("/api/time/entries", wd, uc);
ok("work day created", wdr.status === 201, JSON.stringify(wdr.body));
ok("one work day a day", (await post("/api/time/entries", { ...wd, bankMinutes: 0 }, uc)).status === 409);
ok("short day has no lunch deducted", (await post("/api/time/entries", { workDate: "2026-01-06", typeKey: "workday", start: "08:00", end: "13:00" }, uc)).status === 201);
let wk = (await call("GET", "/api/time/week?start=2026-01-05", undefined, uc)).body;
const day1 = wk.entries.find((e) => e.workDate === "2026-01-05"), day2 = wk.entries.find((e) => e.workDate === "2026-01-06");
ok("8:00-16:00 = 7.5 h paid, 8:00-13:00 = 5 h", day1.minutes === 450 && day2.minutes === 300, JSON.stringify([day1.minutes, day2.minutes]));
ok("paid minutes = work days less banked", wk.totals.paidMinutes === 450 - 60 + 300 && wk.totals.bankedMinutes === 60);
ok("the employee's own week carries no money", !/cents|wage|amount/i.test(JSON.stringify(wk)));
const bal0 = (await call("GET", `/api/hr/staff/${U}/ledger`)).body.balances;
ok("banking 1 h at 30 $ puts 30 $ in the bank", bal0.bankCents === 3000, JSON.stringify(bal0));
const vac = await post("/api/time/entries", { workDate: "2026-01-07", typeKey: "vacation", minutes: 480 }, uc);
ok("vacation can take the bank below zero (flagged)", vac.status === 201 && vac.body.negative.includes("vacation"));
const hol = await post("/api/time/entries", { workDate: "2026-01-12", typeKey: "holiday" }, uc);
const wk2 = (await call("GET", "/api/time/week?start=2026-01-12", undefined, uc)).body;
ok("holiday pay is worked out from the 4 weeks before", hol.status === 201 && wk2.entries[0].minutes === 59, JSON.stringify(wk2.entries));
ok("client work, billable", (await post("/api/time/entries", { workDate: "2026-01-08", typeKey: "work", minutes: 120, clientId: cid, description: "SMOKE conseil", billable: true }, uc)).status === 201);
ok("staff cannot approve", (await post("/api/time/approvals/decision", { userId: U, start: "2026-01-05", decision: "approve" }, uc)).status === 403);
ok("empty week cannot be sent", (await post("/api/time/week/submit", { start: "2026-02-02" }, uc)).body?.error === "week_empty");
ok("send the week", (await post("/api/time/week/submit", { start: "2026-01-05" }, uc)).body?.status === "submitted");
const balSent = (await call("GET", `/api/hr/staff/${U}/ledger`)).body.balances;
ok("4 % of gross pay accrues to the vacation bank", balSent.vacationCents === -24000 + Math.round(((450 - 60 + 300) / 60) * 3000 * 0.04), JSON.stringify(balSent));
ok("a sent week is locked for its owner", (await post("/api/time/entries", { workDate: "2026-01-09", typeKey: "meeting", minutes: 30 }, uc)).body?.error === "timesheet_locked");
ok("a rejection needs a reason", (await post("/api/time/approvals/decision", { userId: U, start: "2026-01-05", decision: "reject" })).status === 400);
await post("/api/time/approvals/decision", { userId: U, start: "2026-01-05", decision: "reject", reason: "SMOKE: corrige le mardi" });
wk = (await call("GET", "/api/time/week?start=2026-01-05", undefined, uc)).body;
ok("rejected week reopens with the reason", wk.status === "rejected" && wk.rejectReason.includes("corrige") && !wk.locked);
ok("accrual is removed while the week is open", (await call("GET", `/api/hr/staff/${U}/ledger`)).body.balances.vacationCents === -24000);
await post("/api/time/week/submit", { start: "2026-01-05" }, uc);
ok("approve the week", (await post("/api/time/approvals/decision", { userId: U, start: "2026-01-05", decision: "approve" })).status === 200);
ok("billable client time became work to bill", (await call("GET", "/api/accounting/billing-items?status=pending")).body.some((x) => x.description === "SMOKE conseil" && Number(x.quantity) === 2));
ok("mark paid", (await post("/api/time/approvals/paid", { items: [{ userId: U, start: "2026-01-05" }], paid: true })).status === 200 && (await call("GET", "/api/time/week?start=2026-01-05", undefined, uc)).body.status === "paid");
const rep = (await call("GET", "/api/time/report?from=2026-01-05&to=2026-01-11", undefined, uc)).body;
ok("productivity = billable over work-day hours", rep.productivityPct === Math.round((120 / (450 + 300)) * 100), JSON.stringify(rep));
const acc = (await call("GET", `/api/time/week/accounting?userId=${U}&start=2026-01-05`)).body;
ok("accounting copy has the money", acc.wageCents === 3000 && acc.grossCents > 0 && Boolean(acc.balances));
ok("HR list hides wage and balances from non-managers", (await call("GET", "/api/hr/staff", undefined, uc)).body.every((x) => x.hourlyWage == null && x.bankCents === undefined));
ok("manual HR change needs the confirmation", (await post(`/api/hr/staff/${U}/adjust`, { account: "sick", hours: -3, reason: "x" })).status === 400);
const adj = await post(`/api/hr/staff/${U}/adjust`, { account: "sick", hours: -3, reason: "SMOKE opening", confirm: true });
ok("a hand change below zero is allowed and flagged", adj.status === 200 && adj.body.negative === true);

// ---- Expenses ----
const er = await post("/api/expenses/reports", { title: "SMOKE janvier", periodStart: "2026-01-01", periodEnd: "2026-01-31" }, uc);
ok("create expense report", er.status === 201);
const RID = er.body.id;
const ex = (data) => post(`/api/expenses/reports/${RID}/items`, data, uc);
ok("a trip needs from and to", (await ex({ spentOn: "2026-01-10", typeKey: "mileage", km: 10 })).body?.error === "mileage_places_required");
ok("a trip is saved", (await ex({ spentOn: "2026-01-10", typeKey: "mileage", km: 10, fromPlace: "Joliette", toPlace: "Montréal" })).status === 201);
ok("out-of-period expense refused", (await ex({ spentOn: "2026-02-10", typeKey: "meal", amount: 20 })).body?.error === "expense_out_of_period");
ok("billable expense needs a client", (await ex({ spentOn: "2026-01-11", typeKey: "parking", amount: 12.5, billable: true })).body?.error === "client_required");
ok("billable expense saved", (await ex({ spentOn: "2026-01-11", typeKey: "parking", amount: 12.5, billable: true, clientId: cid, description: "SMOKE stationnement" })).status === 201);
const rd = (await call("GET", `/api/expenses/reports/${RID}`, undefined, uc)).body;
const trip = rd.items.find((i) => i.unit === "km");
ok("the employee sees kilometres but never the money of a trip", trip.amountCents === null && rd.totalKm === 10 && rd.totalCents === 1250);
ok("the km rate is not exposed", !/rateCents|rate_cents/.test(JSON.stringify((await call("GET", "/api/expenses/types", undefined, uc)).body)));
ok("send the report", (await post(`/api/expenses/reports/${RID}/submit`, undefined, uc)).body?.submitted === 2);
ok("a sent report is locked", (await ex({ spentOn: "2026-01-12", typeKey: "meal", amount: 9 })).body?.error === "report_submitted");
const appr = (await call("GET", "/api/expenses/approvals")).body.find((x) => x.reportId === RID);
ok("approver sees the trip's money (70 c/km)", Boolean(appr) && appr.items.find((i) => i.unit === "km").amountCents === 700);
const ids = appr.items.map((i) => i.id);
ok("staff cannot decide on expenses", (await post("/api/expenses/approvals/decision", { ids, decision: "approve" }, uc)).status === 403);
ok("a refusal needs a reason", (await post("/api/expenses/approvals/decision", { ids: [trip.id], decision: "refuse" })).status === 400);
await post("/api/expenses/approvals/decision", { ids: [trip.id], decision: "refuse", reason: "SMOKE: precisez le trajet" });
ok("a refused item reopens the report", (await call("GET", `/api/expenses/reports/${RID}`, undefined, uc)).body.editable === true);
const park = appr.items.find((i) => i.unit !== "km");
await post("/api/expenses/approvals/decision", { ids: [park.id], decision: "approve" });
ok("approved billable expense is work to bill", (await call("GET", "/api/accounting/billing-items?status=pending")).body.some((x) => x.description === "SMOKE stationnement"));
ok("mark expense paid", (await post("/api/expenses/approvals/paid", { ids: [park.id], paid: true })).status === 200);
ok("favourite expense", (await post("/api/expenses/favorites", { label: "SMOKE Joliette-Montreal", typeKey: "mileage", km: 70, fromPlace: "Joliette", toPlace: "Montréal" }, uc)).status === 201 && (await call("GET", "/api/expenses/favorites", undefined, uc)).body.length === 1);

// ---- CRM: classes, billing contact, services, contracts, delete check ----
const mk = await post("/api/clients", { name: `SMOKE CRM ${Date.now()}` });
const ccid = mk.body.id;
ok("classification list is seeded", (await call("GET", "/api/clients/classes")).body.some((k) => k.key === "gold"));
ok("classify a client", (await call("PATCH", `/api/clients/${ccid}`, { classKey: "gold" })).status === 200 && (await call("GET", `/api/clients/${ccid}`)).body.classKey === "gold");
ok("unknown class refused", (await call("PATCH", `/api/clients/${ccid}`, { classKey: "nope" })).status === 400);
const noMail = await post(`/api/clients/${ccid}/contacts`, { name: "Sans courriel" });
ok("first contact is primary", noMail.status === 201);
ok("billing contact needs an email", (await call("PUT", `/api/clients/${ccid}/billing-contact`, { contactId: noMail.body.id })).body?.error === "contact_no_email");
const withMail = await post(`/api/clients/${ccid}/contacts`, { name: "Compta", email: "compta@smoke.example" });
ok("billing contact sets the billing email", (await call("PUT", `/api/clients/${ccid}/billing-contact`, { contactId: withMail.body.id })).status === 200 && (await call("GET", `/api/clients/${ccid}`)).body.billingEmail === "compta@smoke.example");
await call("PATCH", `/api/clients/contacts/${withMail.body.id}`, { email: "new@smoke.example" });
ok("billing email follows its contact", (await call("GET", `/api/clients/${ccid}`)).body.billingEmail === "new@smoke.example");
await call("PATCH", `/api/clients/${ccid}`, { billingEmail: "other@smoke.example" });
ok("typing another billing email frees the link", (await call("GET", `/api/clients/${ccid}`)).body.billingContactId === null);
ok("staff cannot change billing settings", (await call("PATCH", `/api/clients/${ccid}`, { termsDays: 15 }, uc)).status === 403);
ok("billing settings saved", (await call("PATCH", `/api/clients/${ccid}`, { termsDays: 15, poRequired: true, autoApproveKinds: ["contract"] })).status === 200 && (await call("GET", `/api/clients/${ccid}`)).body.termsDays === 15);
const pg = (await call("GET", "/api/clients?page=1&size=5&sort=contracts&dir=desc")).body;
ok("paged client list with a total", Array.isArray(pg.rows) && pg.total >= 1 && pg.size === 5);
ok("tab order is shared and complete", (await call("PUT", "/api/clients/tab-order", { order: ["contracts", "info"] })).status === 200 && (await call("GET", "/api/clients/tab-order")).body.order.join() === "contracts,info,contacts,tasks,invoices,billing");
await call("PUT", "/api/clients/tab-order", { order: null });
const svcName = `SMOKE Tenue de livres ${Date.now()}`;
const svc = await post("/api/services", { name: svcName, kind: "monthly", price: 100, cost: 40 });
ok("create a service", svc.status === 201);
ok("cost is hidden from non-managers", (await call("GET", "/api/services", undefined, uc)).body.every((s) => s.costCents === null));
ok("staff cannot manage services", (await post("/api/services", { name: "x" }, uc)).status === 403);
const rc = await post(`/api/clients/${ccid}/contracts`, { name: "SMOKE Forfait", kind: "recurring", billingPeriod: "monthly", startsOn: "2026-01-10", billedThrough: "2026-01-31" });
ok("create recurring contract", rc.status === 201);
ok("staff cannot set billing fields on a contract", (await call("PATCH", `/api/clients/contracts/${rc.body.id}`, { hourlyRate: 1 }, uc)).status === 403);
ok("service outside the term refused", (await post(`/api/clients/contracts/${rc.body.id}/services`, { serviceId: svc.body.id, addedOn: "2025-12-01" })).body?.error === "service_outside_term");
const ln = await post(`/api/clients/contracts/${rc.body.id}/services`, { serviceId: svc.body.id, quantity: 1, addedOn: "2026-01-10" });
ok("add a service from the catalogue", ln.status === 201);
const cd = (await call("GET", `/api/clients/contracts/${rc.body.id}`)).body;
ok("first month is prorated by days (22/31 of 100 $)", cd.charges[0].cents === 7097 && cd.charges[0].prorated === true && cd.charges[1].cents === 10000, JSON.stringify(cd.charges.slice(0, 2)));
ok("monthly figure", cd.monthlyCents === 10000);
await call("PATCH", `/api/services/${svc.body.id}`, { price: 250 });
ok("changing the catalogue price does not move the contract", (await call("GET", `/api/clients/contracts/${rc.body.id}`)).body.monthlyCents === 10000);
const rb = await post("/api/clients/contracts/refresh-billing", undefined);
ok("work to bill is made from due charges", rb.body.created >= 1, JSON.stringify(rb.body));
const lines = (await call("GET", "/api/accounting/billing-items?status=all")).body.filter((x) => String(x.description).startsWith("SMOKE Forfait"));
ok("charges already invoiced elsewhere are skipped", lines.length >= 1 && lines.every((x) => String(x.workDate ?? x.work_date).slice(0, 10) > "2026-01-31"), JSON.stringify(lines.slice(0, 2)));
ok("auto-approve kind applies to contract lines", lines.every((x) => x.status === "approved"));
ok("refreshing again makes nothing twice", (await post("/api/clients/contracts/refresh-billing", undefined)).body.created === 0);
ok("a contract that billed is stopped, never deleted", (await call("DELETE", `/api/clients/contracts/${rc.body.id}`)).body?.error === "contract_billed");
ok("contracts page lists it with the monthly figure", (await call("GET", "/api/clients/contracts/all?q=SMOKE%20Forfait")).body.some((k) => k.monthlyCents === 10000));
const dc = (await call("GET", `/api/clients/${ccid}/delete-check`)).body;
ok("delete check gives counts and blocks on history", dc.blocked === true && dc.counts.billing_items >= 1);
const del = await call("DELETE", `/api/clients/${ccid}`);
ok("a client with work to bill is not deleted", del.status === 409 && del.body.error === "client_has_history" && del.body.counts.billing_items >= 1);
const clean = await post("/api/clients", { name: `SMOKE empty ${Date.now()}` });
ok("an empty client can be deleted", (await call("DELETE", `/api/clients/${clean.body.id}`)).status === 200);

// ---- Approvals (work to bill) and invoicing ----
const ap = await post("/api/clients", { name: `SMOKE Billing ${Date.now()}` });
const bid = ap.body.id;
const today = new Date().toISOString().slice(0, 10);
const plus = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mkItem = async (desc, date, qty = 1, price = 100) => (await post("/api/accounting/billing-items", { clientId: bid, description: desc, quantity: qty, unitPrice: price, workDate: date })).body.id;
const feb = await mkItem("SMOKE feb", "2026-02-10"), mar = await mkItem("SMOKE mar", "2026-03-10"), nodate = await mkItem("SMOKE nodate", null);
const frame = (stmt, f, t) => call("GET", `/api/accounting/billing-items?status=${stmt}&client=${bid}${f ? `&from=${f}` : ""}${t ? `&to=${t}` : ""}`);
ok("time frame limits the list (dated lines inside it, undated lines always)", (await frame("pending", "2026-02-01", "2026-02-28")).body.map((x) => x.description).sort().join() === "SMOKE feb,SMOKE nodate");
ok("summary counts per status", (await call("GET", "/api/accounting/billing-items/summary?from=2026-02-01&to=2026-02-28")).body.pending.count >= 2);
await post("/api/accounting/billing-items/decision", { ids: [nodate], decision: "exclude", reason: "billed" });
const ex1 = (await frame("excluded")).body.find((x) => x.id === nodate);
ok("set aside as already invoiced, with its reason", ex1?.status === "excluded" && ex1.excludedReason === "billed");
await post("/api/accounting/billing-items/decision", { ids: [feb, mar], decision: "approve" });
ok("auto-approve rule approves what is already waiting", (await call("PATCH", `/api/clients/${bid}`, { autoApproveKinds: ["manual"] })).status === 200 && (await frame("pending")).body.length === 0);
const auto = await mkItem("SMOKE auto", "2026-02-12");
ok("a new line of an auto-approved kind arrives approved", (await frame("approved")).body.some((x) => x.id === auto));
await call("PATCH", `/api/clients/${bid}`, { autoApproveKinds: [], poRequired: true, termsDays: 15 });
const prevw = (await post("/api/accounting/invoices/from-items", { from: "2026-02-01", to: "2026-02-28", clientId: bid, preview: true })).body;
ok("a client that requires a PO number is skipped without one", prevw.skipped.length === 1 && prevw.skipped[0].reason === "po_required");
const madeInv = (await post("/api/accounting/invoices/from-items", { from: "2026-02-01", to: "2026-02-28", clientId: bid, clients: [{ clientId: bid, poNumber: "PO-77", notes: "SMOKE note" }] })).body;
ok("invoice of the time frame only", madeInv.created.length === 1 && (await frame("approved")).body.map((x) => x.description).join() === "SMOKE mar");
let bi = (await call("GET", `/api/accounting/invoices/${madeInv.created[0]}`)).body;
ok("PO number and notes carried to the invoice", bi.poNumber === "PO-77" && bi.notes === "SMOKE note" && bi.lines.length === 2);
ok("due day = day madeInv + terms + 1", String(bi.dueDate).slice(0, 10) === plus(16), `${bi.dueDate} vs ${plus(16)}`);
const sent = await post(`/api/accounting/invoices/${bi.id}/action`, { action: "send" });
bi = (await call("GET", `/api/accounting/invoices/${bi.id}`)).body;
ok("send finalizes and keeps the computed due day", sent.status === 200 && bi.status === "sent" && String(bi.dueDate).slice(0, 10) === plus(16));
const payA = await post(`/api/accounting/invoices/${bi.id}/payments`, { amount: 50, method: "cheque", reference: "123" });
bi = (await call("GET", `/api/accounting/invoices/${bi.id}`)).body;
ok("a partial payment leaves a balance and a partial view", payA.status === 201 && bi.view === "partial" && bi.paid === 50 && bi.balance === Math.round((Number(bi.total) - 50) * 100) / 100);
ok("payment above the balance refused", (await post(`/api/accounting/invoices/${bi.id}/payments`, { amount: Number(bi.total) })).body?.error === "payment_exceeds_balance");
ok("an invoice with payments cannot be voided", (await post(`/api/accounting/invoices/${bi.id}/action`, { action: "void" })).body?.error === "invoice_has_payments");
ok("filter: partial", (await call("GET", `/api/accounting/invoices?status=partial&client=${bid}`)).body.length === 1);
ok("filter: by PO number, paged with totals", (await call("GET", "/api/accounting/invoices?page=1&size=10&q=PO-77&status=open")).body.rows.some((x) => x.id === bi.id));
await post(`/api/accounting/invoices/${bi.id}/emailed`, { emailed: true });
ok("emailed mark and filter", (await call("GET", `/api/accounting/invoices?emailed=yes&client=${bid}`)).body.length === 1 && (await call("GET", `/api/accounting/invoices?emailed=no&client=${bid}`)).body.length === 0);
const stmt = (await call("GET", `/api/accounting/clients/${bid}/statement`)).body;
ok("statement: what is owed, by bucket", stmt.rows.length === 1 && stmt.total === bi.balance && stmt.buckets.notDue === bi.balance && stmt.pastDue === 0);
const payB = await post(`/api/accounting/invoices/${bi.id}/payments`, { amount: bi.balance });
ok("paying the rest closes the invoice", payB.body.paidInFull === true && (await call("GET", `/api/accounting/invoices/${bi.id}`)).body.view === "paid");
const payId = (await call("GET", `/api/accounting/invoices/${bi.id}`)).body.payments[0].id;
await call("DELETE", `/api/accounting/invoices/${bi.id}/payments/${payId}`);
ok("removing a payment reopens it", (await call("GET", `/api/accounting/invoices/${bi.id}`)).body.view === "partial");
const manualDue = await post("/api/accounting/invoices", { clientId: ccid, lines: [{ description: "SMOKE manual", quantity: 1, unitPrice: 10 }], dueDate: "2030-01-01" });
await post(`/api/accounting/invoices/${manualDue.body.id}/action`, { action: "send" });
ok("a due date typed by hand is never recomputed", String((await call("GET", `/api/accounting/invoices/${manualDue.body.id}`)).body.dueDate).slice(0, 10) === "2030-01-01");
ok("staff cannot record payments", (await post(`/api/accounting/invoices/${bi.id}/payments`, { amount: 1 }, uc)).status === 403);

// ---- Dashboards ----
const dashList = (as) => call("GET", "/api/team/dashboards", undefined, as);
const dAdmin = (await dashList()).body;
const builtin = dAdmin.find((d) => d.builtin);
ok("a built-in team dashboard exists", Boolean(builtin) && builtin.visibility === "team");
ok("a built-in dashboard cannot be deleted", (await call("DELETE", `/api/team/dashboards/${builtin.id}`)).status === 409);
const dStaff = (await dashList(uc)).body.find((d) => d.builtin);
ok("staff see the built-in dashboard but cannot edit the shared one", Boolean(dStaff) && dStaff.canEdit === false && dStaff.canCustomize === true);
ok("staff cannot change the shared layout", (await call("PATCH", `/api/team/dashboards/${builtin.id}`, { layout: [{ id: "x", type: "clock", size: 1 }] }, uc)).status === 403);
await call("PUT", `/api/team/dashboards/${builtin.id}/my-layout`, { layout: [{ id: "m1", type: "clock", size: 3 }] }, uc);
const mine1 = (await dashList(uc)).body.find((d) => d.builtin);
ok("a personal layout replaces the view only for that person", mine1.hasPersonalLayout && mine1.layout.length === 1 && mine1.sharedLayout.length > 1 && (await dashList()).body.find((d) => d.builtin).layout.length === builtin.layout.length);
await call("DELETE", `/api/team/dashboards/${builtin.id}/my-layout`, undefined, uc);
ok("back to the default arrangement", (await dashList(uc)).body.find((d) => d.builtin).hasPersonalLayout === false);
await call("PUT", "/api/team/dashboards/default", { dashboardId: builtin.id }, uc);
ok("a default dashboard opens first", (await dashList(uc)).body[0].id === builtin.id && (await dashList(uc)).body[0].isDefault === true);
const own = (await dashList(uc)).body.find((d) => !d.builtin && d.isOwner);
ok("a person's own dashboard can be edited and deleted", own.canEdit === true && own.canDelete === true);

// ---- Weekly meeting ----
const mp = (b, as) => post("/api/team/meeting/points", b, as);
const p1 = (await mp({ title: "SMOKE point A" }, uc)).body.id;
const listPts = async (view = "open", q = "") => (await call("GET", `/api/team/meeting/points?view=${view}&q=${q}`)).body;
ok("a point is on the open list", (await listPts()).points.some((x) => x.id === p1));
await call("PATCH", `/api/team/meeting/points/${p1}`, { done: true }, uc);
ok("ticking a point sends it to the archive", !(await listPts()).points.some((x) => x.id === p1) && (await listPts("archive", "SMOKE point A")).points.some((x) => x.id === p1));
await call("PATCH", `/api/team/meeting/points/${p1}`, { archived: false }, uc);
ok("restoring puts it back on the list", (await listPts()).points.some((x) => x.id === p1));
ok("snoozing in the past is refused", (await call("PATCH", `/api/team/meeting/points/${p1}`, { snoozeUntil: "2020-01-01" })).status === 400);
await call("PATCH", `/api/team/meeting/points/${p1}`, { snoozeUntil: plus(3) });
const lat = await listPts("later");
ok("a snoozed point leaves the list and shows under put off", lat.points.some((x) => x.id === p1) && !(await listPts()).points.some((x) => x.id === p1) && lat.later >= 1);
await call("PATCH", `/api/team/meeting/points/${p1}`, { snoozeUntil: null });
await post(`/api/team/meeting/points/${p1}/notes`, { body: "SMOKE note" }, uc);
ok("notes on a point", (await call("GET", `/api/team/meeting/points/${p1}/notes`)).body.length === 1 && (await listPts()).points.find((x) => x.id === p1).noteCount === 1);
const pB = (await mp({ title: "SMOKE point B" })).body.id, pC = (await mp({ title: "SMOKE point C" })).body.id;
await call("PUT", "/api/team/meeting/points/order", { ids: [pC, pB, p1] });
ok("drag order is kept", (await listPts()).points.map((x) => x.id).filter((x) => [pB, pC, p1].includes(x)).join() === [pC, pB, p1].join());
ok("staff cannot reorder", (await call("PUT", "/api/team/meeting/points/order", { ids: [p1] }, uc)).status === 403);
const ev = await post("/api/team/meeting/events", { date: today, title: "SMOKE rencontre", start: "10:00", end: "11:00" });
const wkPlan = (await call("GET", `/api/team/meeting/week?from=${today}`)).body;
ok("an event shows on its day of the week planner", ev.status === 201 && wkPlan.days.some((d) => d.events.some((e) => e.title === "SMOKE rencontre")) && wkPlan.days.length === 7);
ok("an event cannot end before it starts", (await post("/api/team/meeting/events", { date: today, title: "x", start: "11:00", end: "10:00" })).status === 400);
ok("staff cannot add events", (await post("/api/team/meeting/events", { date: today, title: "x" }, uc)).status === 403);
ok("Quebec holidays show on the week (Christmas)", (await call("GET", "/api/team/meeting/week?from=2026-12-21")).body.days.some((d) => d.date === "2026-12-25" && d.holiday?.fr === "Noël"));
const ab = await post("/api/team/meeting/absences", { userId: U, kind: "vacation", startsOn: plus(1), endsOn: plus(2) });
ok("an absence added from the planner shows on its days", ab.status === 201 && (await call("GET", `/api/team/meeting/week?from=${plus(1)}`)).body.days.some((d) => d.absences.some((a) => a.id === ab.body.id)));
await call("DELETE", `/api/team/meeting/absences/${ab.body.id}`);
const pj = await post("/api/team/meeting/projects", { name: "SMOKE Dossier T2", dueDate: plus(-2), memberIds: [U] }, uc);
ok("an engagement with a team", pj.status === 201 && (await call("GET", "/api/team/meeting/projects")).body.some((x) => x.id === pj.body.id && x.members.length === 1));
await post(`/api/team/meeting/projects/${pj.body.id}/notes`, { body: "SMOKE note dossier" }, uc);
ok("engagement notes", (await call("GET", `/api/team/meeting/projects/${pj.body.id}/notes`)).body.length === 1);
await call("PATCH", `/api/team/meeting/projects/${pj.body.id}`, { status: "done" });
ok("a done engagement leaves the open list", !(await call("GET", "/api/team/meeting/projects")).body.some((x) => x.id === pj.body.id) && (await call("GET", "/api/team/meeting/projects?done=1")).body.some((x) => x.id === pj.body.id));
const lateTask = await post("/api/tasks", { title: "SMOKE en retard", dueDate: plus(-5) });
const gg = (await call("GET", "/api/team/meeting/gauges")).body;
ok("gauges count late tasks per person and carry thresholds", lateTask.status === 201 && gg.overdue.count >= 1 && gg.overdue.byAssignee.length >= 1 && gg.thresholds.overdue.critical > gg.thresholds.overdue.warn);
ok("deep link filters exist (due=friday, assignee=none)", (await call("GET", "/api/tasks?due=friday&status=open")).status === 200 && (await call("GET", "/api/tasks?assignee=none&status=open")).status === 200);
const br = (await call("GET", "/api/team/meeting/brief")).body;
ok("the week-ahead brief has bullets and suggestions", br.bullets.length >= 1 && br.suggestions.length >= 1 && br.bullets.some((b) => /retard|late/i.test(b.fr + b.en)));
const tr = (await call("GET", "/api/team/meeting/trends?weeks=8")).body;
ok("trends over the chosen number of weeks", tr.rows.length === 8 && tr.rows.every((r) => typeof r.openAtEnd === "number") && tr.rows.reduce((a, r) => a + r.created, 0) >= 1);

// ---- Pipeline: My dayOf ----
const plusFrom = (day0, n) => { const d0 = new Date(`${day0}T00:00:00Z`); d0.setUTCDate(d0.getUTCDate() + n); return d0.toISOString().slice(0, 10); };
const D = "2026-06-02"; // a Tuesday that is not a holiday
const mkTask = async (b, as) => (await post("/api/tasks", b, as)).body.id;
const tUrgent = await mkTask({ title: "SMOKE urgente", priority: "urgent", dueDate: D, estimateMinutes: 60 });
const tNormal = await mkTask({ title: "SMOKE normale", dueDate: D, estimateMinutes: 30 });
const tLater = await mkTask({ title: "SMOKE plus tard", dueDate: "2026-06-20", estimateMinutes: 30 });
const tTimed = await mkTask({ title: "SMOKE pas avant dix heures", dueDate: D, estimateMinutes: 30, startTime: "10:00" });
const tDaily = await mkTask({ title: "SMOKE quotidienne", kind: "daily", estimateMinutes: 15 });
const tCont = await mkTask({ title: "SMOKE continue", kind: "continuous", remindEveryDays: 7, estimateMinutes: 15 });
const dayOf = (date, extra = "", as) => call("GET", `/api/pipeline/day?date=${date}${extra}`, undefined, as);
const dayPlan = (await dayOf(D)).body;
const titles = dayPlan.items.map((i) => i.title);
ok("the plate holds what is due, daily and continuous tasks, not what is for later", titles.includes("SMOKE urgente") && titles.includes("SMOKE quotidienne") && titles.includes("SMOKE continue") && !titles.includes("SMOKE plus tard"));
ok("the urgent one comes first", dayPlan.items[0].title === "SMOKE urgente");
const taskBlocks = dayPlan.blocks.filter((b) => b.kind === "task");
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
ok("work is laid out from the start of the dayOf, never in lunch or on top of each other", taskBlocks[0].start === "08:30" && taskBlocks.every((b) => toMin(b.end) <= 720 || toMin(b.start) >= 780) && taskBlocks.every((b, i) => i === 0 || toMin(b.start) >= toMin(taskBlocks[i - 1].end)), JSON.stringify(taskBlocks));
ok("a task with a start time is not planned before it", toMin(taskBlocks.find((b) => b.title === "SMOKE pas avant dix heures").start) >= 600);
ok("capacity is the working day less lunch (7.5 h)", dayPlan.capacityMinutes === 450 && dayPlan.plannedMinutes === dayPlan.items.reduce((a, i) => a + i.minutes, 0));
ok("a weekend is a dayOf off with nothing planned", (await dayOf("2026-06-06")).body.dayOff === "weekend" && (await dayOf("2026-06-06")).body.capacityMinutes === 0);
ok("a holiday is a dayOf off", (await dayOf("2026-12-25")).body.dayOff === "holiday");
await post(`/api/pipeline/tasks/${tCont}/check`, { date: D });
ok("a continuous task checked today leaves the plate until its reminder", !(await dayOf(D)).body.items.some((i) => i.title === "SMOKE continue"));
await call("PATCH", `/api/tasks/${tDaily}`, { status: "done" });
ok("a daily task done today is not shown again today", !(await dayOf(D)).body.items.some((i) => i.title === "SMOKE quotidienne"));
ok("…and starts over on a later day", (await dayOf(plusFrom(D, 7))).body.items.some((i) => i.title === "SMOKE quotidienne"));
ok("…and the continuous task comes back after its reminder days", (await dayOf(plusFrom(D, 8))).body.items.some((i) => i.title === "SMOKE continue"));
const privTask = await mkTask({ title: "SMOKE secrete", visibility: "private", dueDate: D }, uc);
const asManager = (await dayOf(D, `&userId=${U}`)).body.items.find((i) => i.id === privTask);
ok("a manager sees a private task of someone else only as a private task", asManager?.private === true && asManager.title === null);
ok("staff cannot look at someone else's dayOf", (await dayOf(D, `&userId=${(await call("GET", "/api/hr/staff")).body.find((x) => x.email === email).id}`, uc)).status === 403);
const upFile = await post(`/api/pipeline/tasks/${tNormal}/files`, { name: "SMOKE.txt", data: Buffer.from("bonjour").toString("base64") });
const fl = (await call("GET", `/api/pipeline/tasks/${tNormal}/files`)).body;
const dlf = await fetch(BASE + `/api/pipeline/files/${fl[0]?.id}`, { headers: { cookie } });
ok("a upFile on a task: uploaded, listed, downloaded", upFile.status === 201 && fl.length === 1 && dlf.status === 200 && (await dlf.text()) === "bonjour" && /attachment/.test(dlf.headers.get("content-disposition") ?? ""));
await call("DELETE", `/api/pipeline/files/${fl[0].id}`);
ok("…and removed", (await call("GET", `/api/pipeline/tasks/${tNormal}/files`)).body.length === 0);
void tUrgent; void tTimed;

// ---- Vendor payments ----
const vpVendor = (await post("/api/accounting/vendors", { name: `SMOKE VP ${Date.now()}` })).body.id;
const mkBill = async (due, amount, extra = {}) => (await post("/api/accounting/bills", { vendorId: vpVendor, number: `VP-${Math.random().toString(36).slice(2, 7)}`, dueDate: due, amount, ...extra })).body.id;
const bToday = await mkBill(today, 100), bSoon = await mkBill(plus(3), 500), bLate = await mkBill(plus(-4), 250), bNone = await mkBill(null, 75);
const lst = async (qs = "") => (await call("GET", `/api/accounting/bills${qs}`)).body;
const first = await lst();
ok("a bill can have no due date", Boolean(bNone) && first.tiles.noDate.count >= 1 && first.bills.some((b) => b.id === bNone && b.dueDate === null));
ok("tiles: late, due today, next 7 days, next 30 days, open", first.tiles.late.count >= 1 && first.tiles.today.count >= 1 && first.tiles.next7.count >= 1 && first.tiles.open.count >= 4 && first.tiles.next30.amount >= first.tiles.next7.amount);
ok("filter overdue", (await lst("?status=overdue")).bills.some((b) => b.id === bLate) && !(await lst("?status=overdue")).bills.some((b) => b.id === bSoon));
ok("filter by vendor name and date range", (await lst(`?q=SMOKE%20VP&from=${plus(1)}&to=${plus(10)}`)).bills.map((b) => b.id).join() === bSoon);
await call("PATCH", `/api/accounting/bills/${bLate}`, { status: "paid" });
ok("a paid bill leaves the open list", !(await lst("?status=open")).bills.some((b) => b.id === bLate) && (await lst("?status=paid")).bills.some((b) => b.id === bLate));
const cal = (await call("GET", `/api/accounting/bills/calendar?month=${plus(3).slice(0, 7)}`)).body;
ok("the calendar lists the bills due each day", cal.days.some((d) => d.date === plus(3) && d.bills.some((b) => b.id === bSoon)));
const rec = await post("/api/accounting/recurring", { vendorId: vpVendor, label: "SMOKE Loyer", amount: 1500, frequency: "monthly", nextDate: plus(2) });
ok("a recurring payment shows its next date", rec.status === 201 && (await call("GET", "/api/accounting/recurring")).body.find((r) => r.id === rec.body.id)?.upcoming === plus(2));
const prev = (await post("/api/accounting/recurring/import", { text: "Fournisseur\tLibellé\tMontant\tFréquence\tDate\tQuickBooks\nSMOKE Nouveau Fournisseur\tAbonnement\t49,99 $\tmensuel\t2026-12-01\toui\nSMOKE Bad\tTruc\tabc\tmensuel\t2026-12-01\t\nSMOKE Bad2\tTruc\t10\tjamais\t2026-12-01\t" })).body;
ok("import preview: header skipped, errors named, new vendors listed", prev.rows.length === 3 && prev.ok === 1 && prev.errors === 2 && prev.rows[0].amount === 49.99 && prev.rows[0].inQuickbooks === true && prev.newVendors.includes("SMOKE Nouveau Fournisseur") && prev.rows[1].error === "amount" && prev.rows[2].error === "frequency");
ok("import refuses to commit with errors", (await post("/api/accounting/recurring/import", { text: "SMOKE Bad\tTruc\tabc\tmensuel\t2026-12-01", commit: true })).status === 409);
const good = (await post("/api/accounting/recurring/import", { text: "SMOKE Nouveau Fournisseur\tAbonnement SMOKE\t49.99\tmonthly\t2026-12-01\toui", commit: true })).body;
ok("import creates the vendor and the payment", good.created === 1 && good.newVendors === 1 && (await call("GET", "/api/accounting/recurring")).body.some((r) => r.label === "Abonnement SMOKE" && r.inQuickbooks === true));
ok("staff cannot see the payroll plan", (await call("GET", "/api/accounting/payroll", undefined, uc)).status === 403);
ok("payroll plan saved by HR", (await call("PUT", "/api/accounting/payroll", { weekday: 4, amounts: [{ userId: U, weekly: 1000 }] })).status === 200 && (await call("GET", "/api/accounting/payroll")).body.total === 1000);
const calP = (await call("GET", `/api/accounting/bills/calendar?month=${plus(3).slice(0, 7)}`)).body;
ok("paydays are on the calendar (Fridays)", calP.days.some((d) => d.payroll === 1000 && new Date(`${d.date}T12:00:00Z`).getUTCDay() === 5));
await call("PUT", "/api/accounting/forecast/settings", { balance: 1000, payDelayDays: 0, lateDelayDays: 10 });
const fc = (await call("GET", "/api/accounting/forecast?days=60")).body;
ok("the forecast covers the days asked, day by day", fc.rows.length === 60 && fc.rows[0].date === today && fc.rows.every((r, i) => i === 0 || r.date > fc.rows[i - 1].date));
ok("payroll is in the forecast for HR and hidden for staff", fc.payrollIncluded === true && (await call("GET", "/api/accounting/forecast", undefined, uc)).body.payrollHidden === true);
await mkBill(plus(5), 900000);
const fc2 = (await call("GET", "/api/accounting/forecast?days=60")).body;
ok("a big bill shows the first shortfall day", fc2.firstShortfall !== null && fc2.firstShortfall.date <= plus(5) && fc2.lowest.balanceCents < 0);
await call("PUT", "/api/accounting/forecast/settings", { balance: 5_000_000, payDelayDays: 0, lateDelayDays: 10 });
ok("with enough cash there is no shortfall", (await call("GET", "/api/accounting/forecast?days=60")).body.firstShortfall === null);
await call("PUT", "/api/accounting/forecast/settings", { balance: 1000, payDelayDays: 10, lateDelayDays: 10 });
ok("a pay delay pushes the payment of a bill later", (await call("GET", "/api/accounting/forecast?days=60")).body.rows.find((r) => r.date === plus(15))?.items.some((i) => i.kind === "bill" && i.cents === -90000000));
ok("staff cannot record a recurring payment", (await post("/api/accounting/recurring", { label: "x", amount: 1, frequency: "weekly", nextDate: today }, uc)).status === 403);
void bToday;

// ---- Real integrations, against the local mock (scripts/mock-services.mjs) ----
const MOCK = "http://127.0.0.1:9099";
const mockPost = (p, b) => fetch(MOCK + p, { method: "POST", body: b ? JSON.stringify(b) : undefined });
const mockMails = async () => (await fetch(MOCK + "/_mock/mail")).json();
const mockQb = async () => (await fetch(MOCK + "/_mock/qbo/state")).json();
const dance = async (connectPath, as) => {
  const { url } = (await call("GET", connectPath, undefined, as)).body;
  const hop = await fetch(url, { redirect: "manual" });
  const loc = new URL(hop.headers.get("location"));
  const back = await fetch(BASE + loc.pathname + loc.search, { headers: { cookie: as ?? cookie }, redirect: "manual" });
  return { url, redirect: back.headers.get("location") ?? "" };
};
await mockPost("/_mock/reset");
const igPut = (provider, values, enabled = true) => call("PUT", `/api/admin/integrations/${provider}`, { values, enabled });

// Mailjet
ok("a test email is refused until Mailjet is set up", (await post("/api/admin/integrations/mailjet/test", {})).body?.error === "mailjet_not_configured");
await igPut("mailjet", { apiKey: "mock-key", secretKey: "wrong", senderEmail: "firme@acme.test", senderName: "Acme" });
ok("wrong Mailjet keys are reported, not hidden", (await post("/api/admin/integrations/mailjet/test", {})).body?.error === "mailjet_refused");
await igPut("mailjet", { apiKey: "mock-key", secretKey: "mock-secret", senderEmail: "firme@acme.test", senderName: "Acme" });
const tm = await post("/api/admin/integrations/mailjet/test", { to: "dest@example.com" });
ok("the test email goes out with the right credentials", tm.status === 200 && (await mockMails()).some((m) => m.subject.startsWith("Test Hexa") && m.to[0].Email === "dest@example.com" && m.from.Email === "firme@acme.test"));
const bm = await post("/api/command/board", { title: "SMOKE avis aux clients", body: "Bonjour a tous", audience: "selected", clientIds: [cid], emailCopy: true });
ok("a board message is emailed to the clients it targets", bm.body.email.status === "sent" && bm.body.email.sent === 1 && (await mockMails()).some((m) => m.subject === "SMOKE avis aux clients" && m.to[0].Email === "jane@example.com"));
ok("…and its status shows as sent", (await call("GET", "/api/command/board")).body.find((m) => m.id === bm.body.id)?.emailStatus === "sent");
const draftInv = (await post("/api/accounting/invoices", { clientId: bid, lines: [{ description: "SMOKE draft", quantity: 1, unitPrice: 10 }] })).body.id;
ok("a draft invoice cannot be emailed", (await post(`/api/accounting/invoices/${draftInv}/email`, { to: "x@example.com" })).body?.error === "invoice_not_sent");
ok("an invoice with no billing address asks for one", (await post(`/api/accounting/invoices/${madeInv.created[0]}/email`, {})).body?.error === "no_billing_email");
const ie = await post(`/api/accounting/invoices/${madeInv.created[0]}/email`, { to: "compta@client.example", lang: "en", note: "SMOKE merci" });
const ieMail = (await mockMails()).find((m) => m.to[0].Email === "compta@client.example");
ok("the invoice email carries its figures and marks the invoice as emailed", ie.status === 200 && ieMail.subject.startsWith("Invoice F-") && ieMail.html.includes("SMOKE merci") && ieMail.text.includes("Balance due") && (await call("GET", `/api/accounting/invoices/${madeInv.created[0]}`)).body.emailedAt !== null);
ok("staff cannot email invoices", (await post(`/api/accounting/invoices/${madeInv.created[0]}/email`, { to: "x@example.com" }, uc)).status === 403);
const lateInv = (await post("/api/accounting/invoices", { clientId: ccid, lines: [{ description: "SMOKE en retard", quantity: 1, unitPrice: 200 }], dueDate: plus(-20) })).body.id;
await post(`/api/accounting/invoices/${lateInv}/action`, { action: "send" });
ok("a reminder only for an invoice that is late", (await post(`/api/accounting/invoices/${bi.id}/reminder`, { to: "x@example.com" })).body?.error === "nothing_due");
ok("the reminder says how late it is", (await post(`/api/accounting/invoices/${lateInv}/reminder`, { to: "rappel@client.example" })).status === 200 && (await mockMails()).some((m) => m.to[0].Email === "rappel@client.example" && /Rappel/.test(m.subject) && /20/.test(m.subject)));
ok("account statement by email", (await post(`/api/accounting/clients/${ccid}/statement/email`, {})).status === 200 && (await mockMails()).some((m) => m.to[0].Email === "other@smoke.example" && m.subject.startsWith("Relevé")));
await call("PUT", "/api/accounting/reminders/settings", { enabled: true, from: null, levels: [5, 15], lang: "fr" });
const run1 = (await post("/api/accounting/reminders/run", {})).body, run2 = (await post("/api/accounting/reminders/run", {})).body;
ok("automatic reminders: the first run sends, a second run sends nothing more (once per level)", run1.sent >= 1 && run2.sent === 0, JSON.stringify([run1, run2]));
ok("…to the client's billing address", (await mockMails()).filter((m) => m.to[0].Email === "other@smoke.example" && /^Rappel/.test(m.subject)).length === 1);

// Microsoft 365
await igPut("o365", { tenantId: "tenant-1", clientId: "ms-client-id", clientSecret: "ms-secret" });
ok("Microsoft: configured but not yet connected", (await call("GET", "/api/microsoft/status")).body.configured === true && (await call("GET", "/api/microsoft/status")).body.connected === false);
ok("calendar needs a connection", (await call("GET", "/api/microsoft/calendar")).body?.error === "ms_not_connected");
const msd = await dance("/api/microsoft/connect");
ok("the sign-in goes to Microsoft with our client, redirect address and a signed state", msd.url.includes("/oauth2/v2.0/authorize") && msd.url.includes("client_id=ms-client-id") && msd.url.includes("state=") && msd.url.includes(encodeURIComponent("/api/microsoft/callback")));
ok("coming back connects the account", msd.redirect.includes("connected=1") && (await call("GET", "/api/microsoft/status")).body.email === "marie@acme.test");
const other = await dance("/api/microsoft/connect", uc);
const stolen = new URL(other.url).searchParams.get("state");
const bad = await fetch(BASE + `/api/microsoft/callback?code=MSCODE&state=${encodeURIComponent(stolen)}`, { headers: { cookie }, redirect: "manual" });
ok("a state from another person is refused", (bad.headers.get("location") ?? "").includes("error=state"));
const evs = (await call("GET", `/api/microsoft/calendar?from=${D}&to=${D}`)).body.events;
ok("the calendar shows events, hides what is private, and knows all-day ones", evs.length === 3 && evs.find((e) => e.id === "ev2").subject === "" && evs.find((e) => e.id === "ev2").isPrivate === true && evs.find((e) => e.id === "ev3").allDay === true && evs[0].start === `${D}T09:00:00`);
const inbox = (await call("GET", "/api/microsoft/mail")).body.messages;
ok("the inbox lists messages", inbox.length === 2 && inbox[0].isRead === false && inbox[0].from === "Luc Lavoie");
const oneMail = (await call("GET", `/api/microsoft/mail/${inbox[0].id}`)).body;
ok("one message comes as plain text", oneMail.body.includes("Voici les pièces") && oneMail.to[0] === "marie@acme.test");
ok("a strange message id is refused", (await call("GET", "/api/microsoft/mail/..%2F..%2Fme")).status === 404);
await mockPost("/_mock/expire");
ok("an expired access token is refreshed by itself", (await call("GET", `/api/microsoft/calendar?from=${D}&to=${D}`)).body.events.length === 3);
const dayOut = (await dayOf(D)).body;
ok("Outlook events take their hours off the day plan", dayOut.blocks.some((b) => b.kind === "event" && b.title === "Réunion client" && b.start === "09:00") && dayOut.blocks.some((b) => b.kind === "event" && b.title === "Occupé" && b.start === "14:00") && dayOut.capacityMinutes === 450 - 120, JSON.stringify(dayOut.blocks.filter((b) => b.kind === "event")));
ok("no task is planned over an Outlook event", dayOut.blocks.filter((b) => b.kind === "task").every((b) => toMin(b.end) <= 540 || toMin(b.start) >= 600) );
await mockPost("/_mock/revoke");
ok("a refused refresh token asks the person to sign in again", (await call("GET", `/api/microsoft/calendar?from=${plus(1)}&to=${plus(1)}`)).body?.error === "ms_reauth" && (await call("GET", "/api/microsoft/status")).body.needsReauth === true);
const msd2 = await dance("/api/microsoft/connect");
ok("signing in again fixes it", msd2.redirect.includes("connected=1") && (await call("GET", "/api/microsoft/status")).body.needsReauth === false);
await call("DELETE", "/api/microsoft/disconnect");
ok("disconnecting forgets the account", (await call("GET", "/api/microsoft/status")).body.connected === false && (await call("GET", "/api/microsoft/calendar")).body?.error === "ms_not_connected");

// QuickBooks
await igPut("quickbooks", { environment: "sandbox", clientId: "qb-client-id", clientSecret: "qb-secret" });
ok("QuickBooks: configured but not connected", (await call("GET", "/api/accounting/quickbooks/status")).body.configured === true && (await call("GET", "/api/accounting/quickbooks/status")).body.connected === false);
ok("nothing is sent before it is connected", (await post(`/api/accounting/quickbooks/invoices/${madeInv.created[0]}`, {})).body?.error === "quickbooks_not_connected");
ok("staff cannot connect QuickBooks", (await call("GET", "/api/accounting/quickbooks/connect", undefined, uc)).status === 403);
const qbd = await dance("/api/accounting/quickbooks/connect");
const qbs = (await call("GET", "/api/accounting/quickbooks/status")).body;
ok("QuickBooks sign-in connects the company", qbd.url.includes("client_id=qb-client-id") && qbd.redirect.includes("connected=1") && qbs.connected === true && qbs.realmId === "9130000000000001");
const plan = (await call("GET", "/api/accounting/quickbooks/customers/plan")).body.rows;
const dupont = plan.find((r) => r.name.startsWith("Boulangerie Dupont"));
ok("clients are matched to customers by name (ignoring inc/accents) and the rest would be created", dupont?.action === "link" && dupont.customer.DisplayName === "Boulangerie Dupont" && plan.find((r) => r.clientId === bid)?.action === "create");
const sy = (await post("/api/accounting/quickbooks/customers/sync", { clientIds: [dupont.clientId, bid] })).body;
ok("applying the review links one and creates one", sy.linked === 1 && sy.created === 1 && sy.errors.length === 0 && (await mockQb()).customers.some((c) => c.DisplayName.startsWith("SMOKE Billing")));
const qbInv = (await post("/api/accounting/invoices", { clientId: bid, lines: [{ description: "SMOKE QB service", quantity: 2, unitPrice: 100 }], poNumber: "PO-QB" })).body.id;
ok("a draft invoice is not sent to QuickBooks", (await post(`/api/accounting/quickbooks/invoices/${qbInv}`, {})).body?.error === "invoice_not_sent");
await post(`/api/accounting/invoices/${qbInv}/action`, { action: "send" });
const qbPush = (await post(`/api/accounting/quickbooks/invoices/${qbInv}`, {})).body;
const qbDetail = (await call("GET", `/api/accounting/invoices/${qbInv}`)).body;
const qbRemote = (await mockQb()).invoices.find((i) => i.Id === qbPush.quickbooksId);
ok("the invoice reaches QuickBooks with the same total (taxes as their own lines)", qbPush.ok === true && qbPush.warning === null && qbRemote.TotalAmt === Number(qbDetail.total) && qbRemote.DocNumber === qbDetail.number && qbRemote.Line.length === 3 && qbRemote.Line.some((l) => /TPS/.test(l.Description)) && qbRemote.PrivateNote.includes("PO-QB"));
const qbAgain = (await post(`/api/accounting/quickbooks/invoices/${qbInv}`, {})).body;
ok("sending it again updates it and never doubles it", qbAgain.updated === true && qbAgain.quickbooksId === qbPush.quickbooksId && (await mockQb()).invoices.filter((i) => i.DocNumber === qbDetail.number).length === 1);
await mockPost("/_mock/expire");
ok("an expired QuickBooks token is refreshed by itself", (await post(`/api/accounting/quickbooks/invoices/${qbInv}`, {})).status === 200);
await mockPost("/_mock/qbo/pay", { invoiceId: qbPush.quickbooksId, amount: 40 });
const pull1 = (await post("/api/accounting/quickbooks/payments/pull", {})).body;
const afterPull = (await call("GET", `/api/accounting/invoices/${qbInv}`)).body;
ok("a payment made in QuickBooks becomes a payment here", pull1.recorded >= 1 && afterPull.paid === 40 && afterPull.view === "partial" && afterPull.payments[0].method === "quickbooks");
ok("pulling again records nothing twice", (await post("/api/accounting/quickbooks/payments/pull", {})).body.recorded === 0);
await mockPost("/_mock/qbo/pay", { invoiceId: qbPush.quickbooksId, amount: Number(qbDetail.total) - 40 });
await post("/api/accounting/quickbooks/payments/pull", {});
ok("the rest paid in QuickBooks closes the invoice here", (await call("GET", `/api/accounting/invoices/${qbInv}`)).body.view === "paid");
await mockPost("/_mock/revoke");
ok("a refused QuickBooks token asks to connect again", (await post(`/api/accounting/quickbooks/invoices/${qbInv}`, {})).body?.error === "qb_reauth" && (await call("GET", "/api/accounting/quickbooks/status")).body.needsReauth === true);
await dance("/api/accounting/quickbooks/connect");
ok("connecting again fixes it", (await call("GET", "/api/accounting/quickbooks/status")).body.needsReauth === false);
await post("/api/accounting/quickbooks/disconnect", {});
ok("disconnecting forgets the company", (await call("GET", "/api/accounting/quickbooks/status")).body.connected === false);
ok("tokens never come back from the integrations list", !/qb-access|qb-refresh|ms-access|ms-refresh/.test(JSON.stringify((await call("GET", "/api/admin/integrations")).body)));

// ---- Client portal ----
async function clientLogin(em, pw) {
  const res = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: em, password: pw }) });
  const set = res.headers.get("set-cookie");
  return { status: res.status, cookie: set ? set.split(";")[0] : "" };
}
const PO_PW = "Portal-pass-2026-xyz";
const poA = (await post("/api/clients", { name: "SMOKE Portal A" })).body.id;
const poB = (await post("/api/clients", { name: "SMOKE Portal B" })).body.id;
const poKA = (await post(`/api/clients/${poA}/contacts`, { name: "Ann Portal", email: "ann.portal@a.test" })).body.id;
const poKB = (await post(`/api/clients/${poB}/contacts`, { name: "Bob Portal", email: "bob.portal@b.test" })).body.id;
const poKN = (await post(`/api/clients/${poA}/contacts`, { name: "No Mail" })).body.id;
const poInvA = (await post("/api/accounting/invoices", { clientId: poA, lines: [{ description: "SMOKE A service", quantity: 2, unitPrice: 100 }] })).body.id;
const poInvA2 = (await post("/api/accounting/invoices", { clientId: poA, lines: [{ description: "SMOKE A draft only", quantity: 1, unitPrice: 50 }] })).body.id;
const poInvB = (await post("/api/accounting/invoices", { clientId: poB, lines: [{ description: "SMOKE B service", quantity: 1, unitPrice: 999 }] })).body.id;
await post(`/api/accounting/invoices/${poInvA}/action`, { action: "send" });
await post(`/api/accounting/invoices/${poInvB}/action`, { action: "send" });
await post("/api/command/board", { title: "SMOKE for everyone", body: "hello all", audience: "all" });
await post("/api/command/board", { title: "SMOKE only B", body: "secret for B", audience: "selected", clientIds: [poB] });
await post(`/api/clients/${poA}/contracts`, { name: "SMOKE A contract", kind: "recurring", amount: 500 });
await post(`/api/clients/${poB}/contracts`, { name: "SMOKE B contract", kind: "recurring", amount: 700 });

ok("a contact without an email cannot be given access", (await post(`/api/clients/${poA}/portal/${poKN}`, {})).body?.error === "contact_email_missing");
ok("a staff email cannot be reused for a client user", await (async () => { const k = (await post(`/api/clients/${poA}/contacts`, { name: "Dup", email: email })).body.id; return (await post(`/api/clients/${poA}/portal/${k}`, {})).body?.error === "email_used"; })());
const poGrant = await post(`/api/clients/${poA}/portal/${poKA}`, {});
ok("giving access creates the user and sends the poWelcome email", poGrant.status === 201 && poGrant.body.emailed === true && poGrant.body.link === undefined, JSON.stringify(poGrant.body));
const poWelcome = (await mockMails()).filter((m) => (m.to ?? []).some((t) => t.Email === "ann.portal@a.test")).pop();
const poTok = /set-password\?token=([0-9a-f]+)/.exec(poWelcome?.text ?? "")?.[1];
ok("the email holds a one-time link and never a password", Boolean(poTok) && !/password:/i.test(poWelcome.text));
ok("before choosing a password nobody can sign in", (await clientLogin("ann.portal@a.test", "anything-at-all-1")).status === 401);
ok("a short password is refused", (await call("POST", "/api/auth/set-password", { token: poTok, password: "short" }, "")).status === 400);
ok("a wrong link is refused", (await call("POST", "/api/auth/set-password", { token: "0".repeat(64), password: PO_PW }, "")).status === 410);
ok("the link sets the password", (await call("POST", "/api/auth/set-password", { token: poTok, password: PO_PW }, "")).status === 200);
ok("the link works only once", (await call("POST", "/api/auth/set-password", { token: poTok, password: PO_PW + "2" }, "")).status === 410);
const poCl = await clientLogin("ann.portal@a.test", PO_PW);
const poCc = poCl.cookie;
const poMeC = (await call("GET", "/api/auth/me", undefined, poCc)).body;
ok("the client signs in as a client of their own company", poCl.status === 200 && poMeC.stage === "ready" && poMeC.user.kind === "client" && poMeC.user.clientId === poA, JSON.stringify(poMeC));
ok("a client holds only client rights", poMeC.rights.includes("clientportal.invoices.view") && !poMeC.rights.some((r) => !r.startsWith("clientportal.")));

const poInv = (await call("GET", "/api/portal/invoices", undefined, poCc)).body;
ok("the client sees only their own sent invoices", poInv.length === 1 && poInv[0].id === poInvA && poInv[0].balance > 0, JSON.stringify(poInv));
ok("another client's invoice is not found", (await call("GET", `/api/portal/invoices/${poInvB}`, undefined, poCc)).status === 404);
ok("a draft invoice is not found", (await call("GET", `/api/portal/invoices/${poInvA2}`, undefined, poCc)).status === 404);
const poDet = (await call("GET", `/api/portal/invoices/${poInvA}`, undefined, poCc)).body;
ok("the invoice detail has lines and totals but no internals", poDet.lines.length === 1 && Number(poDet.total) > 200 && poDet.createdBy === undefined && poDet.quickbooksId === undefined && poDet.rates === undefined);
const poSt = (await call("GET", "/api/portal/statement", undefined, poCc)).body;
ok("the statement is the client's own", poSt.rows.length === 1 && poSt.rows[0].id === poInvA && poSt.total === poInv[0].balance);
const poCon = (await call("GET", "/api/portal/contracts", undefined, poCc)).body;
ok("contracts are the client's own", poCon.length === 1 && poCon[0].name === "SMOKE A contract");
const poBoard = (await call("GET", "/api/portal/board", undefined, poCc)).body.map((m) => m.title);
ok("the board shows messages for everyone and none meant for another client", poBoard.includes("SMOKE for everyone") && !poBoard.includes("SMOKE only B"));
const poMe = (await call("GET", "/api/portal/me", undefined, poCc)).body;
ok("the portal summary shows the balance", poMe.client.name === "SMOKE Portal A" && poMe.balance === poInv[0].balance);

for (const p of ["/api/clients", "/api/accounting/invoices", "/api/tasks", "/api/admin/users", "/api/directory/clients", "/api/directory/integrations", "/api/update/status", "/api/command/board", "/api/team/dashboards", "/api/docs/access"]) {
  const r = await call("GET", p, undefined, poCc);
  ok(`a client is refused on ${p}`, r.status === 403 || r.status === 401, String(r.status));
}
ok("staff do not use the client portal API", (await call("GET", "/api/portal/invoices")).status === 403);

// Client B sees none of A
await post(`/api/clients/${poB}/portal/${poKB}`, {});
const poTokB = /set-password\?token=([0-9a-f]+)/.exec((await mockMails()).filter((m) => (m.to ?? []).some((t) => t.Email === "bob.portal@b.test")).pop()?.text ?? "")?.[1];
await call("POST", "/api/auth/set-password", { token: poTokB, password: PO_PW }, "");
const poCb = (await clientLogin("bob.portal@b.test", PO_PW)).cookie;
const poBInv = (await call("GET", "/api/portal/invoices", undefined, poCb)).body;
ok("client B sees only B's invoice", poBInv.length === 1 && poBInv[0].id === poInvB && (await call("GET", `/api/portal/invoices/${poInvA}`, undefined, poCb)).status === 404);
ok("client B sees the message meant for B", (await call("GET", "/api/portal/board", undefined, poCb)).body.some((m) => m.title === "SMOKE only B"));

// Documents for a client
ok("no folder rule: a client sees no library", (await call("GET", "/api/docs/libraries", undefined, poCc)).body.length === 0);
ok("a client may not manage folder rules", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Acme Corp", principalType: "client", principalId: poA, level: "view" }, poCc)).status === 403);
ok("a client rule is view only", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Acme Corp", principalType: "client", principalId: poA, level: "edit" })).status === 400);
ok("staff share a folder with a client", (await call("POST", "/api/docs/access", { drive: clientsLib, path: "Acme Corp", principalType: "client", principalId: poA, level: "view" })).status === 200);
ok("the client now sees that library", (await call("GET", "/api/docs/libraries", undefined, poCc)).body.some((l) => l.id === clientsLib));
ok("the client browses the shared folder", (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Acme%20Corp%2F2025`, undefined, poCc)).status === 200);
ok("another folder is refused for the client", (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Boulangerie%20Dupont`, undefined, poCc)).status === 403);
ok("client B sees nothing of A's folder", (await call("GET", `/api/docs/browse?drive=${clientsLib}&path=Acme%20Corp`, undefined, poCb)).status === 403);
const poDl = await fetch(BASE + `/api/docs/file?drive=${clientsLib}&path=${encodeURIComponent("Acme Corp/2025/Bilan.txt")}`, { headers: { cookie: poCc } });
ok("the client downloads a shared file", poDl.status === 200);
ok("a client cannot upload", (await up(poCc, "Acme Corp/2025", "x.txt")).status === 403);
ok("a client cannot create or delete", (await call("POST", "/api/docs/folder", { drive: clientsLib, path: "Acme Corp", name: "hack" }, poCc)).status === 403 && (await call("DELETE", `/api/docs/item?drive=${clientsLib}&path=${encodeURIComponent("Acme Corp/2025/Bilan.txt")}`, undefined, poCc)).status === 403);

// Removing access
const poRm = await call("DELETE", `/api/clients/${poA}/portal/${poKA}`);
ok("removing access ends the session at once", poRm.status === 200 && (await call("GET", "/api/auth/me", undefined, poCc)).body.stage === "anonymous");
ok("a removed client cannot sign in", (await clientLogin("ann.portal@a.test", PO_PW)).status === 401);
const poBack = await post(`/api/clients/${poA}/portal/${poKA}`, {});
ok("access can be restored with a new link", poBack.status === 201 && poBack.body.userId === poGrant.body.userId);
ok("the old password still needs the new link flow only when reset", (await clientLogin("ann.portal@a.test", PO_PW)).status === 200);
ok("an ordinary staff user cannot manage portal access", await (async () => {
  const u = await post("/api/admin/users", { email: "smoke.portalstaff@x.test", name: "Portal Staff", groupIds: [] });
  const g = (await call("GET", "/api/admin/groups")).body.find((x) => x.slug === "staff");
  await call("PATCH", `/api/admin/users/${u.body.id}`, { groupIds: [g.id] });
  const l1 = await clientLogin("smoke.portalstaff@x.test", u.body.temporaryPassword);
  await call("POST", "/api/auth/password", { current: u.body.temporaryPassword, next: PO_PW }, l1.cookie);
  const l2 = await clientLogin("smoke.portalstaff@x.test", PO_PW);
  return (await call("POST", `/api/clients/${poB}/portal/${poKB}`, {}, l2.cookie)).status === 403;
})());

// ---- Task timer, statuses and priorities ----
const tmClient = (await post("/api/clients", { name: "SMOKE Timer Client" })).body.id;
const tmA = (await post("/api/tasks", { title: "SMOKE timer A", clientId: tmClient, priority: "high" })).body.id;
const tmB = (await post("/api/tasks", { title: "SMOKE timer B", clientId: tmClient })).body.id;
const tmNo = (await post("/api/tasks", { title: "SMOKE timer no client" })).body.id;
ok("the five statuses are accepted", await (async () => { for (const st of ["todo", "taken", "doing", "blocked", "done"]) { if ((await call("PATCH", `/api/tasks/${tmNo}`, { status: st })).status !== 200) return false; } return (await call("GET", `/api/tasks/${tmNo}`)).body.status === "done"; })());
ok("an unknown status is refused", (await call("PATCH", `/api/tasks/${tmNo}`, { status: "waiting" })).status === 400);
ok("priority is kept", (await call("GET", `/api/tasks/${tmA}`)).body.priority === "high");
ok("no timer to start with", (await call("GET", "/api/tasks/timer")).body.running === null);
const tmStart = await post("/api/tasks/timer/start", { taskId: tmA });
ok("starting the timer works and takes a new task over", tmStart.status === 201 && tmStart.body.running.taskId === tmA && (await call("GET", `/api/tasks/${tmA}`)).body.status === "doing");
ok("starting it again on the same task changes nothing", (await post("/api/tasks/timer/start", { taskId: tmA })).body.already === true);
ok("a second timer is refused while one runs", (await post("/api/tasks/timer/start", { taskId: tmB })).body?.error === "timer_running");
ok("the timer reports itself", (await call("GET", "/api/tasks/timer")).body.running.title === "SMOKE timer A");
await new Promise((r) => setTimeout(r, 1200));
const tmStop = (await post("/api/tasks/timer/stop", {})).body;
ok("stopping gives a pending stretch of at least a minute", tmStop.segmentId && tmStop.minutes >= 1 && tmStop.clientId === tmClient);
ok("the timer is gone and the stretch waits", (await call("GET", "/api/tasks/timer")).body.running === null && (await call("GET", `/api/tasks/${tmA}/segments`)).body.length === 1);
ok("logging needs a description", (await post(`/api/tasks/segments/${tmStop.segmentId}/log`, { description: "  " })).status === 400);
const tmLog = await post(`/api/tasks/segments/${tmStop.segmentId}/log`, { description: "Revue des relevés bancaires", minutes: 15 });
const tmWeek = (await call("GET", "/api/time/week")).body;
const tmEntry = tmWeek.entries.find((e) => e.id === tmLog.body.entryId);
ok("the stretch becomes a billable time entry on the task and client", tmLog.status === 201 && tmEntry && tmEntry.minutes === 15 && tmEntry.taskId === tmA && tmEntry.clientId === tmClient && tmEntry.billable === true && tmEntry.description === "Revue des relevés bancaires" && tmEntry.typeKey === "work", JSON.stringify(tmEntry));
ok("it cannot be logged twice", (await post(`/api/tasks/segments/${tmStop.segmentId}/log`, { description: "again" })).status === 404 && (await call("GET", `/api/tasks/${tmA}/segments`)).body.length === 0);

// Later, and dropped
await post("/api/tasks/timer/start", { taskId: tmB });
const tmStop2 = (await post("/api/tasks/timer/stop", {})).body;
ok("time can wait until later", (await call("GET", "/api/tasks/timer")).body.pendingCount >= 1 && (await call("GET", "/api/tasks/segments/pending")).body.some((p) => p.id === tmStop2.segmentId && p.title === "SMOKE timer B"));
ok("a stretch can be dropped", (await call("DELETE", `/api/tasks/segments/${tmStop2.segmentId}`)).status === 200 && (await call("GET", `/api/tasks/${tmB}/segments`)).body.length === 0);

// Closing a task
await post("/api/tasks/timer/start", { taskId: tmB });
ok("completing a task ends its running timer and keeps the time pending", (await call("PATCH", `/api/tasks/${tmB}`, { status: "done" })).status === 200 && (await call("GET", "/api/tasks/timer")).body.running === null && (await call("GET", `/api/tasks/${tmB}/segments`)).body.length === 1);
ok("closing without time drops what is pending", (await post(`/api/tasks/${tmB}/segments/discard`, {})).body.discarded === 1 && (await call("GET", `/api/tasks/${tmB}/segments`)).body.length === 0);
const tmC = (await post("/api/tasks", { title: "SMOKE timer no client C" })).body.id;
await post("/api/tasks/timer/start", { taskId: tmC });
const tmStopC = (await post("/api/tasks/timer/stop", {})).body;
const tmLogC = await post(`/api/tasks/segments/${tmStopC.segmentId}/log`, { description: "Interne", minutes: 5, billable: true });
const tmEntryC = (await call("GET", "/api/time/week")).body.entries.find((e) => e.id === tmLogC.body.entryId);
ok("time on a task with no client is never billable", tmLogC.status === 201 && tmEntryC.billable === false && tmEntryC.clientId === null);
await post("/api/tasks/timer/start", { taskId: tmC });
ok("a timer thrown away leaves nothing", (await post("/api/tasks/timer/cancel", {})).status === 200 && (await call("GET", "/api/tasks/timer")).body.running === null && (await call("GET", `/api/tasks/${tmC}/segments`)).body.length === 0);
ok("a client user has no timer", [401, 403].includes((await call("GET", "/api/tasks/timer", undefined, poCc)).status) && [401, 403].includes((await post("/api/tasks/timer/start", { taskId: tmA }, poCc)).status));

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
