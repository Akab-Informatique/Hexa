# Hexa (repo: Portail Nexo)

Use the `caveman` skill style by default: terse, answer first, no filler, minimal tool output.

## Dev
- `npm run dev` (or preview `hexa-dev`) starts everything. Web app `:5173`, API `:3000`, console `:8080` (admin/admin), site `:8081`.
- Dev DBs persist in `.data/`. Seed admin: `admin@abezeau.test`; password only valid on a fresh DB, else reset it in the DB on `:5434`.
- Checks: `npm run typecheck`, `npm test`.

## Layout
- `apps/web` UI, `apps/instance` API, `apps/console` admin, `modules/*`, `packages/*`.

## Token rules
- Read ranges, not whole files. Grep before Read.
- Pipe command output through `tail`/`grep`.
- Prefer text page reads over screenshots.
