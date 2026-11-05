import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Empty, Stat } from "../../components/kit";
import { Modal } from "../../components/ui";

interface Statement {
  client: { name: string; address: string; city: string; province: string; postalCode: string; billingEmail: string; email: string }; today: string;
  rows: { id: string; number: string; issueDate: string; dueDate: string; poNumber: string; total: number; balance: number; daysLate: number; bucket: string }[];
  buckets: { notDue: number; d1_30: number; d31_60: number; d61_90: number; d90: number }; total: number; pastDue: number;
}

/** What a client still owes, by due day, with the aging of the debt. Printed from the browser. */
export function StatementDialog({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const q = useQuery({ queryKey: ["statement", clientId], queryFn: () => api<Statement>(`/api/accounting/clients/${clientId}/statement`) });
  const s = q.data;
  return (
    <Modal title={l("Relevé de compte", "Account statement")} onClose={onClose} wide>
      {!s ? null : (
        <div id="print-area">
          <div className="mb-4 flex flex-wrap justify-between gap-3 text-sm">
            <div><div className="text-base font-semibold">{s.client.name}</div><div className="text-muted">{[s.client.address, s.client.city, s.client.province, s.client.postalCode].filter(Boolean).join(", ")}</div><div className="text-muted">{s.client.billingEmail || s.client.email}</div></div>
            <div className="text-right"><div className="text-muted">{l("Au", "As of")}</div><div className="font-medium">{fmtDate(s.today, loc)}</div></div>
          </div>
          {!s.rows.length ? <Empty>{l("Rien à payer : le compte est à jour.", "Nothing owed: the account is up to date.")}</Empty> : (
            <table className="grid"><thead><tr><th>#</th><th>{l("Bon de commande", "PO")}</th><th>{l("Émise", "Issued")}</th><th>{l("Échéance", "Due")}</th><th>{l("Retard", "Late")}</th><th>{l("Total", "Total")}</th><th>{l("Solde", "Balance")}</th></tr></thead>
              <tbody>{s.rows.map((r) => <tr key={r.id}><td className="font-medium">{r.number}</td><td className="text-muted">{r.poNumber || "—"}</td><td>{fmtDate(r.issueDate, loc)}</td><td>{fmtDate(r.dueDate, loc)}</td><td style={{ color: r.daysLate ? "var(--danger)" : undefined }}>{r.daysLate ? `${r.daysLate} ${l("j", "d")}` : "—"}</td><td>{money(r.total, loc)}</td><td className="font-medium">{money(r.balance, loc)}</td></tr>)}</tbody></table>)}
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
            <Stat label={l("Pas échu", "Not due")} value={money(s.buckets.notDue, loc)} /><Stat label="1–30 j" value={money(s.buckets.d1_30, loc)} /><Stat label="31–60 j" value={money(s.buckets.d31_60, loc)} />
            <Stat label="61–90 j" value={money(s.buckets.d61_90, loc)} /><Stat label="90+ j" value={money(s.buckets.d90, loc)} tone={s.buckets.d90 ? "danger" : undefined} /><Stat label={l("Total dû", "Total owed")} value={money(s.total, loc)} tone={s.pastDue ? "warn" : undefined} />
          </div>
        </div>)}
      <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={() => window.print()}>{l("Imprimer / PDF", "Print / PDF")}</button><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button></div>
    </Modal>
  );
}
