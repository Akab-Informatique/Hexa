import { pool } from "../db.ts";
import { PROFILES } from "./profiles.ts";

/** Seeds one demo profile on a brand-new install. Does nothing for "none" or an unknown profile. */
export async function seedDemo(profile: string, adminId: string): Promise<void> {
  const p = PROFILES[profile];
  if (!p) return;
  const ids: string[] = [];
  for (const c of p.clients) {
    const r = await pool.query(
      `insert into clients (name, business_number, fiscal_year_end, city, province, created_by) values ($1,$2,$3,$4,'QC',$5) returning id`,
      [c.name, c.businessNumber, c.fiscalYearEnd, c.city, adminId]);
    const id = r.rows[0].id as string;
    ids.push(id);
    const k = await pool.query("insert into client_contacts (client_id, name, email, title, is_primary, is_billing) values ($1,$2,$3,$4,true,true) returning id", [id, c.contact.name, c.contact.email, c.contact.title]);
    await pool.query("update clients set billing_contact_id = $2, billing_email = $3 where id = $1", [id, k.rows[0].id, c.contact.email]);
    if (c.contract) {
      const kr = await pool.query(
        `insert into client_contracts (client_id, name, kind, amount, hourly_rate, cycle, starts_on, billing_period) values ($1,$2,$3,$4,$5,$6,current_date - 90,$7) returning id`,
        [id, c.contract.name, c.contract.kind, c.contract.amount ?? 0, c.contract.hourlyRate ?? null, c.contract.cycle, c.contract.cycle === "yearly" ? "yearly" : "monthly"]);
      if (c.contract.kind === "recurring") {
        // A recurring contract carries its service, copied from the catalogue (name and price at the time).
        const kind = c.contract.cycle === "yearly" ? "yearly" : "monthly";
        const cents = Math.round((c.contract.amount ?? 0) * 100);
        const sv = await pool.query("insert into services (name, kind, price_cents) values ($1,$2,$3) on conflict (lower(name)) do update set name = services.name returning id", [c.contract.name, kind, cents]);
        await pool.query("insert into contract_services (contract_id, service_id, name, kind, unit_price_cents, quantity, added_on) values ($1,$2,$3,$4,$5,1,current_date - 90)", [kr.rows[0].id, sv.rows[0].id, c.contract.name, kind, cents]);
      }
    }
  }
  for (const t of p.tasks) {
    const r = await pool.query(
      `insert into tasks (title, client_id, due_date, priority, assignee_id, created_by) values ($1,$2, current_date + $3::int, $4, $5, $5) returning id`,
      [t.title, ids[t.client], t.dueInDays, t.priority, adminId]);
    for (const [i, text] of (t.checklist ?? []).entries()) await pool.query("insert into task_checklist (task_id, text, position) values ($1,$2,$3)", [r.rows[0].id, text, i]);
  }
  await pool.query("insert into kb_articles (title, category, body, author_id) values ($1,$2,$3,$4)", [p.kb.title, p.kb.category, p.kb.body, adminId]);
  const proc = await pool.query("insert into procedures (title, status, author_id) values ($1,'published',$2) returning id", [p.procedure.title, adminId]);
  for (const [i, title] of p.procedure.steps.entries()) await pool.query("insert into procedure_steps (procedure_id, position, title) values ($1,$2,$3)", [proc.rows[0].id, i, title]);
  await pool.query("insert into messages (title, body, author_id, audience) values ($1,$2,$3,'all')", [p.message.title, p.message.body, adminId]);
  console.log(`[seed] demo data "${profile}" created (${p.clients.length} clients)`);
}
