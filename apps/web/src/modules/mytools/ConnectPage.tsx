import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, ExternalLink, Inbox, Link2, Paperclip, Plug, RefreshCw, Unplug } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, mondayOf, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

interface Status { configured: boolean; connected: boolean; email: string | null; needsReauth: boolean; redirectUri: string | null }
interface Ev { id: string; subject: string; start: string; end: string; allDay: boolean; location: string; showAs: string; isPrivate: boolean; webLink: string | null }
interface Msg { id: string; subject: string; from: string; fromEmail: string; receivedAt: string; isRead: boolean; preview: string; hasAttachments: boolean; webLink: string | null }

const ERR: Record<string, [string, string]> = {
  state: ["La connexion a expiré ou n'appartient pas à cette session : recommencez.", "The sign-in expired or does not belong to this session: try again."],
  microsoft_refused: ["Microsoft a refusé la connexion.", "Microsoft refused the sign-in."], ms_reauth: ["Microsoft demande de vous reconnecter.", "Microsoft asks you to sign in again."],
  public_url_missing: ["L'adresse publique de l'application n'est pas réglée sur le serveur.", "The app's public address is not set on the server."], microsoft_not_configured: ["Microsoft 365 n'est pas configuré.", "Microsoft 365 is not configured."],
};

/**
 * Calendar and inbox come from each person's own Microsoft 365 account (read only), through the firm's Entra app.
 * The person signs in once from here; only a refresh token is kept, and it can be removed with "Disconnect".
 */
export default function ConnectPage({ kind }: { kind: "calendar" | "mail" }) {
  const l = useL();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [error, setError] = useState("");
  const st = useQuery({ queryKey: ["ms-status"], queryFn: () => api<Status>("/api/microsoft/status") });
  const s = st.data;
  const title = kind === "calendar" ? l("Calendrier Microsoft 365", "Microsoft 365 calendar") : l("Boîte de réception Outlook", "Outlook inbox");
  const Icon = kind === "calendar" ? CalendarDays : Inbox;
  const connect = async () => { try { setError(""); window.location.href = (await api<{ url: string }>("/api/microsoft/connect")).url; } catch (e) { setError(ERR[errMsg(e, "")] ? l(...ERR[errMsg(e, "")]!) : errMsg(e, "Error")); } };
  const disconnect = async () => { if (window.confirm(l("Déconnecter votre compte Microsoft 365 ?", "Disconnect your Microsoft 365 account?"))) { await api("/api/microsoft/disconnect", { method: "DELETE" }); await qc.invalidateQueries({ queryKey: ["ms-status"] }); } };
  const back = sp.get("error");
  if (!s) return null;

  const gate = (content: ReactNode) => <div className="glass grid place-items-center gap-3 p-12 text-center"><Icon size={36} className="text-brand" />{content}</div>;
  let body: ReactNode;
  if (!s.configured) body = gate(<>
    <h2 className="text-lg font-semibold">{l("Microsoft 365 n'est pas encore configuré", "Microsoft 365 is not configured yet")}</h2>
    <p className="max-w-lg text-sm text-muted">{l("Un administrateur doit d'abord enregistrer l'application Azure du cabinet (ID de l'annuaire, ID client et secret) et l'activer.", "An administrator must first save the firm's Azure application (tenant ID, client ID and secret) and enable it.")}</p>
    {can("admin.integrations.view") && <Link to="/admin/integrations/o365" className="btn btn-primary no-underline"><Plug size={15} />{l("Configurer Microsoft 365", "Configure Microsoft 365")}</Link>}</>);
  else if (!s.connected || s.needsReauth) body = gate(<>
    <h2 className="text-lg font-semibold">{s.needsReauth ? l("Reconnexion requise", "Sign in again") : l("Connectez votre compte Microsoft 365", "Connect your Microsoft 365 account")}</h2>
    <p className="max-w-lg text-sm text-muted">{l("Vous verrez votre propre calendrier et votre propre boîte de réception, en lecture seule. Personne d'autre n'y a accès par Hexa. Vous pouvez vous déconnecter en tout temps.", "You will see your own calendar and inbox, read only. Nobody else can reach them through Hexa. You can disconnect at any time.")}</p>
    <button className="btn btn-primary" onClick={() => void connect()}><Link2 size={15} />{l("Se connecter avec Microsoft", "Sign in with Microsoft")}</button></>);
  else body = kind === "calendar" ? <CalendarView /> : <InboxView />;

  return (
    <>
      <PageHeader title={title} subtitle={s.connected && !s.needsReauth ? s.email ?? undefined : undefined}
        actions={s.connected && !s.needsReauth && <button className="btn" onClick={() => void disconnect()}><Unplug size={15} />{l("Déconnecter", "Disconnect")}</button>} />
      {sp.get("connected") && <p role="status" className="mb-3 text-sm text-ok" onClick={() => setSp({}, { replace: true })}>{l("Compte connecté.", "Account connected.")}</p>}
      {(back || error) && <p role="alert" className="mb-3 text-sm text-danger">{ERR[back ?? ""] ? l(...ERR[back!]!) : (back ?? error)}</p>}
      {body}
    </>
  );
}

