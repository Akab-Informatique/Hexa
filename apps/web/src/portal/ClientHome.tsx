import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Pin } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate, money, useL, useLocale } from "../lib/l";
import { Empty, Stat } from "../components/kit";
import { PageHeader } from "../components/ui";

interface Me { client: { name: string }; balance: number; overdueCount: number }
interface Msg { id: string; title: string; body: string; pinned: boolean; createdAt: string; authorName: string | null }

/** Home: what the client owes right now and the firm's messages. */
export default function ClientHome() {
  const l = useL();
  const loc = useLocale();
  const { can, me } = useAuth();
  const info = useQuery({ queryKey: ["portal-me"], queryFn: () => api<Me>("/api/portal/me") });
  const board = useQuery({ queryKey: ["portal-board"], queryFn: () => api<Msg[]>("/api/portal/board"), enabled: can("clientportal.board.view") });
  return (
    <>
      <PageHeader title={`${l("Bonjour", "Hello")} ${me.user?.name.split(" ")[0] ?? ""}`} subtitle={info.data?.client.name} />
      {can("clientportal.invoices.view") && info.data && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label={l("Solde à payer", "Balance due")} value={money(info.data.balance, loc)} tone={info.data.overdueCount ? "warn" : undefined} />
          <Stat label={l("Factures en retard", "Overdue invoices")} value={info.data.overdueCount} tone={info.data.overdueCount ? "danger" : undefined} />
          <Link to="/invoices" className="glass flex items-center justify-center p-4 text-sm font-medium hover:brightness-125">{l("Voir mes factures", "See my invoices")}</Link>
        </div>
      )}
      {can("clientportal.board.view") && (
        <>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{l("Messages", "Messages")}</h2>
          <div className="space-y-3">
            {(board.data ?? []).length === 0 ? <div className="glass"><Empty>{l("Aucun message pour le moment.", "No messages yet.")}</Empty></div> : board.data!.map((m) => (
              <article key={m.id} className="glass p-5" style={m.pinned ? { borderColor: "var(--brand)" } : undefined}>
                <div className="flex items-start justify-between gap-3"><h3 className="font-semibold">{m.title}</h3>{m.pinned && <Pin size={14} className="shrink-0 text-muted" />}</div>
                <div className="mb-2 text-xs text-muted">{fmtDate(m.createdAt, loc)}{m.authorName ? ` · ${m.authorName}` : ""}</div>
                <p className="whitespace-pre-wrap text-sm">{m.body}</p>
              </article>))}
          </div>
        </>
      )}
    </>
  );
}
