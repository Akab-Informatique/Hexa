import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil, Plus, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, Empty, FormFields, confirmDo, errMsg, useClients, type FieldDef } from "../../components/kit";
import { Modal } from "../../components/ui";

interface Rule {
  id: string; name: string; enabled: boolean; titleTemplate: string; descriptionTemplate: string; bullets: string[];
  cadence: "weekly" | "monthly" | "quarterly" | "yearly"; weekday: number | null; dayOfMonth: number | null; month: number | null;
  dueAfterDays: number | null; dueDayOfMonth: number | null; scope: "all" | "class" | "clients"; scopeClassKey: string | null; clientIds: string[];
  assigneeMode: "resource" | "user" | "none"; assigneeUserId: string | null;
}
interface Data { rules: Rule[]; classes: { key: string; labelFr: string; labelEn: string }[] }
interface Preview { count: number; next: string | null; tasks: { clientId: string; clientName: string; title: string; start: string; due: string; bullets: string[] }[] }

const MONTHS: [string, string][] = [["janvier", "January"], ["février", "February"], ["mars", "March"], ["avril", "April"], ["mai", "May"], ["juin", "June"], ["juillet", "July"], ["août", "August"], ["septembre", "September"], ["octobre", "October"], ["novembre", "November"], ["décembre", "December"]];
const DAYS: [string, string][] = [["lundi", "Monday"], ["mardi", "Tuesday"], ["mercredi", "Wednesday"], ["jeudi", "Thursday"], ["vendredi", "Friday"], ["samedi", "Saturday"], ["dimanche", "Sunday"]];
const dayOpts = [...Array.from({ length: 30 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), { value: "31", label: ["Dernier jour du mois", "Last day of the month"] as [string, string] }];

const blank = { name: "", titleTemplate: "{client} — ", descriptionTemplate: "", cadence: "monthly", weekday: "1", dayOfMonth: "1", month: "1", dueMode: "none", dueValue: "7",
  scope: "all", scopeClassKey: "", assigneeMode: "resource", assigneeUserId: "" };

function toForm(r: Rule): Record<string, unknown> {
  return { name: r.name, titleTemplate: r.titleTemplate, descriptionTemplate: r.descriptionTemplate, cadence: r.cadence, weekday: String(r.weekday ?? 1), dayOfMonth: String(r.dayOfMonth ?? 1), month: String(r.month ?? 1),
    dueMode: r.dueAfterDays != null ? "after" : r.dueDayOfMonth != null ? "day" : "none", dueValue: String(r.dueAfterDays ?? r.dueDayOfMonth ?? 7),
    scope: r.scope, scopeClassKey: r.scopeClassKey ?? "", assigneeMode: r.assigneeMode, assigneeUserId: r.assigneeUserId ?? "" };
}
function toPayload(v: Record<string, unknown>, bullets: string[], clientIds: string[], enabled: boolean) {
  const n = (k: string) => Number(v[k]);
  const due = v.dueMode as string;
  return {
    name: String(v.name).trim(), enabled, titleTemplate: String(v.titleTemplate).trim(), descriptionTemplate: String(v.descriptionTemplate ?? ""),
    bullets: bullets.map((b) => b.trim()).filter(Boolean), cadence: v.cadence,
    weekday: v.cadence === "weekly" ? n("weekday") : null, dayOfMonth: v.cadence === "weekly" ? null : n("dayOfMonth"),
    month: v.cadence === "yearly" || v.cadence === "quarterly" ? n("month") : null,
    dueAfterDays: due === "after" ? n("dueValue") : null, dueDayOfMonth: due === "day" ? n("dueValue") : null,
    scope: v.scope, scopeClassKey: v.scope === "class" ? String(v.scopeClassKey) : null, clientIds: v.scope === "clients" ? clientIds : [],
    assigneeMode: v.assigneeMode, assigneeUserId: v.assigneeMode === "user" ? String(v.assigneeUserId) : null,
  };
}

/** Lists the firm's own recurring automatic tasks and lets people with the permission create, edit, preview, switch and delete them. */
export default function AutoTaskRules({ onClose }: { onClose: () => void }) {
  const l = useL();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Rule | "new" | null>(null);
  const [err, setErr] = useState("");
  const q = useQuery({ queryKey: ["auto-task-rules"], queryFn: () => api<Data>("/api/auto-task-rules") });
  const reload = async () => { await qc.invalidateQueries({ queryKey: ["auto-task-rules"] }); void qc.invalidateQueries({ queryKey: ["tasks"] }); };
  const act = async (fn: () => Promise<unknown>) => { setErr(""); try { await fn(); await reload(); } catch (e) { setErr(errMsg(e, l("Une erreur est survenue", "Something went wrong"))); } };
  const cadenceLabel = (r: Rule) => r.cadence === "weekly" ? l(`Chaque semaine, le ${DAYS[(r.weekday ?? 1) - 1]![0]}`, `Weekly, on ${DAYS[(r.weekday ?? 1) - 1]![1]}`)
    : r.cadence === "monthly" ? l(`Chaque mois, le ${r.dayOfMonth === 31 ? "dernier jour" : r.dayOfMonth}`, `Monthly, on ${r.dayOfMonth === 31 ? "the last day" : "day " + r.dayOfMonth}`)
    : r.cadence === "quarterly" ? l(`Chaque trimestre (mois ${r.month ?? 1}, jour ${r.dayOfMonth === 31 ? "dernier" : r.dayOfMonth})`, `Quarterly (month ${r.month ?? 1}, day ${r.dayOfMonth === 31 ? "last" : r.dayOfMonth})`)
    : l(`Chaque année, ${r.dayOfMonth === 31 ? "dernier jour de " : "le " + r.dayOfMonth + " "}${MONTHS[(r.month ?? 1) - 1]![0]}`, `Yearly, ${MONTHS[(r.month ?? 1) - 1]![1]} ${r.dayOfMonth === 31 ? "(last day)" : r.dayOfMonth}`);
  const scopeLabel = (r: Rule) => r.scope === "all" ? l("Tous les clients actifs", "All active clients") : r.scope === "class" ? l(`Classe : ${q.data?.classes.find((k) => k.key === r.scopeClassKey)?.labelFr ?? r.scopeClassKey}`, `Class: ${q.data?.classes.find((k) => k.key === r.scopeClassKey)?.labelEn ?? r.scopeClassKey}`) : l(`${r.clientIds.length} client(s)`, `${r.clientIds.length} client(s)`);

  return (
    <Modal title={l("Tâches automatiques", "Automatic tasks")} onClose={onClose} wide>
      <p className="mb-3 text-sm text-muted">{l("Créez vos propres tâches récurrentes : elles sont ajoutées toutes seules, une fois par période, pour chaque client visé.", "Create your own recurring tasks: they are added automatically, once per period, for each client concerned.")}</p>
      <div className="mb-3 flex justify-end"><button className="btn btn-primary" onClick={() => setEdit("new")}><Plus size={16} />{l("Nouvelle règle", "New rule")}</button></div>
      {err && <p role="alert" className="mb-3 text-sm text-danger">{err}</p>}
      {q.data?.rules.length === 0 ? <Empty>{l("Aucune règle.", "No rules.")}</Empty> : (
        <ul className="space-y-2">
          {q.data?.rules.map((r) => (
            <li key={r.id} className="glass-flat flex items-center gap-3 p-3">
              <label className="flex items-center" title={l("Activée", "Enabled")}><input type="checkbox" role="switch" className="h-4 w-4 accent-[var(--brand)]" checked={r.enabled} onChange={(e) => void act(() => api(`/api/auto-task-rules/${r.id}`, { method: "PATCH", body: { enabled: e.target.checked } }))} aria-label={l("Activée", "Enabled")} /></label>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.name} {!r.enabled && <Chip tone="off">{l("Désactivée", "Off")}</Chip>}</div>
                <div className="truncate text-xs text-muted">{cadenceLabel(r)} · {scopeLabel(r)}</div>
              </div>
              <button className="btn !p-1.5" aria-label={l("Modifier", "Edit")} onClick={() => setEdit(r)}><Pencil size={14} /></button>
              <button className="btn btn-danger !p-1.5" aria-label={l("Supprimer", "Delete")} onClick={() => confirmDo(l("Supprimer cette règle ? Les tâches déjà créées sont conservées.", "Delete this rule? Tasks already created are kept."), () => void act(() => api(`/api/auto-task-rules/${r.id}`, { method: "DELETE" })))}><Trash2 size={14} /></button>
            </li>))}
        </ul>
      )}
      {edit && q.data && <RuleDialog rule={edit === "new" ? null : edit} classes={q.data.classes} onClose={() => setEdit(null)} onSaved={reload} />}
    </Modal>
  );
}

