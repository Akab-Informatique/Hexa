import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Link2, Mail, RefreshCw, Unplug } from "lucide-react";
import { api } from "../lib/api";
import { fmtDate, useL, useLocale } from "../lib/l";
import { Chip, errMsg } from "../components/kit";

const ERR: Record<string, [string, string]> = {
  mailjet_not_configured: ["Mailjet n'est pas configuré ou activé.", "Mailjet is not set up or not enabled."], mailjet_refused: ["Mailjet a refusé la clé d'API ou la clé secrète.", "Mailjet refused the API key or the secret key."],
  mail_failed: ["Mailjet n'a pas pu envoyer le message.", "Mailjet could not send the message."], invalid_address: ["Adresse invalide.", "Invalid address."],
  quickbooks_not_configured: ["QuickBooks n'est pas configuré ou activé.", "QuickBooks is not set up or not enabled."], quickbooks_not_connected: ["QuickBooks n'est pas connecté.", "QuickBooks is not connected."],
  public_url_missing: ["L'adresse publique de l'application (PUBLIC_URL) n'est pas réglée sur le serveur.", "The app's public address (PUBLIC_URL) is not set on the server."], state: ["La connexion a expiré ou n'appartient pas à cette session : recommencez.", "The sign-in expired or does not belong to this session: try again."],
  qb_reauth: ["QuickBooks demande de se reconnecter.", "QuickBooks asks to connect again."], intuit_refused: ["Intuit a refusé la connexion (vérifiez l'ID et le secret).", "Intuit refused the connection (check the ID and secret)."],
  qb_no_income_account: ["Aucun compte de revenus dans QuickBooks.", "No income account in QuickBooks."],
};
export const codeText = (code: string, l: (a: string, b: string) => string) => (ERR[code] ? l(...ERR[code]!) : code);

function RedirectHint({ uri }: { uri: string | null }) {
  const l = useL();
  const [copied, setCopied] = useState(false);
  if (!uri) return <p className="text-xs text-warn">{l("L'adresse publique de l'application n'est pas réglée (PUBLIC_URL) : la connexion ne peut pas fonctionner.", "The app's public address is not set (PUBLIC_URL): the sign-in cannot work.")}</p>;
  return (
    <div className="text-xs text-muted">{l("Adresse de redirection à inscrire dans l'application du fournisseur :", "Redirect address to register in the provider's app:")}
      <div className="mt-1 flex items-center gap-2"><code className="glass-flat flex-1 truncate px-2 py-1.5">{uri}</code><button className="btn !p-1.5" aria-label="copy" onClick={() => { void navigator.clipboard?.writeText(uri); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <CheckCircle2 size={14} color="var(--ok)" /> : <Copy size={14} />}</button></div></div>
  );
}

/** What goes with each integration's credentials form: a test, a connection, and what it does. */
export function ProviderPanel({ provider }: { provider: string }) {
  if (provider === "mailjet") return <MailjetPanel />;
  if (provider === "quickbooks") return <QuickBooksPanel />;
  if (provider === "o365") return <MicrosoftPanel />;
  return null;
}

function MailjetPanel() {
  const l = useL();
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api<{ to: string }>("/api/admin/integrations/mailjet/test", { body: to ? { to } : {} }); setMsg({ ok: true, text: l(`Message de test envoyé à ${r.to}.`, `Test message sent to ${r.to}.`) }); }
    catch (e) { setMsg({ ok: false, text: codeText(errMsg(e, "Error"), l) }); } finally { setBusy(false); }
  };
  return (
    <div className="mt-6 border-t border-white/10 pt-5">
      <h3 className="mb-1 text-sm font-semibold"><Mail size={14} className="mr-1.5 inline" />{l("Tester l'envoi", "Test sending")}</h3>
      <p className="mb-3 text-xs text-muted">{l("Enregistrez et activez d'abord. L'adresse de l'expéditeur doit être validée dans votre compte Mailjet. Une fois actif : factures, rappels, relevés de compte et copie courriel du babillard partent d'ici.", "Save and enable first. The sender address must be validated in your Mailjet account. Once on: invoices, reminders, account statements and the board's email copy go out from here.")}</p>
      <div className="flex gap-2"><input className="input" type="email" placeholder={l("Votre courriel (par défaut)", "Your email (default)")} value={to} onChange={(e) => setTo(e.target.value)} /><button className="btn btn-primary" disabled={busy} onClick={() => void send()}>{l("Envoyer un test", "Send a test")}</button></div>
      {msg && <p role="status" className="mt-2 text-sm" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</p>}
    </div>
  );
}

