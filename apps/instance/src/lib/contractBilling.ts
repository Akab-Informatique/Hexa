import { chargesFor, type ServiceLine } from "@hexa/shared/contractCharges";
import { todayISO } from "@hexa/shared/billing";
import { centsToDecimal, chargeKeyText } from "@hexa/shared/productSale";
import { pool } from "../db.ts";
import { uuidFromKey } from "./billingKeys.ts";

export interface BillingLine extends ServiceLine { taxable: boolean }

export async function linesOf(contractId: string): Promise<BillingLine[]> {
  const r = await pool.query(
    `select x.id, x.name, x.kind, x.unit_price_cents, x.quantity, x.added_on, x.ends_on, coalesce(s.taxable, true) as taxable
       from contract_services x left join services s on s.id = x.service_id where x.contract_id = $1 order by x.added_on, x.created_at`, [contractId]);
  return r.rows.map((x) => ({ id: x.id, name: x.name, kind: x.kind, priceCents: x.unit_price_cents, quantity: Number(x.quantity), addedOn: x.added_on, endsOn: x.ends_on, taxable: x.taxable }));
}

/**
 * Work to bill from contract services: one pending line per service and charge that has come due, once.
 * The line's source_id is a hash of contract + line + charge date, so the unique (source, source_id) index makes a second run a no-op
 * (idempotent: any number of runs, in any order, create each charge exactly once). Charges up to the contract's billed_through day are skipped.
 * Lines always arrive pending; the client's "auto-approve contract lines" setting is the only thing that approves them.
 * A contract line removed and added again is a new line, so it may bill a period again: remove with care.
 */
export async function refreshContractBilling(clientId?: string): Promise<number> {
  const today = todayISO();
  const contracts = (await pool.query(
    `select k.id, k.client_id, k.name, k.billing_period, k.starts_on, k.ends_on, k.billed_through, cl.auto_approve_kinds
       from client_contracts k join clients cl on cl.id = k.client_id where k.status = 'active' and cl.status <> 'inactive' and ($1::uuid is null or k.client_id = $1)`, [clientId ?? null])).rows;
  if (!contracts.length) return 0;
  // Two reads for every contract (instead of one query per contract), then one set-based insert per chunk (instead of one insert per charge).
  const lineRows = (await pool.query(
    `select x.contract_id, x.id, x.name, x.kind, x.unit_price_cents, x.quantity, x.added_on, x.ends_on, coalesce(s.taxable, true) as taxable
       from contract_services x left join services s on s.id = x.service_id where x.contract_id = any($1::uuid[]) order by x.added_on, x.created_at`, [contracts.map((k) => k.id)])).rows;
  const byContract = new Map<string, BillingLine[]>();
  for (const x of lineRows) {
    const l: BillingLine = { id: x.id, name: x.name, kind: x.kind, priceCents: x.unit_price_cents, quantity: Number(x.quantity), addedOn: x.added_on, endsOn: x.ends_on, taxable: x.taxable };
    const a = byContract.get(x.contract_id);
    if (a) a.push(l); else byContract.set(x.contract_id, [l]);
  }
  const rows: { client: string; sourceId: string; contract: string; description: string; price: string; date: string; status: string; taxable: boolean }[] = [];
  for (const k of contracts) {
    const lines = byContract.get(k.id);
    if (!lines?.length) continue;
    const taxable = new Map(lines.map((l) => [l.id, l.taxable]));
    const charges = chargesFor({ billingPeriod: k.billing_period, startsOn: k.starts_on, endsOn: k.ends_on }, lines, today)
      .filter((ch) => !k.billed_through || ch.date > k.billed_through)
      .filter((ch) => ch.cents > 0);
    const auto = (k.auto_approve_kinds as string[]).includes("contract");
    for (const ch of charges) {
      rows.push({
        client: k.client_id, sourceId: uuidFromKey(chargeKeyText(k.id, ch.lineId, ch.date)), contract: k.id,
        description: `${k.name} · ${ch.description}${ch.prorated ? ` — prorata ${ch.days}/${ch.periodDays} j` : ""}`.slice(0, 500),
        price: centsToDecimal(ch.cents), date: ch.date, status: auto ? "approved" : "pending", taxable: taxable.get(ch.lineId) ?? true,
      });
    }
  }
  let created = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const ch = rows.slice(i, i + 500);
    const r = await pool.query(
      `insert into billing_items (client_id, source, source_id, contract_id, description, quantity, unit_price, work_date, status, taxable)
       select i.client, 'contract', i.source_id, i.contract, i.description, 1, i.price, i.work_date, i.status, i.taxable
         from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::numeric[], $6::date[], $7::text[], $8::boolean[]) as i(client, source_id, contract, description, price, work_date, status, taxable)
       on conflict do nothing`,
      [ch.map((x) => x.client), ch.map((x) => x.sourceId), ch.map((x) => x.contract), ch.map((x) => x.description), ch.map((x) => x.price), ch.map((x) => x.date), ch.map((x) => x.status), ch.map((x) => x.taxable)]);
    created += r.rowCount ?? 0;
  }
  return created;
}