function RuleDialog({ rule, classes, onClose, onSaved }: { rule: Rule | null; classes: Data["classes"]; onClose: () => void; onSaved: () => Promise<void> }) {
  const l = useL();
  const loc = useLocale();
  const clients = useClients();
  const [v, setV] = useState<Record<string, unknown>>(rule ? toForm(rule) : blank);
  const [bullets, setBullets] = useState<string[]>(rule?.bullets ?? []);
  const [clientIds, setClientIds] = useState<string[]>(rule?.clientIds ?? []);
  const [find, setFind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);

  const cad = v.cadence as string;
  const fields: FieldDef[] = [
    { name: "name", label: ["Nom de la règle", "Rule name"], required: true, span: 2 },
    { name: "titleTemplate", label: ["Titre de la tâche", "Task title"], required: true, span: 2, hint: ["Mots remplacés : {client}  {period}  {month}  {year}", "Replaced words: {client}  {period}  {month}  {year}"] },
    { name: "descriptionTemplate", label: ["Description", "Description"], type: "textarea", span: 2, rows: 3, hint: ["Mêmes mots que le titre.", "Same words as the title."] },
    { name: "s1", label: ["Fréquence", "Frequency"], type: "section" },
    { name: "cadence", label: ["Répéter", "Repeat"], type: "select", required: true, options: [{ value: "weekly", label: ["Chaque semaine", "Weekly"] }, { value: "monthly", label: ["Chaque mois", "Monthly"] }, { value: "quarterly", label: ["Chaque trimestre", "Quarterly"] }, { value: "yearly", label: ["Chaque année", "Yearly"] }] },
    ...(cad === "weekly" ? [{ name: "weekday", label: ["Jour de la semaine", "Weekday"] as [string, string], type: "select" as const, required: true, options: DAYS.map((d, i) => ({ value: String(i + 1), label: d })) }] : []),
    ...(cad === "yearly" ? [{ name: "month", label: ["Mois", "Month"] as [string, string], type: "select" as const, required: true, options: MONTHS.map((m, i) => ({ value: String(i + 1), label: m })) }] : []),
    ...(cad === "quarterly" ? [{ name: "month", label: ["Mois du trimestre", "Month of the quarter"] as [string, string], type: "select" as const, required: true, options: [{ value: "1", label: ["1er mois (janv., avr., juill., oct.)", "1st month (Jan, Apr, Jul, Oct)"] as [string, string] }, { value: "2", label: ["2e mois", "2nd month"] as [string, string] }, { value: "3", label: ["3e mois", "3rd month"] as [string, string] }] }] : []),
    ...(cad !== "weekly" ? [{ name: "dayOfMonth", label: ["Jour du mois", "Day of the month"] as [string, string], type: "select" as const, required: true, options: dayOpts }] : []),
    { name: "dueMode", label: ["Échéance", "Due date"], type: "select", required: true, options: [{ value: "none", label: ["Le jour même", "Same day"] }, { value: "after", label: ["Quelques jours après le début", "Some days after the start"] }, { value: "day", label: ["Un jour précis du mois", "A given day of the month"] }] },
    ...(v.dueMode === "after" ? [{ name: "dueValue", label: ["Nombre de jours", "Number of days"] as [string, string], type: "number" as const, required: true }] : []),
    ...(v.dueMode === "day" ? [{ name: "dueValue", label: ["Jour du mois", "Day of the month"] as [string, string], type: "select" as const, required: true, options: dayOpts }] : []),
    { name: "s2", label: ["Pour qui", "Who for"], type: "section" },
    { name: "scope", label: ["Clients visés", "Clients"], type: "select", required: true, options: [{ value: "all", label: ["Tous les clients actifs", "All active clients"] }, { value: "class", label: ["Une classe de clients", "A client class"] }, { value: "clients", label: ["Clients choisis", "Selected clients"] }] },
    ...(v.scope === "class" ? [{ name: "scopeClassKey", label: ["Classe", "Class"] as [string, string], type: "select" as const, required: true, options: classes.map((k) => ({ value: k.key, label: [k.labelFr, k.labelEn] as [string, string] })) }] : []),
    { name: "assigneeMode", label: ["Assignée à", "Assigned to"], type: "select", required: true, options: [{ value: "resource", label: ["La ressource du client", "The client's resource"] }, { value: "user", label: ["Une personne précise", "A specific person"] }, { value: "none", label: ["Personne", "Nobody"] }] },
    ...(v.assigneeMode === "user" ? [{ name: "assigneeUserId", label: ["Personne", "Person"] as [string, string], type: "user" as const, required: true }] : []),
  ];

  const shown = useMemo(() => (clients.data ?? []).filter((c) => c.status === "active" && c.name.toLowerCase().includes(find.trim().toLowerCase())).slice(0, 200), [clients.data, find]);
  const payload = () => toPayload(v, bullets, clientIds, rule?.enabled ?? true);
  const guard = () => v.scope === "clients" && !clientIds.length ? l("Choisissez au moins un client.", "Pick at least one client.") : "";

  const showPreview = async () => {
    const g = guard(); if (g) { setError(g); return; }
    setError(""); setBusy(true);
    try { setPreview(await api<Preview>("/api/auto-task-rules/preview", { method: "POST", body: { ...payload(), ...(rule ? { id: rule.id } : {}) } })); }
    catch (e) { setError(errMsg(e, l("Une erreur est survenue", "Something went wrong"))); } finally { setBusy(false); }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const g = guard(); if (g) { setError(g); return; }
    setError(""); setBusy(true);
    try {
      await api(rule ? `/api/auto-task-rules/${rule.id}` : "/api/auto-task-rules", { method: rule ? "PATCH" : "POST", body: payload() });
      await onSaved(); onClose();
    } catch (err) { setError(errMsg(err, l("Une erreur est survenue", "Something went wrong"))); setBusy(false); }
  };

  return (
    <Modal title={rule ? l("Modifier la règle", "Edit rule") : l("Nouvelle règle", "New rule")} onClose={onClose} wide>
      <form onSubmit={save}>
        <FormFields fields={fields} values={v} onChange={(x) => { setV(x); setPreview(null); }} />
        {v.scope === "clients" && (
          <div className="mb-4">
            <span className="label">{l("Clients", "Clients")} ({clientIds.length})</span>
            <input className="input mb-2" placeholder={l("Rechercher…", "Search…")} value={find} onChange={(e) => setFind(e.target.value)} />
            <div className="glass-flat max-h-40 overflow-auto p-2">
              {shown.map((c) => <label key={c.id} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={clientIds.includes(c.id)} onChange={(e) => setClientIds(e.target.checked ? [...clientIds, c.id] : clientIds.filter((x) => x !== c.id))} />{c.name}</label>)}
            </div>
          </div>
        )}
        <div className="mb-4">
          <span className="label">{l("Points à cocher", "Checklist bullets")} ({bullets.length}/50)</span>
          {bullets.map((b, i) => (
            <div key={i} className="mb-1 flex gap-2">
              <input className="input" maxLength={300} value={b} onChange={(e) => setBullets(bullets.map((x, j) => (j === i ? e.target.value : x)))} />
              <button type="button" className="btn !p-1.5" aria-label={l("Retirer", "Remove")} onClick={() => setBullets(bullets.filter((_, j) => j !== i))}><X size={14} /></button>
            </div>))}
          {bullets.length < 50 && <button type="button" className="btn" onClick={() => setBullets([...bullets, ""])}><Plus size={14} />{l("Ajouter un point", "Add a bullet")}</button>}
        </div>
        {preview && (
          <div className="glass-flat mb-4 p-3 text-sm">
            {preview.count === 0 ? <p className="text-muted">{l("Rien à créer pour le moment.", "Nothing to create right now.")}{preview.next && ` ${l("Prochaine création le", "Next one on")} ${fmtDate(preview.next, loc)}.`}</p> : (
              <>
                <p className="mb-1 font-medium">{l(`${preview.count} tâche(s) seraient créées maintenant`, `${preview.count} task(s) would be created now`)}</p>
                <ul className="max-h-40 space-y-0.5 overflow-auto text-xs text-muted">{preview.tasks.map((t) => <li key={t.clientId}>{t.title} · {fmtDate(t.start, loc)} → {fmtDate(t.due, loc)}</li>)}</ul>
              </>)}
          </div>
        )}
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={busy} onClick={() => void showPreview()}><Eye size={14} />{l("Prévisualiser", "Preview")}</button>
          <button type="button" className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button>
          <button className="btn btn-primary" disabled={busy}>{l("Enregistrer", "Save")}</button>
        </div>
      </form>
    </Modal>
  );
}
