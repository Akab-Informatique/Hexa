import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useL } from "../lib/l";
import { errMsg } from "../components/kit";
import { Field, PageHeader } from "../components/ui";

interface Me { client: { name: string; email: string; phone: string; address: string; city: string; province: string; postalCode: string } }

/** My account: who I am, my company's details (read-only), and my password. */
export default function ClientSettings() {
  const l = useL();
  const { me } = useAuth();
  const info = useQuery({ queryKey: ["portal-me"], queryFn: () => api<Me>("/api/portal/me") });
  const [cur, setCur] = useState(""), [next, setNext] = useState(""), [again, setAgain] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const c = info.data?.client;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 12) return setMsg({ ok: false, text: l("Au moins 12 caractères.", "At least 12 characters.") });
    if (next !== again) return setMsg({ ok: false, text: l("Les mots de passe ne correspondent pas.", "The passwords do not match.") });
    try { await api("/api/auth/password", { body: { current: cur, next } }); setCur(""); setNext(""); setAgain(""); setMsg({ ok: true, text: l("Mot de passe modifié.", "Password changed.") }); }
    catch (err) { setMsg({ ok: false, text: errMsg(err, "Error") }); }
  };
  return (
    <>
      <PageHeader title={l("Mon compte", "My account")} />
      <div className="grid gap-4 md:grid-cols-2">
        <section className="glass p-5">
          <h2 className="mb-3 font-semibold">{l("Mes informations", "My details")}</h2>
          <dl className="space-y-2 text-sm"><div><dt className="text-xs text-muted">{l("Nom", "Name")}</dt><dd>{me.user?.name}</dd></div><div><dt className="text-xs text-muted">{l("Courriel", "Email")}</dt><dd>{me.user?.email}</dd></div></dl>
          {c && <><h2 className="mb-3 mt-5 font-semibold">{l("Mon entreprise", "My company")}</h2>
            <dl className="space-y-2 text-sm"><div><dt className="text-xs text-muted">{l("Entreprise", "Company")}</dt><dd>{c.name}</dd></div><div><dt className="text-xs text-muted">{l("Adresse", "Address")}</dt><dd>{[c.address, c.city, c.province, c.postalCode].filter(Boolean).join(", ") || "—"}</dd></div><div><dt className="text-xs text-muted">{l("Téléphone", "Phone")}</dt><dd>{c.phone || "—"}</dd></div></dl>
            <p className="mt-3 text-xs text-muted">{l("Pour modifier ces informations, contactez-nous.", "To change these details, contact us.")}</p></>}
        </section>
        <form className="glass p-5" onSubmit={(e) => void save(e)}>
          <h2 className="mb-3 font-semibold">{l("Changer mon mot de passe", "Change my password")}</h2>
          <Field label={l("Mot de passe actuel", "Current password")}><input className="input" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label={l("Nouveau mot de passe", "New password")}><input className="input" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <Field label={l("Confirmer", "Confirm")}><input className="input" type="password" autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
          {msg && <p role="status" className="mb-3 text-sm" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</p>}
          <button className="btn btn-primary">{l("Enregistrer", "Save")}</button>
        </form>
      </div>
    </>
  );
}
