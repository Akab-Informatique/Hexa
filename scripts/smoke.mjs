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

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
