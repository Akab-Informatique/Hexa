import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { fmtDate, money, useL, useLocale } from "../lib/l";
import { Chip, Empty } from "../components/kit";
import { PageHeader } from "../components/ui";

interface Contract { id: string; name: string; kind: string; amount: string; hourlyRate: string | null; cycle: string; startsOn: string | null; endsOn: string | null; status: string; bankHours: string | null }

export default function ClientContracts() {
  const l = useL();
  const loc = useLocale();
  const q = useQuery({ queryKey: ["portal-contracts"], queryFn: () => api<Contract[]>("/api/portal/contracts") });
  const kind: Record<string, [string, string]> = { recurring: ["Récurrent", "Recurring"], hourly: ["À l'heure", "Hourly"], fixed: ["Forfait", "Fixed price"], hours_bank: ["Banque d'heures", "Hours bank"] };
  const cycle: Record<string, [string, string]> = { monthly: ["par mois", "per month"], quarterly: ["par trimestre", "per quarter"], yearly: ["par année", "per year"], one_time: ["une fois", "one time"] };
  const rows = q.data ?? [];
  return (
    <>
      <PageHeader title={l("Contrats", "Contracts")} subtitle={l("Vos ententes de service avec nous", "Your service agreements with us")} />
      {rows.length === 0 ? <div className="glass"><Empty>{l("Aucun contrat.", "No contracts.")}</Empty></div> : (
        <div className="grid gap-3 md:grid-cols-2">{rows.map((c) => {
          const k = kind[c.kind] ?? [c.kind, c.kind], cy = cycle[c.cycle] ?? [c.cycle, c.cycle];
          return (
            <div key={c.id} className="glass p-5">
              <div className="flex items-start justify-between gap-2"><div className="font-semibold">{c.name}</div><Chip tone={c.status === "active" ? "ok" : "off"}>{c.status === "active" ? l("Actif", "Active") : c.status === "paused" ? l("En pause", "Paused") : l("Terminé", "Ended")}</Chip></div>
              <div className="mt-1 text-xs text-muted">{l(k[0], k[1])}</div>
              <div className="mt-3 text-sm">{c.kind === "hourly" ? `${money(Number(c.hourlyRate), loc)} / h` : <>{money(Number(c.amount), loc)} <span className="text-muted">{l(cy[0], cy[1])}</span></>}{c.bankHours ? <span className="text-muted"> · {c.bankHours} h</span> : null}</div>
              <div className="mt-2 text-xs text-muted">{c.startsOn ? `${l("Début", "Start")}: ${fmtDate(c.startsOn, loc)}` : ""}{c.endsOn ? ` · ${l("Fin", "End")}: ${fmtDate(c.endsOn, loc)}` : ""}</div>
            </div>);
        })}</div>)}
    </>
  );
}
