import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useL } from "../lib/l";
import { useBranding } from "../lib/theme";
import { BrandMark, Field, LanguageToggle } from "../components/ui";

/** Opened from the welcome email: choose a password with a one-time link, then go sign in. */
export default function SetPassword() {
  const l = useL();
  const brand = useBranding();
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const [pw, setPw] = useState(""), [again, setAgain] = useState("");
  const [state, setState] = useState<"form" | "done">("form");
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 12) return setError(l("Au moins 12 caractères.", "At least 12 characters."));
    if (pw !== again) return setError(l("Les mots de passe ne correspondent pas.", "The passwords do not match."));
    setError("");
    try { await api("/api/auth/set-password", { body: { token, password: pw } }); setState("done"); }
    catch (err) { setError(err instanceof ApiError && err.status === 410 ? l("Ce lien est invalide ou a expiré. Demandez-en un nouveau à votre contact.", "This link is invalid or has expired. Ask your contact for a new one.") : l("Impossible d'enregistrer le mot de passe.", "Could not save the password.")); }
  };
  return (
    <div className="relative grid min-h-full place-items-center p-4">
      <div className="canvas" />
      <div className="absolute right-4 top-4 z-10"><LanguageToggle /></div>
      <div className="glass relative z-10 w-full max-w-md p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center"><BrandMark name={brand.appName} logoUrl={brand.logoUrl} size={52} /><div className="text-xl font-semibold tracking-tight">{brand.appName}</div></div>
        {state === "done" ? (
          <div className="text-center"><p className="mb-4 text-sm">{l("Mot de passe enregistré. Vous pouvez maintenant vous connecter.", "Password saved. You can now sign in.")}</p><a className="btn btn-primary" href="/">{l("Me connecter", "Sign in")}</a></div>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h1 className="mb-1 text-lg font-semibold">{l("Choisissez votre mot de passe", "Choose your password")}</h1>
            <p className="mb-5 text-sm text-muted">{l("Au moins 12 caractères.", "At least 12 characters.")}</p>
            <Field label={l("Nouveau mot de passe", "New password")}><input className="input" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <Field label={l("Confirmer", "Confirm")}><input className="input" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
            {error && <p role="alert" className="mb-3 text-sm" style={{ color: "var(--danger)" }}>{error}</p>}
            <button className="btn btn-primary w-full" disabled={!token}>{l("Enregistrer", "Save")}</button>
          </form>)}
      </div>
    </div>
  );
}