function MicrosoftPanel() {
  const l = useL();
  const q = useQuery({ queryKey: ["ms-status"], queryFn: () => api<{ redirectUri: string | null }>("/api/microsoft/status") });
  return (
    <div className="mt-6 border-t border-white/10 pt-5 text-sm">
      <h3 className="mb-2 font-semibold"><Link2 size={14} className="mr-1.5 inline" />{l("Comment ça marche", "How it works")}</h3>
      <ul className="mb-3 list-disc space-y-1 pl-5 text-xs text-muted">
        <li>{l("Chaque personne connecte son propre compte Microsoft 365 depuis Mes outils › Calendrier ou Boîte de réception. Rien n'est lu pour les autres.", "Each person connects their own Microsoft 365 account from My tools › Calendar or Inbox. Nothing is read for anyone else.")}</li>
        <li>{l("Permissions déléguées à donner à l'application Entra : User.Read, Calendars.Read, Mail.Read (et offline_access). Lecture seule.", "Delegated permissions to give the Entra app: User.Read, Calendars.Read, Mail.Read (and offline_access). Read only.")}</li>
        <li>{l("Pour SharePoint (Documentation) : la permission d'application Sites.ReadWrite.All avec consentement administrateur.", "For SharePoint (Documentation): the application permission Sites.ReadWrite.All with admin consent.")}</li>
        <li>{l("Les événements Outlook d'une personne retirent leurs heures de sa journée dans Pipeline.", "A person's Outlook events take their hours off their day in Pipeline.")}</li></ul>
      <RedirectHint uri={q.data?.redirectUri ?? null} />
    </div>
  );
}

interface QbStatus { configured: boolean; connected: boolean; needsReauth: boolean; environment: string; realmId: string | null; connectedAt: string | null; lastPull: string | null; autoSync: boolean; redirectUri: string | null; linkedClients: number; clients: number }
interface PlanRow { clientId: string; name: string; action: "linked" | "link" | "create"; customer: { Id: string; DisplayName: string } | null }

