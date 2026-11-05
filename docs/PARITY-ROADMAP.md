# Parity roadmap: Nexo vs the reference portal

Result of a module-by-module review of `Planning/Client-Portal` (read-only reference) against what Nexo has today.
Nexo is an accounting-firm CRM: **tasks only (no tickets)**, so ticket-, RMM- and MSP-specific features are out of scope.
Goal: the same screens, rules and behaviour as the reference for everything that applies, with Nexo's own look and
multi-tenant differences (per-tenant branding, modules, flags, demo data).

Status key: **missing** = nothing today, **thin** = exists but far simpler than the reference.

## Done so far
- **Timesheets, Expenses, HR ledger** (commit 406c4fe): typed entries, work day and lunch rule, hours bank, weekly approval, expenses with mileage, HR ledger with confirmed adjustments.
- **CRM and contracts** (first pass): classification, billing contact and email, per-client invoicing settings, shared tab order, paged and sortable client list, delete check; service catalogue; contract window (services, charge schedule with prorata, billed-through, activity); Accounting › Contracts page; work to bill generated from contract charges. Still missing from the reference here: autopay, hours-bank balance logic, parent/child bank pooling, QuickBooks item/tax codes, client-portal access on contacts.
- **Approvals and Invoices** (first pass): time frame, client then contract grouping, auto-approve rules, set aside with a reason, draft-invoice step with PO and due rule; all-invoices list with filters, sorts, paging and URL state, partial payments, account statements with aging, printable invoice sheet. Still missing: server PDF and email with reminders (needs Mailjet), pay online, quick invoice, QuickBooks codes, payments page.

## Round 1: core staff modules (chosen first)

### Dashboard (thin)
- Per-user layout over a shared default ("just for me" vs "for everyone", back to default); built-in dashboards (slug, undeletable) and a personal default.
- Widget gallery with default sizes (sm/md/lg), drag-based editing, a proper dashboard picker (no `window.prompt`).
- Richer widgets for a firm: late follow-ups, tasks by person, upcoming deadlines, recent board messages, quick actions, clock.
- A `dashboard.manage` right; audit entries.

### Weekly meeting (thin)
- Points: notes per point, snooze ("Reportés"), archive with search, drag reorder; ticking a point archives it.
- "La semaine": Monday-Sunday planner with events, absences and holidays; absences CRUD with kinds.
- Projects in progress (here: engagements/files in progress), with members, due date, notes, "Terminés".
- Week-ahead brief (rules-based, AI optional); gauges (overdue, due by Friday, unassigned) that deep-link to filtered lists; trends with a weeks slider.
- Section order as in the reference: points + week, brief, gauges, projects, trends.

### Pipeline / My day / Tasks (thin; our Kanban board and client filter are kept)
- My day: capacity (work hours less lunch, absences, holidays), time blocks, timeline, optional AI plan, morning run with a notification.
- Task kinds `normal | continuous | daily` (checkpoint reminders, daily reset); checkpoint with date + time; start day hides a task until then.
- Checklist items with their own day/time/priority; manager view of another person's day; task files; notifications on assign/comment.
- Verify server-side rules `task_blocked`, `task_cycle`, `task_open_children`; add tests. Draggable split bar; edit priority/status in place.

### Timesheets (thin) and Expenses (missing)
- Admin-managed time types (workday, bank payout, training, meeting, travel, vacation, sick, holiday); work day with start/end/lunch and paid-hours computation.
- Hours bank; vacation/sick/holiday entries that move the HR ledger; 4 % vacation accrual per sent week.
- Manager enters/edits for others; reports per person and per client; week PDF (hours only) for the employee and a full one for accounting.
- Approvals with "mark paid", stored rejection reason and notification. Billable/non-billable split per client with a productivity %.
- Expenses module: reports and items, receipts, admin-managed expense types, mileage (km, from/to), favourites, approvals, client re-billing into work-to-bill.

### HR (thin)
- Ledger with three accounts (hours bank $, vacation bank $, sick days h), audited manual adjustments (with confirmation), negative balances allowed with a notification.
- Overtime threshold in the profile; HR file as a window and as a tab in the admin user sheet; no employee access to their own HR data (check `POST /absences`).
- Avoid double entry between absences and timesheet vacation rows.

### CRM / clients (thin)
- Billing contact and billing email (list column, red when missing); per-client invoice settings (terms, PO, auto-approve kinds, auto-send).
- Classification (admin-managed, coloured); list with Contracts column, sorting, pager; shared, admin-editable tab order.
- Contact window with portal access; delete check with counts and audit.

### Contracts (thin)
- Accounting › Contracts page (grouped by client, folded, filters, monthly total); billing modes and rates; services per contract; charge schedule with prorata and "billed through"; hours bank; contract window with tabs.

### Approvals / work to bill (thin)
- Time frame filter; grouping by client then contract (folded); auto-approve rules; "already invoiced" exclusion with a reason; recurring contract lines from services; draft invoice step (date, terms, PO, notes, only the time frame's items); un-post with payment check.

### Invoices (thin)
- "All invoices" with filters, pager, sorts, URL state; partial payments; email templates and reminders (needs Mailjet); server PDF with preview; account statements with aging; invoice sheet look; due date = sent day + terms + 1; quick invoice and payments page.

### Vendor payments (thin)
- Month calendar of due bills; summary tiles (late, today, 7/30 days, no date); filters; cash forecast; recurring payments; payroll plan; QuickBooks bill pull (later).

## Later rounds
- Sales (pipeline, dashboard, contracts tab), Quotes, Services/Inventory, Projects.
- Client portal (client users): board, invoices, contracts, documents, mirroring the reference's client side.
- Real integrations: Microsoft 365 calendar/inbox, QuickBooks sync, Mailjet sending, Stripe pay-online.

## Notes
- Rights: the reference splits billing rights (`crm.billing`) from general contract edits; Nexo should add the same split.
- Multi-tenant differences stay in config: branding, modules, flags, seed profile (`none | accounting | bookkeeping | tax`), per-tenant SharePoint access.
