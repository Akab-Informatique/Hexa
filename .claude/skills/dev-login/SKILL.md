---
name: dev-login
description: Start the Hexa dev stack and sign in to the local portal as the demo admin. Use when asked to open, run, or log in to the portal.
---

# Dev login

1. `preview_start {name: "hexa-dev"}`. Read logs with `preview_logs` (tail). Wait for "[dev] ready".
2. Navigate the browser to `http://localhost:5173` (web app, NOT 8080 which is the admin console).
3. Sign in: `admin@abezeau.test` / `DevPortal-2026!`.
4. If "Courriel ou mot de passe invalide": DB in `.data/` is older than the logged password. Reset locally (ask user first):
   - Write a temp `scripts/_reset.mts` that imports `hashPassword` from `../apps/instance/src/auth/crypto.ts`, connects with `pg` to `postgres://postgres:postgres@127.0.0.1:5434/postgres`, and runs
     `update users set password_hash=$1, must_change_password=false, failed_logins=0, locked_until=null where lower(email)='admin@abezeau.test'`.
   - Run `node --import tsx scripts/_reset.mts`, then delete the file.
5. Ports may shift if taken: read the real ones from the dev log.

Local dev DB and test account only. Never do this on a real instance.
