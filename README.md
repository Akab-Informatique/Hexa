# Nexo

White-label app sold per client. **One install per client** (own server, own database), managed from **one admin console**.

```
apps/console    Your admin console: clients, branding, modules, pinned versions, releases, fleet view,
                install-bundle generator, license check endpoint.
apps/instance   The client app (same Docker image for everyone). Checks its license, loads only the
                modules enabled for that client, shows "Update available" and triggers the updater.
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
npm run dev:console    # needs Postgres + ADMIN_PASSWORD + CONSOLE_SECRET (32+ chars)
npm run dev:instance   # needs Postgres; runs unlicensed when CONSOLE_URL is unset
```

## Status / TODO
- Typecheck and unit tests pass. **Not yet run end-to-end with Docker** (not available on the build machine): test the bundle install, the update and the rollback on a real server before selling.
- The instance's update button is protected by a shared admin token until the real app has users/permissions.
- Max-user enforcement: `maxUsers` is delivered to the instance and `userCount` is reported back; enforcement belongs in the app's user-creation code.
- Real app and client modules come next.
