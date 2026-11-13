# Hexa: deployment guide

Three things get deployed, in this order:

| # | What | Where | Runs as |
|---|------|-------|---------|
| 1 | **Console**: your admin tool that creates clients ("tenants"), hands out install bundles, tracks versions | **your** server | Docker (app + its own Postgres) |
| 2 | **Marketing page** ("coming soon" + login buttons) | **your** server | static files in Nginx |
| 3 | **A tenant** (one firm's Hexa): app + Postgres + updater | the firm's server, or a shared host | Docker, from a bundle the console generates |

You already run Nginx, so everything below sits behind it. Nothing here has been run end to end on real
servers yet: do step 1 to 3 on a test domain first and keep this file open for the checks.

> Replace the example names: `console.akab.ca` (console), `hexa.akab.ca` (marketing page), `acme.example.com` (a tenant).

---

## 0. Once, before anything: images and secrets

Hexa ships as Docker images built by GitHub Actions (`.github/workflows/release.yml`) and stored in GitHub Container Registry (GHCR).

1. **GitHub token for tenants to pull private images**: GitHub, Settings, Developer settings, Personal access tokens (classic),
   scope `read:packages` only. Keep it. It goes in the console `.env` as `GHCR_PULL_TOKEN` and is written into each bundle.
2. **GitHub repository secrets** (repo, Settings, Secrets and variables, Actions):
   - `CONSOLE_URL`: `https://console.akab.ca`
   - `RELEASE_TOKEN`: a long random string (also goes in the console `.env`). Lets CI register a release in the console.
3. Make sure the repo's Actions can write packages (Settings, Actions, General, Workflow permissions: Read and write).
4. **Cut the first release** (after the repo push works again):
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
   CI builds and pushes `hexa-instance`, `hexa-console`, `hexa-updater` at that version, then tries to register the release in the
   console. That last step fails until the console is up (step 1): that is fine, you can register the version by hand later (step 1.6).

---

## 1. Deploy the console

On your server (Docker + Docker Compose v2 installed):

1. **Get the code**
   ```bash
   git clone https://github.com/Akab-Informatique/Hexa.git /opt/hexa && cd /opt/hexa
   ```
2. **Configure**
   ```bash
   cp deploy/console/.env.example deploy/console/.env
   nano deploy/console/.env
   ```
   Fill in:
   - `POSTGRES_PASSWORD`: long random
   - `ADMIN_USER` / `ADMIN_PASSWORD`: your console login (basic auth: use a long password)
   - `CONSOLE_SECRET`: 32+ random characters (`openssl rand -hex 32`). **Back it up.** It encrypts every client's license key and derives their
     initial passwords and app secrets. Losing it means rotating every client's key.
   - `PUBLIC_URL`: `https://console.akab.ca` (written into every bundle)
   - `INSTANCE_IMAGE`, `UPDATER_IMAGE`: leave the defaults unless your GitHub org differs
   - `GHCR_PULL_USER` / `GHCR_PULL_TOKEN`: your GitHub user and the `read:packages` token from step 0.1
   - `RELEASE_TOKEN`: same value as the GitHub secret
3. **Start**
   ```bash
   docker compose -f deploy/console/docker-compose.yml --env-file deploy/console/.env up -d --build
   curl http://127.0.0.1:8080/api/ping        # {"ok":true}
   ```
   It listens on `127.0.0.1:8080` only.
4. **Nginx + HTTPS** (`/etc/nginx/conf.d/console.akab.ca.conf`):
   ```nginx
   server {
       listen 80;
       server_name console.akab.ca;
       client_max_body_size 5m;
       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
   ```bash
   nginx -t && nginx -s reload
   certbot --nginx -d console.akab.ca
   ```
   The console login is HTTP basic auth, so it **must** only be reached over HTTPS. Open `https://console.akab.ca`; the browser asks for `ADMIN_USER` / `ADMIN_PASSWORD`.
5. **Optional hardening**: restrict the console in Nginx to your office/VPN IPs (`allow x.x.x.x; deny all;`) except
   `/api/license/check`, `/api/tenants/lookup` and `/api/releases`, which tenants, the marketing page and CI must reach.
6. **Register the release** if CI could not (the console must know a version before a client can be pinned to it):
   ```bash
   curl -X POST https://console.akab.ca/api/releases -H "authorization: Bearer $RELEASE_TOKEN" \
        -H "content-type: application/json" -d '{"version":"0.1.0","channel":"stable"}'
   ```

Backups: dump the console database nightly (`docker compose exec db pg_dump -U hexa hexa_console > console.sql`) and keep `CONSOLE_SECRET` somewhere safe.

---

## 2. Deploy the marketing page

**Easiest: it already runs with the console.** `deploy/console/docker-compose.yml` has a `site` service (nginx) that serves `apps/site` on `127.0.0.1:8081` and writes its `config.js` from your `.env` (`PUBLIC_URL` = your console address, optional `SITE_CONTACT_EMAIL`). So `docker compose up -d --build` in step 1 already started it. In Nginx Proxy Manager add a Proxy Host for your public site name (for example `hexa.akab.ca`) forwarding to `127.0.0.1:8081`, with SSL. Skip the manual copy below.

Manual alternative: it is a folder of static files, `apps/site` (`index.html` + `config.js`). No build step.

1. **Copy it to the server**
   ```bash
   mkdir -p /var/www/hexa-site && cp -r /opt/hexa/apps/site/* /var/www/hexa-site/
   ```
2. **Point it at your console**: edit `/var/www/hexa-site/config.js`
   ```js
   window.HEXA = { consoleUrl: "https://console.akab.ca" };
   ```
   This file is read in the browser, so no rebuild is needed when it changes.
3. **Nginx + HTTPS**
   ```nginx
   server {
       listen 80;
       server_name hexa.akab.ca;
       root /var/www/hexa-site;
       index index.html;
       location / { try_files $uri /index.html; }
   }
   ```
   ```bash
   nginx -t && nginx -s reload && certbot --nginx -d hexa.akab.ca
   ```
4. **Check**: open `https://hexa.akab.ca`. "Connexion" opens the "Find your firm" box: typing a client id (e.g. `acme`) asks the console
   (`/api/tenants/lookup`, public, only returns the firm's name and address) and redirects to that firm's own address. The console link goes to your console.

To update the page later: edit the files in `apps/site`, copy them over again.

---

## 3. Create and deploy a new tenant (a firm)

### 3a. In the console

1. Open `https://console.akab.ca` and add a client:
   - **Id**: short lowercase slug (`acme`). It is the "firm id" the marketing page asks for. Cannot change later.
   - **Name**: shown as the app name until the firm sets its own
   - **Domain** (optional): leave empty to get the default `acme.<CLIENT_BASE_DOMAIN>`. Or type the firm's own address (for example `portail.acme.com`), which becomes its custom address. See "Domaine du client" below.
   - **First admin email**: who receives the first master account
   - **Plan, max users, modules**: what the firm bought. Max users is delivered but not yet enforced by the app. (Feature flags and an expiry date exist in the console API but not yet in this form.)
   - **Pinned version**: the release the firm should run (updates are pushed by changing this)
   - **Branding**: primary color and logo URL in the form (the name is the app name). The accent color is set through the API for now (`PATCH /api/clients/<id>` with `branding`). Hexa's own default is purple + blue on black; a firm that sets other colors gets its own lighting.
   - **App port**: a free port on the target host (default per client). Use a different one for each tenant if several share a server.
2. **Download the bundle** (zip). It contains the `.env` with the license key, a generated database password, the first admin password, the app secret,
   the compose file, `install.sh`, an Nginx site file and a README for the firm.

### 3b. On the tenant's server

1. Server needs Linux + Docker + Docker Compose v2 + Nginx. Unzip the bundle (e.g. `/opt/hexa/acme`). Keep `.env` private.
2. ```bash
   cd /opt/hexa/acme && sh install.sh
   ```
   It logs in to GHCR with the token from the bundle, pulls the images and starts three containers: app, Postgres, updater.
   Check: `curl http://127.0.0.1:<APP_PORT>/api/health`.
3. **DNS and HTTPS**: point the primary address (and the default address, if different) to that server. With Nginx Proxy Manager, add one Proxy Host
   with all names, forwarding to `127.0.0.1:<APP_PORT>`, SSL on. Without NPM (optional): copy `nginx/acme.example.com.conf` from the bundle to `/etc/nginx/conf.d/`.
   If your `nginx.conf` does not have it yet, add once inside `http {}`:
   ```nginx
   map $http_upgrade $connection_upgrade { default upgrade; '' close; }
   ```
   Then `nginx -t && nginx -s reload && certbot --nginx -d acme.example.com`.
5. **First sign-in**: open `https://acme.example.com`, sign in as the first admin email with `INITIAL_ADMIN_PASSWORD` from `.env`. The app forces a new
   password, then asks the admin to set up two-factor authentication (required in production).
6. **Inside the app** (Administration), the firm's admin: creates groups and users (rights are per module, page and function), then, under Integrations, enters
   the firm's own Microsoft 365 app (tenant id, client id, secret) and the SharePoint site address, and ticks Enabled. For SharePoint the Entra app needs the
   `Sites.ReadWrite.All` application permission (admin consent). Folder access for staff is then set in Documentation.
7. **Check from the console**: the fleet view shows the firm's version and last license check once the app has started.

### 3b-bis. Domaine du client (addresses)

Each client has a **default address** and may add a **custom address**. The **primary address** is the custom one when set, otherwise the default. The console shows both in the fleet table.

- **Default address**: `<id>.<CLIENT_BASE_DOMAIN>` (for example `acme.hexa.akab.ca`). Set `CLIENT_BASE_DOMAIN` in the console `.env` (empty = no default, each client needs an explicit domain). It needs a wildcard DNS record `*.hexa.akab.ca` pointing at the server, and either a wildcard certificate or one NPM proxy host per client.
- **Custom address** (for example `portail.acme.com`), set in the console with **Edit** on the client (empty clears it):
  1. The client creates a DNS record `CNAME portail.acme.com` pointing to `acme.hexa.akab.ca`.
  2. In Nginx Proxy Manager, add a Proxy Host with both names (`portail.acme.com` and `acme.hexa.akab.ca`), forwarding to `127.0.0.1:<APP_PORT>`, SSL on (Let's Encrypt).
  3. Make it the primary address: the bundle's `.env` gets `PUBLIC_URL=https://portail.acme.com`, so download a new bundle, deploy it, and update the redirect addresses in Entra ID and Intuit (section 3d) to the new address.
- **Clients do not need their own nginx.** The `nginx/*.conf` file in the bundle is optional, only for a server without Nginx Proxy Manager.
- Names are lowercase host names only (no `https://`, no path). A custom name cannot end with `.<CLIENT_BASE_DOMAIN>` and cannot be used by another client (409).
- When you first enable `CLIENT_BASE_DOMAIN` on a console that already has clients, their current address becomes the default one. To keep it, set it as the custom address with **Edit** first.

### 3c. Several tenants on one server

Fine, as long as each has its own folder (own `.env`, own `COMPOSE_PROJECT_NAME`, so separate volumes), its own **App port**, its own domain and Nginx file. Each is still a fully separate app and database.

### 3d. Connect the firm's own accounts (Administration › Integrations)

Each firm registers its **own** apps and enters their keys in the app; nothing is shared between firms. The tenant's `.env` already
carries `PUBLIC_URL=https://<its domain>`: the sign-ins below come back to that address, so it must be the address people really use
(HTTPS, through your Nginx). Each integration page shows the exact redirect address to copy.

| Service | What the firm does | What it gives |
|---|---|---|
| **Mailjet** | Create an account, validate the sender address, copy the API key and secret key. In the app: Integrations › Mailjet, save, tick *Enabled*, press *Send a test*. | Invoices, reminders and account statements by email; the board's email copy. |
| **Microsoft 365** | In Entra ID: *App registrations* › New. Add the redirect address `https://<domain>/api/microsoft/callback` (type Web). Create a client secret. API permissions, **delegated**: `User.Read`, `Calendars.Read`, `Mail.Read`, `offline_access`. For SharePoint also **application** `Sites.ReadWrite.All` with admin consent. In the app: tenant ID, client ID, secret, *Enabled*. | Each person connects their own calendar and inbox (read only) from My tools; their Outlook events take hours off their day in Pipeline. SharePoint browsing in Documentation. |
| **QuickBooks Online** | At developer.intuit.com create an app (scope *Accounting*). Add the redirect address `https://<domain>/api/accounting/quickbooks/callback`. Copy the client ID and secret (development keys for *sandbox*, production keys for *production*). In the app: environment, ID, secret, *Enabled*, then *Connect to QuickBooks*. | Clients matched to customers (reviewed first), invoices sent to QuickBooks (taxes as their own lines for now), payments brought back automatically. |

Notes: a person's Microsoft refresh token and QuickBooks' tokens are stored encrypted with `APP_SECRET` and are never shown again;
*Disconnect* removes them. Intuit rotates its refresh token on every refresh and it expires after 100 days without use: if QuickBooks
asks to *connect again*, press Reconnect. Automatic invoice reminders are **off** until someone switches them on in Invoices.

For development there is a local mock of all three (`scripts/mock-services.mjs`, started by `npm run dev`, never active in production).

---

## 4. Everyday operations

**Ship a new version to everyone**
1. Merge to `main`, then `git tag v0.2.0 && git push origin v0.2.0`. CI builds the images and registers the release.
2. In the console, change a client's **pinned version** to `0.2.0` (clients can be moved one by one: test on your own first).
3. In the firm's app, a master admin or any user holding the **Install updates** right (Admin > Groups or the user's own rights) sees **Update available** (banner + Admin > Updates) and presses Update. Updates are never installed automatically. The updater backs up the database, pulls, restarts, health-checks, and **rolls back
   automatically** if it fails. Backups: last 5, in the `backups` volume.

**Change a firm's branding, modules, flags, plan or user limit**: edit the client in the console. The app picks it up on its next license check (within minutes).
**Suspend a firm**: the Suspend button on its row. At the firm's next license check (within the hour) its portal shows a full-screen "Service suspended" notice and nobody can sign in; the data is kept. Resume brings it back at the next check. If the firm's server simply cannot reach your console, it keeps working for 72 h, then shows "Verification in progress".
**Rotate a firm's license key**: the Rotate key button, then download the new bundle and deploy it (the running install stops validating until it has the new key).
**Never** run `docker compose down -v` on a tenant (it deletes the database volume).
**Backups** to schedule yourself: each tenant's Postgres (`docker compose exec db pg_dump ...`) off-server, plus the console database and `CONSOLE_SECRET`.

## 5. If something fails

| Symptom | Likely cause |
|---|---|
| `install.sh`: `unauthorized` on pull | GHCR token missing/expired, or images not published for that version yet |
| App starts, console shows no check-in | Tenant cannot reach `PUBLIC_URL`; check DNS, firewall, `CONSOLE_URL` in `.env` |
| "Find your firm" says not found | Client id mismatch, or the client is inactive |
| Login works but pages say forbidden | The user has no group yet (Administration, Users) |
| Documentation says "SharePoint is not connected" | Microsoft 365 and SharePoint integrations not filled in or not enabled |
| Microsoft / QuickBooks sign-in ends on an error page | The redirect address in the provider's app differs from the one shown in the integration page, or `PUBLIC_URL` is wrong |
| "Public address not set" | `PUBLIC_URL` is missing from the tenant's `.env` (add it and `docker compose up -d`) |
| Test email says the keys were refused | Mailjet API key or secret key wrong, or the sender address is not validated in Mailjet |
| Update fails and rolls back | Read the updater log: `docker compose logs updater`; the previous version keeps running |
| CI cannot register the release | Console not reachable at `CONSOLE_URL`, or `RELEASE_TOKEN` differs; register it by hand (1.6) |
