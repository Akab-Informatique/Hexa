# Nexo

White-label app sold per client. **One install per client** (own server, own database), managed from **one admin console**.

```
apps/console    Your admin console: clients, branding, modules, pinned versions, releases, fleet view,
                install-bundle generator, license check endpoint.
apps/instance   The client API (same Docker image for everyone): login + 2FA, users, groups, permissions, admin API,
                license check, module loader, update trigger. Also serves the built web app.
apps/web        The staff app (React): branded glass UI, login, collapsible module sidebar, admin screens. FR/EN.
apps/site       One-page "coming soon" marketing site with "Find your firm" login and console login link.
apps/updater    Sidecar next to each instance: backup -> pull -> restart -> health check -> auto-rollback.
packages/shared Shared types, license/branding schemas, version helpers, SQL migration runner.
modules/        Client-specific code as plugins (never edit the core for one client).
deploy/         Client bundle templates (compose, .env, nginx, install.sh), Dockerfiles, console compose.
Planning/       Read-only reference material. Never modified.
```

## How it fits together

1. In the console you create a client (domain, branding, modules, max users, pinned version) and download its **bundle** (zip).
2. The client unzips it on their server and runs `sh install.sh`; their own Nginx proxies to `127.0.0.1:<port>`.
3. Every hour the instance calls `POST <console>/api/license/check` (license key + version + health). The console answers with validity, plan, `maxUsers`, enabled modules, flags, branding and the **pinned version**. The same call feeds the fleet view.
4. When you change a client's pinned version, their app shows **Update available**. The button calls the updater, which backs up Postgres, pulls `nexo-instance:<version>` from GHCR, restarts, health-checks, and rolls back (image + DB dump) if anything fails.
5. Clients that can't reach the console keep working for `LICENSE_GRACE_HOURS` (default 72); an explicit "suspended/expired" locks immediately.

## Client-specific changes
1. **Config / flags / branding** in the console (preferred).
2. **A module** in `modules/<name>/` (see `modules/example-hello`), enabled per client.
3. **Last resort:** a client image `FROM nexo-instance:<version>` + `COPY modules/<name>`. Never fork the core.

## Releasing
Push a tag `vX.Y.Z`. `.github/workflows/release.yml` builds and pushes the images to GHCR and registers the release in the console
(repo secrets: `CONSOLE_URL`, `RELEASE_TOKEN`). Migrations are ordered, idempotent SQL files, so clients can skip versions.

## Run the console
```bash
cp deploy/console/.env.example deploy/console/.env   # fill it in
docker compose -f deploy/console/docker-compose.yml --env-file deploy/console/.env up -d --build
```
Put your Nginx in front (proxy to `127.0.0.1:8080`, HTTPS) and set `PUBLIC_URL` accordingly.

## Develop
```bash
npm install
npm run typecheck && npm test
npm run dev            # whole stack, no Docker/Postgres (embedded PGlite); prints the demo sign-in
```
`npm run dev` serves the staff app on :5173, the marketing page on :8081, the console on :8080 (admin/admin) and the API on :3000.
Delete `.data/` to reset the demo.

## Modules (all working in the local dev stack)
Sidebar sections follow the reference portal. Every page and action is guarded by its own right.
- **Team:** customizable dashboards (several per person, shareable, lockable by an admin, "copy to mine"); weekly meeting (points, issues, hot tasks, absences, review of past weeks).
- **My tools:** timesheet (weekly grid, submit, approve; approved billable time feeds Work to bill), knowledge base, procedures (step-by-step, draft/published); calendar and inbox are connection pages that wait for the Microsoft 365 integration.
- **Command center:** message board (all or selected clients, optional email copy waiting for Mailjet); pipeline ("my day" + status board).
- **Management:** clients (profile, contacts, contracts, parent/child, history-safe delete), tasks (checklist, notes, sub-tasks, dependencies, recurrence, private/selected visibility), documentation (SharePoint browsed through the Graph API; per-folder access for users and groups is managed in the portal, inherited down the tree. Local dev uses a built-in stand-in, `SHAREPOINT_MOCK=1`).
- **Internal accounting:** invoices (line-by-line tax rounding, draft/sent/paid/void), work to bill (approve/edit/exclude), vendors and payments to make; HR (profiles, absences).
- **Administration:** users, groups and the rights matrix, integration credentials (sealed), branding and modules, activity log.

`node scripts/smoke.mjs <email> <password>` runs an end-to-end API check of the business rules against a running dev stack.

## Access control
Every right is a key in `packages/shared/src/permissions.ts` (`<module>.<page>.<action>`). Users get rights from groups plus
per-user allow/deny overrides (deny wins). Nobody can grant a right they do not hold. Staff and client users share one users table;
client users (portal) come later.

## Status / TODO
- Typecheck and unit tests pass. **Not yet run end-to-end with Docker** (not available on the build machine): test the bundle install, the update and the rollback on a real server before selling.
- Only the master administrator can install an update from the app.
- Max-user enforcement: `maxUsers` is delivered to the instance and `userCount` is reported back; enforcement belongs in the app's user-creation code.
- Not built yet: the Microsoft 365 calendar/inbox, QuickBooks and Mailjet sync (credentials are stored, nothing is called yet; SharePoint is wired but not yet tried against a real tenant, files over 4 MB are refused), invoice PDF + email, the client portal (client users), and client-specific modules.