function CalendarView() {
  const l = useL();
  const loc = useLocale();
  const [from, setFrom] = useState(mondayOf(todayISO()));
  const q = useQuery({ queryKey: ["ms-cal", from], queryFn: () => api<{ events: Ev[] }>(`/api/microsoft/calendar?from=${from}&to=${addDays(from, 6)}`), retry: false });
  const today = todayISO();
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const evs = q.data?.events ?? [];
  const on = (d: string) => evs.filter((e) => e.start.slice(0, 10) <= d && e.end.slice(0, 10) >= d).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn !p-2" onClick={() => setFrom(addDays(from, -7))} aria-label="prev"><ChevronLeft size={16} /></button>
        <div className="glass-flat px-4 py-2 text-sm font-medium">{fmtDate(from, loc)} → {fmtDate(addDays(from, 6), loc)}</div>
        <button className="btn !p-2" onClick={() => setFrom(addDays(from, 7))} aria-label="next"><ChevronRight size={16} /></button>
        <button className="btn" onClick={() => setFrom(mondayOf(today))}>{l("Cette semaine", "This week")}</button>
        <button className="btn !p-2" onClick={() => void q.refetch()} aria-label="refresh"><RefreshCw size={15} /></button>
      </div>
      {q.error && <p role="alert" className="mb-3 text-sm text-danger">{errMsg(q.error, "Error") === "ms_reauth" ? l("Microsoft demande de vous reconnecter : rechargez la page.", "Microsoft asks you to sign in again: reload the page.") : errMsg(q.error, "Error")}</p>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {days.map((d) => (
          <section key={d} className="glass p-3" style={{ borderColor: d === today ? "var(--warn)" : undefined }}>
            <h3 className="mb-2 text-sm font-semibold capitalize">{new Date(`${d}T12:00:00`).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "short" })}</h3>
            {!on(d).length ? <p className="text-xs text-muted">—</p> : <ul className="space-y-2 text-sm">{on(d).map((e) => (
              <li key={e.id} className="glass-flat p-2">
                <div className="flex items-center justify-between gap-2"><b className="truncate">{e.isPrivate || !e.subject ? l("Occupé", "Busy") : e.subject}</b>{e.webLink && <a href={e.webLink} target="_blank" rel="noopener noreferrer" aria-label="open in Outlook"><ExternalLink size={12} /></a>}</div>
                <div className="text-xs text-muted">{e.allDay ? l("Toute la journée", "All day") : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`}{e.location ? ` · ${e.location}` : ""}</div>
                {e.showAs === "free" && <div className="text-[10px] text-muted">{l("Disponible", "Free")}</div>}
              </li>))}</ul>}
          </section>))}
      </div>
    </>
  );
}

function InboxView() {
  const l = useL();
  const loc = useLocale();
  const [unread, setUnread] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["ms-mail", unread], queryFn: () => api<{ messages: Msg[] }>(`/api/microsoft/mail?top=30${unread ? "&unread=1" : ""}`), retry: false });
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={unread} onChange={(e) => setUnread(e.target.checked)} />{l("Non lus seulement", "Unread only")}</label>
        <button className="btn !p-2" onClick={() => void q.refetch()} aria-label="refresh"><RefreshCw size={15} /></button>
      </div>
      {q.error && <p role="alert" className="mb-3 text-sm text-danger">{errMsg(q.error, "Error") === "ms_reauth" ? l("Microsoft demande de vous reconnecter : rechargez la page.", "Microsoft asks you to sign in again: reload the page.") : errMsg(q.error, "Error")}</p>}
      <div className="glass p-2">
        {!q.data?.messages.length ? <Empty>{l("Aucun message.", "No messages.")}</Empty> : (
          <ul>{q.data.messages.map((m) => (
            <li key={m.id}><button className="flex w-full items-start gap-3 rounded-lg p-3 text-left hover:bg-white/5" onClick={() => setOpen(m.id)}>
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: m.isRead ? "transparent" : "var(--brand)" }} />
              <span className="min-w-0 flex-1"><span className="flex items-center gap-2"><span className={`truncate ${m.isRead ? "" : "font-semibold"}`}>{m.from}</span>{m.hasAttachments && <Paperclip size={12} className="text-muted" />}<span className="ml-auto shrink-0 text-xs text-muted">{new Date(m.receivedAt).toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" })}</span></span>
                <span className={`block truncate text-sm ${m.isRead ? "text-muted" : ""}`}>{m.subject || l("(sans objet)", "(no subject)")}</span><span className="block truncate text-xs text-muted">{m.preview}</span></span></button></li>))}</ul>)}
      </div>
      {open && <MessageDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function MessageDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const q = useQuery({ queryKey: ["ms-msg", id], queryFn: () => api<{ subject: string; from: string; fromEmail: string; to: string[]; receivedAt: string; body: string; webLink: string | null }>(`/api/microsoft/mail/${encodeURIComponent(id)}`) });
  const m = q.data;
  return (
    <Modal title={m?.subject || l("Message", "Message")} onClose={onClose} wide>
      {!m ? null : (
        <>
          <div className="mb-3 text-sm"><b>{m.from}</b> <span className="text-muted">&lt;{m.fromEmail}&gt;</span><div className="text-xs text-muted">{l("À", "To")}: {m.to.join(", ")} · {new Date(m.receivedAt).toLocaleString(loc)}</div></div>
          {/* Plain text only: Microsoft converts the message, and React shows it as text. */}
          <pre className="glass-flat max-h-[50vh] overflow-auto whitespace-pre-wrap p-3 text-sm">{m.body}</pre>
          <div className="mt-4 flex justify-between"><Chip>{l("Lecture seule", "Read only")}</Chip><div className="flex gap-2">{m.webLink && <a className="btn no-underline" href={m.webLink} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />{l("Ouvrir dans Outlook", "Open in Outlook")}</a>}<button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button></div></div>
        </>)}
    </Modal>
  );
}
