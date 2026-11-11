import { addDays, mondayOf, parseISODate, toISODate, todayISO } from "@hexa/shared/billing";
import { pool } from "../db.ts";

/**
 * Tasks the tax follow-up creates by itself, once each (auto_task_log), assigned to the client's resource:
 *  - taxes:   on the 1st of a month, for the month before, due the last day of the month (quarterly clients: Oct/Jan/Apr/Jul only)
 *  - DAS:     on the 1st, for the month before, due the 15th (clients where we file; checklist Fed / QC / CCQ)
 *  - payroll: every Monday, due that Thursday (biweekly clients: every second Monday)
 *  - year-end: the 1st of the month after the fiscal year-end a verification task; the 1st of the month after that the
 *    year-end file, due six months after the year-end
 *  - T4 / RL-1: on January 1st, due the last day of February, with one bullet per slip the client has
 * A task is created on the day or later in the same month/week (so a server that was off on the 1st catches up), never for the past.
 */
export interface Planned {
  clientId: string; clientName: string; rule: string; period: string; title: string; description: string; due: string; start: string;
  assigneeId: string | null; bullets: string[];
}

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const ym = (y: number, m: number) => { const d = new Date(Date.UTC(y, m - 1, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
const iso = (y: number, m: number, d: number) => toISODate(new Date(Date.UTC(y, m - 1, d)));
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");
const label = (y: number, m: number) => `${MONTHS_FR[m - 1]} ${y}`;

export async function planAutoTasks(today = todayISO()): Promise<Planned[]> {
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  const prev = ym(ty, tm - 1);
  const prevKey = `${prev.y}-${pad(prev.m)}`;
  const clients = (await pool.query(
    `select c.id, c.name, c.tax_frequency, t.resource_id, t.fiscal_month, coalesce(t.das_filer,'') as das_filer, coalesce(t.payroll_period,'') as payroll_period,
            coalesce(t.t4_on,false) as t4_on, coalesce(t.rl1_on,false) as rl1_on, coalesce(t.t4a_on,false) as t4a_on
       from clients c left join client_tracking t on t.client_id = c.id where c.status = 'active' order by lower(c.name)`)).rows;
  const done = (await pool.query(
    "select client_id, kind, period, item, status from client_filings where kind in ('tax','das') and period = $1 and status in ('done','na')", [prevKey])).rows;
  const isDone = (id: string, kind: string, item = "") => done.some((f) => f.client_id === id && f.kind === kind && f.item === item);

  const out: Planned[] = [];
  const add = (c: any, rule: string, period: string, title: string, due: string, start: string, description = "", bullets: string[] = []) =>
    out.push({ clientId: c.id, clientName: c.name, rule, period, title: `${title} — ${c.name}`, description, due, start, assigneeId: c.resource_id ?? null, bullets });

  for (const c of clients) {
    // Taxes
    const due = (c.tax_frequency === "monthly") || (c.tax_frequency === "quarterly" && [1, 4, 7, 10].includes(prev.m));
    if (due && !isDone(c.id, "tax")) add(c, "tax", prevKey, `Taxes ${label(prev.y, prev.m)}`, iso(ty, tm, lastDay(ty, tm)), iso(ty, tm, 1), `Déclaration de taxes pour la période de ${label(prev.y, prev.m)}.`);

    // DAS: filer "them" -> nothing; "them_ccq_us" -> only the CCQ part is ours
    const filer: string = c.das_filer;
    if (filer && filer !== "them") {
      const items = filer === "them_ccq_us" ? [["ccq", "CCQ"]] : [["fed", "Fédéral"], ["prov", "Québec"], ["ccq", "CCQ"]];
      const todo = items.filter(([k]) => !isDone(c.id, "das", k!));
      if (todo.length) add(c, "das", prevKey, `DAS ${label(prev.y, prev.m)}`, iso(ty, tm, 15), iso(ty, tm, 1), `Remises (DAS) pour la période de ${label(prev.y, prev.m)}.`, todo.map(([, n]) => n!));
    }

    // Payroll: every Monday (biweekly: every second Monday, counted from 2026-01-05)
    if (c.payroll_period === "weekly" || c.payroll_period === "biweekly") {
      const mon = mondayOf(today);
      const weeks = Math.round((parseISODate(mon).getTime() - parseISODate("2026-01-05").getTime()) / (7 * 86400_000));
      if (c.payroll_period === "weekly" || weeks % 2 === 0) add(c, "payroll", mon, `Paie`, addDays(mon, 3), mon, `Paie de la semaine du ${mon}.`);
    }

    // Year-end (fiscal year ends the last day of fiscal_month)
    if (c.fiscal_month) {
      const M: number = c.fiscal_month;
      for (const fy of [ty - 1, ty]) {
        const v = ym(fy, M + 1), f = ym(fy, M + 2), d = ym(fy, M + 6);
        const fyeLabel = label(fy, M);
        const dueFile = iso(d.y, d.m, lastDay(d.y, d.m));
        if (v.y === ty && v.m === tm) add(c, "ye_verify", String(fy), `Vérification de fin d'année (${fyeLabel})`, iso(ty, tm, lastDay(ty, tm)), iso(ty, tm, 1), `Vérification avant de monter le dossier de fin d'année au ${lastDay(fy, M)} ${MONTHS_FR[M - 1]} ${fy}.`);
        if (f.y === ty && f.m === tm) add(c, "ye_file", String(fy), `Dossier de fin d'année (${fyeLabel})`, dueFile, iso(ty, tm, 1), `Dossier de fin d'année, à terminer six mois après la fin d'exercice (${fyeLabel}).`);
      }
    }

    // T4 / RL-1 / T4A: January, for last year
    if (tm === 1 && (c.t4_on || c.rl1_on || c.t4a_on)) {
      const bullets = [c.t4_on && "T4", c.rl1_on && "RL-1", c.t4a_on && "T4A"].filter(Boolean) as string[];
      add(c, "t4rl1", String(ty - 1), `T4 / RL-1 ${ty - 1}`, iso(ty, 2, lastDay(ty, 2)), iso(ty, 1, 1), `Feuillets de l'année d'imposition ${ty - 1}, à produire avant la fin de février.`, bullets);
    }
  }
  return out;
}

/** Creates what is planned and not yet created. Returns the new tasks (or, with dry, what would be created). */
export async function runAutoTasks(opts: { today?: string; dry?: boolean } = {}): Promise<Planned[]> {
  const planned = await planAutoTasks(opts.today);
  const logged = new Set((await pool.query("select client_id || '|' || rule || '|' || period as k from auto_task_log")).rows.map((r) => r.k as string));
  const fresh = planned.filter((p) => !logged.has(`${p.clientId}|${p.rule}|${p.period}`));
  if (opts.dry) return fresh;
  const created: Planned[] = [];
  for (const p of fresh) {
    // The log row is claimed first so two runs at once cannot both create the task.
    const claim = await pool.query("insert into auto_task_log (client_id, rule, period) values ($1,$2,$3) on conflict do nothing returning client_id", [p.clientId, p.rule, p.period]);
    if (!claim.rowCount) continue;
    const t = await pool.query(
      `insert into tasks (title, description, status, priority, assignee_id, client_id, start_date, due_date, visibility, tags)
       values ($1,$2,'todo','normal',$3,$4,$5,$6,'team',array['auto','suivi-fiscal']) returning id`,
      [p.title, p.description, p.assigneeId, p.clientId, p.start, p.due]);
    const id = t.rows[0].id;
    for (const [i, text] of p.bullets.entries()) await pool.query("insert into task_checklist (task_id, text, position) values ($1,$2,$3)", [id, text, i]);
    await pool.query("update auto_task_log set task_id = $4 where client_id = $1 and rule = $2 and period = $3", [p.clientId, p.rule, p.period, id]);
    created.push(p);
  }
  return created;
}

export async function autoTaskTick(): Promise<void> {
  const made = await runAutoTasks();
  if (made.length) console.log(`[auto-tasks] created ${made.length} task(s)`);
}
