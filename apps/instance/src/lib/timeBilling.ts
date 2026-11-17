import { pool } from "../db.ts";
import { applyAutoApprove } from "./autoApprove.ts";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/** Hours billed for a time entry: the billable minutes when set, else all its minutes, in hundredths of an hour. */
export const billedHours = (minutes: number, billableMinutes: number | null | undefined): number => Math.round(((billableMinutes ?? minutes) / 60) * 100) / 100;

/**
 * The one place time becomes "work to bill" (billing_items, source 'time', source_id = entry id, status 'pending' until approved).
 * Used when a week is approved and when a task is completed. Only billable work/travel entries with a client and minutes count;
 * the unique (source, source_id) index plus `on conflict do nothing` means an entry is never billed twice, whichever path comes first.
 * Rate = the client's active hourly contract. Returns the client ids that got new items (for auto-approve, run after commit).
 */
export async function billTimeEntries(db: Q, scope: { entryIds: string[] } | { taskId: string }): Promise<string[]> {
  const where = "entryIds" in scope ? "e.id = any($1::uuid[])" : "e.task_id = $1";
  const arg = "entryIds" in scope ? scope.entryIds : scope.taskId;
  const r = await db.query(
    `insert into billing_items (client_id, source, source_id, description, quantity, unit_price, work_date, created_by)
     select e.client_id, 'time', e.id, coalesce(nullif(e.description, ''), k.title, 'Temps de travail'),
            round(coalesce(e.billable_minutes, e.minutes) / 60.0, 2),
            coalesce((select c.hourly_rate from client_contracts c where c.client_id = e.client_id and c.kind = 'hourly' and c.status = 'active' and c.hourly_rate is not null order by c.created_at desc limit 1), 0),
            e.work_date, e.user_id
       from timesheet_entries e join time_types t on t.key = e.type_key left join tasks k on k.id = e.task_id
      where ${where} and e.billable and e.client_id is not null and e.minutes > 0 and coalesce(e.billable_minutes, e.minutes) > 0 and t.kind in ('work', 'travel')
     on conflict do nothing returning client_id`, [arg]);
  return [...new Set(r.rows.map((x) => x.client_id as string))];
}

export const autoApproveClients = async (clientIds: string[]) => { for (const id of clientIds) await applyAutoApprove(id); };

/**
 * Before changing or deleting a time entry: its item must not be approved, excluded or invoiced (a decision was taken on it).
 * Returns null when free, else the error code. A pending item is fine: see resyncEntryBilling.
 */
export async function entryBillingLock(id: string): Promise<"entry_invoiced" | "entry_billed" | null> {
  const s = (await pool.query("select status from billing_items where source = 'time' and source_id = $1", [id])).rows[0]?.status as string | undefined;
  return !s || s === "pending" ? null : s === "invoiced" ? "entry_invoiced" : "entry_billed";
}

/** After an entry was edited: its pending item (if any) is rebuilt from the entry, and a completed task's entry that now qualifies gets one. */
export async function resyncEntryBilling(id: string): Promise<void> {
  await pool.query("delete from billing_items where source = 'time' and source_id = $1 and status = 'pending'", [id]);
  const done = (await pool.query("select 1 from timesheet_entries e join tasks k on k.id = e.task_id where e.id = $1 and k.status = 'done'", [id])).rowCount;
  if (done) await autoApproveClients(await billTimeEntries(pool, { entryIds: [id] }));
}

/**
 * A completed task put back to not done (a mistake undone): its time items still waiting for approval go away, so nothing
 * unapproved is left to bill. Approved, excluded and invoiced items are decisions already taken and are never touched.
 * Completing it again rebuilds them (billTimeEntries). Returns how many items were removed.
 */
export async function unbillTaskTime(db: Q, taskId: string): Promise<number> {
  const r = await db.query(
    "delete from billing_items where source = 'time' and status = 'pending' and source_id in (select id from timesheet_entries where task_id = $1)", [taskId]);
  return r.rowCount ?? 0;
}