function QuickBooksPanel() {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const [pick, setPick] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const st = useQuery({ queryKey: ["qb-status"], queryFn: () => api<QbStatus>("/api/accounting/quickbooks/status") });
  const [showPlan, setShowPlan] = useState(false);
  const plan = useQuery({ queryKey: ["qb-plan"], queryFn: () => api<{ rows: PlanRow[] }>("/api/accounting/quickbooks/customers/plan"), enabled: showPlan && Boolean(st.data?.connected) });
  const s = st.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["qb-status"] });
  const err = sp.get("error"), ok = sp.get("connected");
  const run = async (fn: () => Promise<string>) => { setMsg(null); try { setMsg({ ok: true, text: await fn() }); await refresh(); } catch (e) { setMsg({ ok: false, text: codeText(errMsg(e, "Error"), l) }); } };
  const todo = (plan.data?.rows ?? []).filter((r) => r.action !== "linked");
  const chosen = pick ?? todo.map((r) => r.clientId);
  if (!s) return null;
  return (
    <div className="mt-6 border-t border-white/10 pt-5 text-sm">
      {ok && <p role="status" className="mb-3 text-ok">{l("QuickBooks est connecté.", "QuickBooks is connected.")}</p>}
      {err && <p role="alert" className="mb-3 text-danger">{codeText(err, l)}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Chip tone={s.connected && !s.needsReauth ? "ok" : "off"}>● {s.connected ? (s.needsReauth ? l("Reconnexion requise", "Reconnect needed") : l("Connecté", "Connected")) : l("Non connecté", "Not connected")}</Chip>
        {s.connected && <span className="text-xs text-muted">{l("Entreprise", "Company")} {s.realmId} · {s.environment}{s.connectedAt ? ` · ${fmtDate(s.connectedAt, loc)}` : ""}</span>}
        <div className="flex-1" />
        {s.configured && <button className="btn btn-primary" onClick={() => void api<{ url: string }>("/api/accounting/quickbooks/connect").then((r) => { window.location.href = r.url; }).catch((e) => setMsg({ ok: false, text: codeText(errMsg(e, "Error"), l) }))}><Link2 size={15} />{s.connected ? l("Reconnecter", "Reconnect") : l("Connecter à QuickBooks", "Connect to QuickBooks")}</button>}
        {s.connected && <button className="btn btn-danger" onClick={() => { if (window.confirm(l("Déconnecter QuickBooks ? Les liens clients/factures sont conservés.", "Disconnect QuickBooks? Client and invoice links are kept."))) void run(async () => { await api("/api/accounting/quickbooks/disconnect", { body: {} }); setSp({}, { replace: true }); return l("Déconnecté.", "Disconnected."); }); }}><Unplug size={15} />{l("Déconnecter", "Disconnect")}</button>}
      </div>
      {!s.configured && <p className="mb-3 text-xs text-muted">{l("Enregistrez l'ID client et le secret de votre application Intuit, puis activez l'intégration.", "Save your Intuit app's client ID and secret, then enable the integration.")}</p>}
      <RedirectHint uri={s.redirectUri} />
      {s.connected && !s.needsReauth && (
        <div className="mt-5 space-y-5">
          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2"><h3 className="font-semibold">{l("Clients et clients QuickBooks", "Clients and QuickBooks customers")}</h3><span className="text-xs text-muted">{s.linkedClients} / {s.clients} {l("liés", "linked")}</span><div className="flex-1" /><button className="btn" onClick={() => { setShowPlan(true); void plan.refetch(); }}>{l("Vérifier les correspondances", "Review the matches")}</button></div>
            {showPlan && plan.data && (
              <div className="glass-flat p-2">
                {!todo.length ? <p className="p-2 text-xs text-muted">{l("Tous les clients sont liés.", "Every client is linked.")}</p> : (
                  <>
                    <table className="grid"><tbody>{todo.map((r) => (
                      <tr key={r.clientId}><td className="w-8"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={chosen.includes(r.clientId)} onChange={(e) => setPick(e.target.checked ? [...chosen, r.clientId] : chosen.filter((x) => x !== r.clientId))} /></td><td className="font-medium">{r.name}</td>
                        <td>{r.action === "link" ? <span className="text-ok">{l("Lier à", "Link to")} « {r.customer?.DisplayName} »</span> : <span className="text-warn">{l("Créer dans QuickBooks", "Create in QuickBooks")}</span>}</td></tr>))}</tbody></table>
                    <div className="flex justify-end p-2"><button className="btn btn-primary" disabled={!chosen.length} onClick={() => void run(async () => { const r = await api<{ linked: number; created: number; errors: { name: string; error: string }[] }>("/api/accounting/quickbooks/customers/sync", { body: { clientIds: chosen } }); setPick(null); await plan.refetch(); return l(`${r.linked} lié(s), ${r.created} créé(s)${r.errors.length ? `, ${r.errors.length} erreur(s)` : ""}.`, `${r.linked} linked, ${r.created} created${r.errors.length ? `, ${r.errors.length} error(s)` : ""}.`); })}>{l("Appliquer", "Apply")} ({chosen.length})</button></div>
                  </>)}
              </div>)}
          </section>
          <section>
            <h3 className="mb-2 font-semibold">{l("Paiements", "Payments")}</h3>
            <p className="mb-2 text-xs text-muted">{l("Un paiement saisi dans QuickBooks sur une facture envoyée d'ici est repris ici. Les factures s'envoient à QuickBooks depuis la facture (une seconde fois = mise à jour, jamais en double).", "A payment entered in QuickBooks on an invoice sent from here is brought back here. Invoices go to QuickBooks from the invoice (a second time = an update, never doubled).")}</p>
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn" onClick={() => void run(async () => { const r = await api<{ checked: number; recorded: number; amount: number }>("/api/accounting/quickbooks/payments/pull", { body: {} }); return l(`${r.checked} facture(s) vérifiée(s), ${r.recorded} paiement(s) repris.`, `${r.checked} invoice(s) checked, ${r.recorded} payment(s) brought back.`); })}><RefreshCw size={14} />{l("Reprendre les paiements maintenant", "Pull payments now")}</button>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={s.autoSync} onChange={(e) => void run(async () => { await api("/api/accounting/quickbooks/settings", { method: "PUT", body: { autoSync: e.target.checked } }); return l("Réglage enregistré.", "Setting saved."); })} />{l("Automatiquement toutes les 15 minutes", "Automatically every 15 minutes")}</label>
              {s.lastPull && <span className="text-xs text-muted">{l("Dernière reprise", "Last pull")}: {new Date(s.lastPull).toLocaleString(loc)}</span>}
            </div>
          </section>
        </div>)}
      {msg && <p role="status" className="mt-3 text-sm" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</p>}
    </div>
  );
}
