import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useL } from "../../lib/l";
import { errMsg } from "../../components/kit";
import { Modal } from "../../components/ui";
import { codeText } from "../../admin/IntegrationPanels";

interface Settings { enabled: boolean; from: string | null; levels: number[]; lang: "fr" | "en"; lastRun: string | null }

/** Automatic reminders: one per invoice and level, on weekdays after 8:30, for invoices dated from a chosen day. Off until switched on. */
export function RemindersDialog({ onClose }: { onClose: () => void }) {
  const l = useL();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["reminder-settings"], queryFn: () => api<Settings>("/api/accounting/reminders/settings") });
  const [v, setV] = useState<{ enabled: boolean; from: string; levels: string; lang: "fr" | "en" } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const s = q.data;
  if (!s) return null;
  const f = v ?? { enabled: s.enabled, from: s.from ?? "", levels: s.levels.join(", "), lang: s.lang };
  const levels = f.levels.split(/[ ,;]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const save = async () => {
    setMsg(null);
    try { await api("/api/accounting/reminders/settings", { method: "PUT", body: { enabled: f.enabled, from: f.from || null, levels, lang: f.lang } }); await qc.invalidateQueries({ queryKey: ["reminder-settings"] }); setV(null); setMsg({ ok: true, text: l("Enregistré.", "Saved.") }); }
    catch (e) { setMsg({ ok: false, text: codeText(errMsg(e, "Error"), l) }); }
  };
  const run = async () => {
    setMsg(null);
    try { const r = await api<{ sent: number; skipped: number }>("/api/accounting/reminders/run", { body: {} }); setMsg({ ok: true, text: l(`${r.sent} rappel(s) envoyé(s), ${r.skipped} ignoré(s).`, `${r.sent} reminder(s) sent, ${r.skipped} skipped.`) }); }
    catch (e) { setMsg({ ok: false, text: codeText(errMsg(e, "Error"), l) }); }
  };
  return (
    <Modal title={l("Rappels automatiques", "Automatic reminders")} onClose={onClose}>
      <p className="mb-4 text-sm text-muted">{l("Quand une facture envoyée est en retard, un courriel de rappel part au courriel de facturation du client, une fois par niveau (jamais un niveau plus bas après un plus haut). En semaine, après 8 h 30, une fois par jour. Un client sans courriel est ignoré.", "When a sent invoice is late, a reminder goes to the client's billing email, once per level (never a lower level after a higher one). On weekdays after 8:30, once a day. A client with no email is skipped.")}</p>
      <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={f.enabled} onChange={(e) => setV({ ...f, enabled: e.target.checked })} />{l("Envoyer automatiquement", "Send automatically")}</label>
      <label className="mb-4 block"><span className="label">{l("Jours de retard des niveaux", "Days late of each level")}</span><input className="input" value={f.levels} onChange={(e) => setV({ ...f, levels: e.target.value })} placeholder="5, 15, 30, 60, 90" /></label>
      <label className="mb-4 block"><span className="label">{l("Seulement les factures datées à partir du (option)", "Only invoices dated from (optional)")}</span><input className="input" type="date" value={f.from} onChange={(e) => setV({ ...f, from: e.target.value })} /></label>
      <label className="mb-4 block"><span className="label">{l("Langue", "Language")}</span><select className="input" value={f.lang} onChange={(e) => setV({ ...f, lang: e.target.value as "fr" | "en" })}><option value="fr">Français</option><option value="en">English</option></select></label>
      {msg && <p role="status" className="mb-3 text-sm" style={{ color: msg.ok ? "var(--ok)" : "var(--danger)" }}>{msg.text}</p>}
      <div className="flex flex-wrap justify-between gap-2"><button className="btn" onClick={() => void run()}>{l("Envoyer maintenant ce qui est dû", "Send what is due now")}</button><div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button><button className="btn btn-primary" disabled={!levels.length} onClick={() => void save()}>{l("Enregistrer", "Save")}</button></div></div>
    </Modal>
  );
}
