import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, Stat, Tabs, Toolbar } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import { ContractWindow } from "../clients/ContractWindow";
import { useQueryClient } from "@tanstack/react-query";

interface Row { id: string; name: string; kind: string; status: string; clientId: string; clientName: string; startsOn: string; endsOn: string | null; monthlyCents: number; serviceCount: number; hourlyRate: number | null; amount: number; billingPeriod: string; supportDefault: boolean }

const OPEN_KEY = "nexo.contracts.opened";
const readOpen = (): string[] => { try { return JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "[]"); } catch { return []; } };

/** Every contract, grouped by client (folded by default, remembered for the session), with the monthly total of each client. */
export default function ContractsPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"active" | "inactive" | "all">("active");
  const [q, setQ] = useState("");
  const [opened, setOpened] = useState<string[]>(readOpen);
  const [openId, setOpenId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const list = useQuery({ queryKey: ["contracts-all", status, q], queryFn: () => api<Row[]>(`/api/clients/contracts/all?status=${status}&q=${encodeURIComponent(q)}`) });
  const rows = list.data ?? [];
  const groups = [...new Set(rows.map((r) => r.clientId))].map((cid) => ({ id: cid, name: rows.find((r) => r.clientId === cid)!.clientName, items: rows.filter((r) => r.clientId === cid) }));
  const total = rows.filter((r) => r.status === "active").reduce((a, r) => a + r.monthlyCents, 0);
  const save = (n: string[]) => { setOpened(n); try { sessionStorage.setItem(OPEN_KEY, JSON.stringify(n)); } catch { /* ignore */ } };
  const toggle = (id: string) => save(opened.includes(id) ? opened.filter((x) => x !== id) : [...opened, id]);
  const kindText = (k: string) => (k === "recurring" ? l("Services récurrents", "Recurring services") : k === "hourly" ? l("Taux horaire", "Hourly") : k === "hours_bank" ? l("Banque d'heures", "Hours bank") : l("Prix fixe", "Fixed price"));
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["contracts-all"] }); };

  return (
    <>
      <PageHeader title={l("Contrats", "Contracts")} subtitle={l("Tous les contrats, par client", "Every contract, by client")}
        actions={can("accounting.approvals.manage", "clients.billing.manage") && <button className="btn" onClick={async () => { setMsg(""); try { const r = await api<{ created: number }>("/api/clients/contracts/refresh-billing", { method: "POST" }); setMsg(l(`${r.created} ligne(s) ajoutée(s) au travail à facturer.`, `${r.created} line(s) added to work to bill.`)); } catch (e) { setMsg(errMsg(e, "Error")); } }}><RefreshCw size={15} />{l("Générer le travail à facturer", "Generate work to bill")}</button>} />
      {msg && <p role="status" className="mb-3 text-sm text-muted">{msg}</p>}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4"><Stat label={l("Contrats actifs", "Active contracts")} value={rows.filter((r) => r.status === "active").length} /><Stat label={l("Récurrent par mois", "Recurring per month")} value={money(total / 100, loc)} /></div>
      <Toolbar>
        <Tabs tabs={[{ key: "active", label: l("Actifs", "Active") }, { key: "inactive", label: l("Inactifs", "Inactive") }, { key: "all", label: l("Tous", "All") }]} value={status} onChange={setStatus} />
        <div className="relative min-w-[220px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" /><input className="input !pl-9" placeholder={l("Rechercher…", "Search…")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className="btn" onClick={() => save(opened.length ? [] : groups.map((g) => g.id))}>{opened.length ? l("Tout réduire", "Collapse all") : l("Tout ouvrir", "Expand all")}</button>
      </Toolbar>
      {!groups.length ? <div className="glass"><Empty>{l("Aucun contrat.", "No contracts.")}</Empty></div> : (
        <div className="space-y-3">{groups.map((g) => {
          const open = opened.includes(g.id);
          const sum = g.items.filter((r) => r.status === "active").reduce((a, r) => a + r.monthlyCents, 0);
          return (
            <section key={g.id} className="glass p-2">
              <button className="flex w-full items-center gap-2 px-2 py-2 text-left" onClick={() => toggle(g.id)} aria-expanded={open}>
                {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<span className="flex-1 font-medium">{g.name}</span>
                <span className="text-xs text-muted">{g.items.length} {l("contrat(s)", "contract(s)")}</span>{sum > 0 && <span className="text-sm">{money(sum / 100, loc)} / {l("mois", "mo")}</span>}
              </button>
              {open && (
                <table className="grid"><tbody>{g.items.map((r) => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => setOpenId(r.id)} style={{ opacity: r.status === "active" ? 1 : 0.55 }}>
                    <td><div className="font-medium">{r.name} {r.supportDefault && <Chip tone="warn">{l("Par défaut", "Default")}</Chip>}</div><div className="text-xs text-muted">{kindText(r.kind)}{r.kind === "recurring" ? ` · ${r.serviceCount} ${l("service(s)", "service(s)")}` : ""} · {fmtDate(r.startsOn, loc)}{r.endsOn ? ` → ${fmtDate(r.endsOn, loc)}` : ""}</div></td>
                    <td>{r.kind === "recurring" ? `${money(r.monthlyCents / 100, loc)} / ${l("mois", "mo")}` : r.kind === "fixed" ? money(r.amount, loc) : r.hourlyRate != null ? (Number(r.hourlyRate) === 0 ? l("Heures incluses", "Hours included") : `${money(r.hourlyRate, loc)}/h`) : "—"}</td>
                    <td><Chip tone={r.status === "active" ? "ok" : "off"}>{r.status === "active" ? l("Actif", "Active") : r.status === "paused" ? l("En pause", "Paused") : l("Terminé", "Ended")}</Chip></td>
                    <td className="text-right text-xs"><Link to={`/clients/${r.clientId}`} onClick={(e) => e.stopPropagation()}>{l("Dossier client", "Client file")}</Link></td></tr>))}</tbody></table>)}
            </section>);
        })}</div>)}
      {openId && <ContractWindow id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />}
    </>
  );
}
