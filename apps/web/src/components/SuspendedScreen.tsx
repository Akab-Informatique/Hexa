import { useTranslation } from "react-i18next";
import { useBranding } from "../lib/theme";
import { useLicense } from "../lib/license";
import { useL } from "../lib/l";
import { BrandMark, LanguageToggle } from "./ui";

/** Shown instead of the whole app when the license is not usable (suspended, expired, console lost). */
export default function SuspendedScreen() {
  const { t } = useTranslation();
  const l = useL();
  const brand = useBranding();
  const { reason } = useLicense();
  const expired = reason === "expired";
  // Not a suspension: the portal could not confirm its license (first start, or the provider unreachable for days).
  const unverified = reason === "not_verified" || reason === "unreachable";
  return (
    <div className="relative grid min-h-full place-items-center p-4">
      <div className="canvas" />
      <div className="absolute right-4 top-4 z-10"><LanguageToggle /></div>
      <div role="alert" className="glass relative z-10 w-full max-w-md p-8 text-center">
        <div className="mb-6 flex flex-col items-center gap-3">
          <BrandMark name={brand.appName} logoUrl={brand.logoUrl} size={52} />
          <div className="text-xl font-semibold tracking-tight">{brand.appName}</div>
        </div>
        <h1 className="mb-2 text-lg font-semibold">{unverified ? l("Vérification en cours", "Verification in progress") : l("Service suspendu", "Service suspended")}</h1>
        <p className="mb-3 text-sm text-muted">
          {unverified ? l("Le portail ne peut pas confirmer sa licence pour le moment. Réessayez dans quelques minutes. Vos données sont conservées.", "The portal cannot confirm its license right now. Try again in a few minutes. Your data is kept safe.") : l(
            "L'accès à ce portail est suspendu temporairement. Vos données sont conservées.",
            "Access to this portal is temporarily paused. Your data is kept safe.",
          )}
        </p>
        {expired && (
          <p className="mb-3 text-sm text-muted">
            {l("Le contrat de service a pris fin.", "The service agreement has ended.")}
          </p>
        )}
        <p className="mb-5 text-sm text-muted">
          {l("Contactez votre fournisseur pour rétablir l'accès.", "Contact your provider to restore access.")}
        </p>
        {brand.supportEmail ? (
          <a className="btn btn-primary w-full" href={`mailto:${brand.supportEmail}`}>
            {brand.supportEmail}
          </a>
        ) : null}
        <div className="mt-6 text-xs text-muted">{t("common.poweredBy")}</div>
      </div>
    </div>
  );
}
