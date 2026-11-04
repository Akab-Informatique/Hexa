import { Link } from "react-router-dom";
import { CalendarDays, Inbox, Plug } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { useL } from "../../lib/l";
import { useIntegrations } from "../../components/kit";
import { PageHeader } from "../../components/ui";

/**
 * Calendar and inbox come from each person's own Microsoft 365 account through the firm's Azure app.
 * Until the administrator has saved the app credentials (Administration > Integrations) these pages
 * explain what is missing. The mailbox and calendar sync itself is the next integration step.
 */
export default function ConnectPage({ kind }: { kind: "calendar" | "mail" }) {
  const l = useL();
  const { can } = useAuth();
  const st = useIntegrations();
  const o365 = st.data?.o365;
  const title = kind === "calendar" ? l("Calendrier Microsoft 365", "Microsoft 365 calendar") : l("Boîte de réception Outlook", "Outlook inbox");
  const Icon = kind === "calendar" ? CalendarDays : Inbox;
  return (
    <>
      <PageHeader title={title} />
      <div className="glass grid place-items-center gap-3 p-12 text-center">
        <Icon size={36} className="text-brand" />
        {!o365?.configured ? (
          <>
            <h2 className="text-lg font-semibold">{l("Microsoft 365 n'est pas encore configuré", "Microsoft 365 is not configured yet")}</h2>
            <p className="max-w-lg text-sm text-muted">{l("Un administrateur doit d'abord enregistrer l'application Azure du cabinet (ID de l'annuaire, ID client et secret).", "An administrator must first save the firm's Azure application (tenant ID, client ID and secret).")}</p>
            {can("admin.integrations.view") && <Link to="/admin/integrations/o365" className="btn btn-primary no-underline"><Plug size={15} />{l("Configurer Microsoft 365", "Configure Microsoft 365")}</Link>}
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">{l("Application Microsoft 365 configurée", "Microsoft 365 application configured")}</h2>
            <p className="max-w-lg text-sm text-muted">{l("La connexion personnelle à votre compte et l'affichage de votre calendrier et de votre boîte de réception sont la prochaine étape de l'intégration.", "Connecting your personal account and showing your calendar and inbox is the next integration step.")}</p>
          </>
        )}
      </div>
    </>
  );
}
