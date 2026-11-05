import { pool } from "../db.ts";

/**
 * A client can have kinds of work to bill approved on arrival (clients.auto_approve_kinds: time, expense, contract, manual).
 * Called after work to bill is added, and when the setting changes (it then also covers what is already waiting).
 */
export async function applyAutoApprove(clientId: string): Promise<number> {
  const r = await pool.query(
    `update billing_items b set status = 'approved', decided_at = now()
       from clients c where c.id = b.client_id and b.client_id = $1 and b.status = 'pending' and b.source = any(c.auto_approve_kinds) returning b.id`, [clientId]);
  return r.rowCount ?? 0;
}
