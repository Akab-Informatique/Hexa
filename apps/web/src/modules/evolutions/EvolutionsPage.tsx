import { useRef, useState, type ClipboardEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Circle, Eye, ImagePlus, List, ListOrdered, MessageSquare, Pencil, Plus, Trash2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { confirmDo, Empty, errMsg, Tabs } from "../../components/kit";
import { Modal } from "../../components/ui";
import { imageProblem, inTab, MAX_IMAGES, nextStatus, parseDetails, prefixLines, priorityTone, sortEvolutions, tabCounts, TONE_COLOR, type EvoStatus, type EvoTab } from "./logic";

interface Evo { id: string; title: string; details: string; priority: number; status: EvoStatus; sopId: string | null; sopTitle: string | null; createdAt: string; createdByName: string | null; commentCount: number; images: { id: string; name: string }[] }
interface Comment { id: string; body: string; createdAt: string; userId: string | null; userName: string | null }
interface NewImage { name: string; type: string; data: string; preview: string }

const b64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(new Error("read")); r.readAsDataURL(f); });
const imgUrl = (id: string) => `/api/evolutions/images/${id}`;

export function PriorityBadge({ p }: { p: number }) {
  return <span className="inline-grid h-7 min-w-7 shrink-0 place-items-center rounded-full px-1.5 text-xs font-bold text-white" style={{ background: TONE_COLOR[priorityTone(p)] }} title={`Priorité ${p}`}>{p}</span>;
}

function PrioritySelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const l = useL();
  return (
    <div>
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label={l("Priorité", "Priority")}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} onClick={() => onChange(n)} className="h-8 w-8 rounded-lg text-sm font-semibold transition"
            style={value === n ? { background: TONE_COLOR[priorityTone(n)], color: "#fff" } : { background: "rgb(255 255 255 / 0.08)", color: "var(--muted)" }}>{n}</button>
        ))}
      </div>
      <p className="mt-1 text-xs text-muted">{l("1 peut attendre · 4-6 bientôt · 7-8 important · 9-10 maintenant", "1 can wait · 4-6 soon · 7-8 important · 9-10 now")}</p>
    </div>
  );
}

/** Create and edit share this form. `existing` (edit mode) are images already saved; new ones are sent after save. */
function EvoForm({ initial, existing, onSubmit, submitLabel, busy, error, onRemoveExisting }: {
  initial?: { title: string; details: string; priority: number; sopId: string | null }; existing?: { id: string; name: string }[]; busy: boolean; error?: string;
  onSubmit: (v: { title: string; details: string; priority: number; sopId: string | null }, images: NewImage[]) => void; submitLabel: string; onRemoveExisting?: (id: string) => void;
}) {
  const l = useL();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [details, setDetails] = useState(initial?.details ?? "");
  const [priority, setPriority] = useState(initial?.priority ?? 5);
  const [sopId, setSopId] = useState(initial?.sopId ?? "");
  const [images, setImages] = useState<NewImage[]>([]);
  const [imgErr, setImgErr] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const sops = useQuery({ queryKey: ["evolution-sops"], queryFn: () => api<{ id: string; title: string }[]>("/api/evolutions/sops") });
  const room = MAX_IMAGES - images.length - (existing?.length ?? 0);

  async function addFiles(files: File[]) {
    setImgErr("");
    const next: NewImage[] = [];
    for (const f of files.slice(0, Math.max(0, room))) {
      const bad = imageProblem(f);
      if (bad) { setImgErr(bad === "type" ? l("Images seulement (PNG, JPEG, GIF, WebP).", "Images only (PNG, JPEG, GIF, WebP).") : l("Image trop grande (3 Mo max).", "Image too large (3 MB max).")); continue; }
      next.push({ name: f.name || "capture.png", type: f.type, data: await b64(f), preview: URL.createObjectURL(f) });
    }
    if (files.length > room) setImgErr(l(`${MAX_IMAGES} images maximum.`, `${MAX_IMAGES} images maximum.`));
    if (next.length) setImages((x) => [...x, ...next]);
  }
  const onPaste = (e: ClipboardEvent) => {
    const fs = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (fs.length) { e.preventDefault(); void addFiles(fs); }
  };
  function list(kind: "bullet" | "number") {
    const el = ta.current; if (!el) return;
    const r = prefixLines(details, el.selectionStart, el.selectionEnd, kind);
    setDetails(r.text);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(r.start, r.end); });
  }
  const drop = (i: number) => { URL.revokeObjectURL(images[i]!.preview); setImages(images.filter((_, j) => j !== i)); };

  return (
    <form onPaste={onPaste} onSubmit={(e) => { e.preventDefault(); if (title.trim()) onSubmit({ title: title.trim(), details, priority, sopId: sopId || null }, images); }} className="space-y-4">
      <label className="block text-sm font-medium">{l("Fonctionnalité ou changement", "Feature or change")}
        <input className="input mt-1" value={title} maxLength={300} required onChange={(e) => setTitle(e.target.value)} placeholder={l("p. ex. Envoyer le rapport hebdomadaire aux clients par courriel", "e.g. Email the weekly report to clients")} />
      </label>
      <div>
        <div className="mb-1 flex items-center justify-between text-sm font-medium">
          <label htmlFor="evo-details">{l("Détails (optionnel)", "Details (optional)")}</label>
          <span className="flex gap-1">
            <button type="button" className="btn !p-1.5" aria-label={l("Liste à puces", "Bullet list")} onClick={() => list("bullet")}><List size={14} /></button>
            <button type="button" className="btn !p-1.5" aria-label={l("Liste numérotée", "Numbered list")} onClick={() => list("number")}><ListOrdered size={14} /></button>
          </span>
        </div>
        <textarea id="evo-details" ref={ta} className="input" rows={4} maxLength={10000} value={details} onChange={(e) => setDetails(e.target.value)}
          placeholder={l("Tout ce qui aide : où cela s'applique, comment cela devrait fonctionner", "Anything that helps: where it applies, how it should work")} />
      </div>
      <div>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; void addFiles(fs); }} />
        <button type="button" className="btn" disabled={room <= 0} onClick={() => file.current?.click()}><ImagePlus size={15} /> {l("Ajouter des images", "Add images")}</button>
        <span className="ml-2 text-xs text-muted">{l("ou collez une capture d'écran (Ctrl+V)", "or paste a screenshot (Ctrl+V)")}</span>
        {imgErr && <p className="mt-1 text-xs text-danger">{imgErr}</p>}
        {(existing?.length || images.length) ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {existing?.map((x) => (
              <span key={x.id} className="relative">
                <img src={imgUrl(x.id)} alt={x.name} className="h-16 w-16 rounded-lg object-cover" />
                {onRemoveExisting && <button type="button" className="absolute -right-1.5 -top-1.5 rounded-full bg-black/70 p-0.5 text-white" aria-label={l("Retirer", "Remove")} onClick={() => onRemoveExisting(x.id)}><X size={12} /></button>}
              </span>))}
            {images.map((x, i) => (
              <span key={x.preview} className="relative">
                <img src={x.preview} alt={x.name} className="h-16 w-16 rounded-lg object-cover" />
                <button type="button" className="absolute -right-1.5 -top-1.5 rounded-full bg-black/70 p-0.5 text-white" aria-label={l("Retirer", "Remove")} onClick={() => drop(i)}><X size={12} /></button>
              </span>))}
          </div>
        ) : null}
      </div>
      <label className="block text-sm font-medium">{l("Lier une SOP…", "Link an SOP…")}
        <select className="input mt-1" value={sopId} onChange={(e) => setSopId(e.target.value)}>
          <option value="">{l("— Aucune —", "— None —")}</option>
          {sops.data?.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </label>
      <div><div className="mb-1 text-sm font-medium">{l("Priorité", "Priority")}</div><PrioritySelect value={priority} onChange={setPriority} /></div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn btn-primary" disabled={busy || !title.trim()}><Plus size={15} /> {submitLabel}</button>
    </form>
  );
}

const statusIcon = (s: EvoStatus) => (s === "done" ? <Check size={16} /> : s === "review" ? <Eye size={15} /> : <Circle size={16} />);

function Comments({ id, canEdit, meId }: { id: string; canEdit: boolean; meId?: string }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const q = useQuery({ queryKey: ["evolution-comments", id], queryFn: () => api<Comment[]>(`/api/evolutions/${id}/comments`) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["evolution-comments", id] }); void qc.invalidateQueries({ queryKey: ["evolutions"] }); };
  const add = useMutation({ mutationFn: () => api(`/api/evolutions/${id}/comments`, { body: { body: text.trim() } }), onSuccess: () => { setText(""); refresh(); } });
  return (
    <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
      {q.data?.map((c) => (
        <div key={c.id} className="text-sm">
          <span className="font-medium">{c.userName ?? "—"}</span> <span className="text-xs text-muted">{fmtDate(c.createdAt, loc)}</span>
          {canEdit && c.userId === meId && <button className="ml-2 text-muted hover:text-danger" aria-label={l("Supprimer", "Delete")} onClick={() => void api(`/api/evolutions/comments/${c.id}`, { method: "DELETE" }).then(refresh)}><Trash2 size={12} /></button>}
          <div className="whitespace-pre-wrap break-words">{c.body}</div>
        </div>))}
      {q.data && !q.data.length && <p className="text-xs text-muted">{l("Aucun commentaire.", "No comments.")}</p>}
      {canEdit && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) add.mutate(); }}>
          <input className="input" value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} placeholder={l("Ajouter un commentaire…", "Add a comment…")} />
          <button className="btn" disabled={add.isPending || !text.trim()}>{l("Envoyer", "Send")}</button>
        </form>)}
    </div>
  );
}

function Details({ text }: { text: string }) {
  const rows = parseDetails(text);
  return (
    <div className="mt-1 break-words text-sm text-muted">
      {rows.map((r, i) => r.kind === "blank" ? <div key={i} className="h-2" /> : r.kind === "text" ? <div key={i}>{r.text}</div> : (
        <div key={i} className="flex gap-1.5 pl-2"><span className="shrink-0">{r.kind === "bullet" ? "•" : `${r.n}.`}</span><span>{r.text}</span></div>))}
    </div>
  );
}

function Card({ e, canEdit, meId, onEdit }: { e: Evo; canEdit: boolean; meId?: string; onEdit: () => void }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["evolutions"] });
  const status = useMutation({ mutationFn: (s: EvoStatus) => api(`/api/evolutions/${e.id}/status`, { method: "PUT", body: { status: s } }), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => api(`/api/evolutions/${e.id}`, { method: "DELETE" }), onSuccess: refresh });
  const label = e.status === "todo" ? l("À faire", "To do") : e.status === "review" ? l("À valider", "To review") : l("Fait", "Done");
  return (
    <div className="glass p-4" style={{ opacity: e.status === "done" ? 0.7 : 1 }}>
      <div className="flex items-start gap-3">
        <button className="btn mt-0.5 !p-1.5" disabled={!canEdit || status.isPending} title={`${label} → ${nextStatus(e.status) === "review" ? l("À valider", "To review") : nextStatus(e.status) === "done" ? l("Fait", "Done") : l("À faire", "To do")}`}
          aria-label={label} onClick={() => status.mutate(nextStatus(e.status))} style={e.status === "done" ? { color: "var(--ok)" } : e.status === "review" ? { color: "var(--warn)" } : undefined}>{statusIcon(e.status)}</button>
        <PriorityBadge p={e.priority} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold break-words" style={e.status === "done" ? { textDecoration: "line-through" } : undefined}>{e.title}</div>
          {e.details && <Details text={e.details} />}
          {e.images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {e.images.map((i) => <a key={i.id} href={imgUrl(i.id)} target="_blank" rel="noopener noreferrer"><img src={imgUrl(i.id)} alt={i.name} loading="lazy" className="h-20 w-20 rounded-lg object-cover" /></a>)}
            </div>)}
          {e.sopId && e.sopTitle && <div className="mt-2 text-sm"><Link to={`/my/procedures?open=${e.sopId}`} className="underline">SOP : {e.sopTitle}</Link></div>}
          <div className="mt-2 text-xs text-muted">{e.createdByName ?? "—"} · {fmtDate(e.createdAt, loc)} · {label}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button className="btn !gap-1 !px-2 !py-1.5 text-xs" aria-label={l("Commentaires", "Comments")} aria-expanded={open} onClick={() => setOpen(!open)}><MessageSquare size={14} />{e.commentCount}</button>
          {canEdit && <button className="btn !p-1.5" aria-label={l("Modifier", "Edit")} onClick={onEdit}><Pencil size={14} /></button>}
          {canEdit && <button className="btn btn-danger !p-1.5" aria-label={l("Supprimer", "Delete")} onClick={() => confirmDo(l("Supprimer cette évolution ?", "Delete this item?"), () => del.mutate())}><Trash2 size={14} /></button>}
        </div>
      </div>
      {open && <Comments id={e.id} canEdit={canEdit} meId={meId} />}
    </div>
  );
}

export default function EvolutionsPage() {
  const l = useL();
  const { can, me } = useAuth();
  const canEdit = can("evolutions.edit");
  const qc = useQueryClient();
  const [tab, setTab] = useState<EvoTab>("todo");
  const [edit, setEdit] = useState<Evo | null>(null);
  const [formKey, setFormKey] = useState(0);
  const q = useQuery({ queryKey: ["evolutions"], queryFn: () => api<Evo[]>("/api/evolutions") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["evolutions"] });
  const rows = q.data ?? [];
  const counts = tabCounts(rows);
  const shown = sortEvolutions(rows.filter((r) => inTab(r.status, tab)));
  type Vals = { title: string; details: string; priority: number; sopId: string | null };

  const create = useMutation({
    mutationFn: (a: { v: Vals; images: NewImage[] }) => api("/api/evolutions", { body: { ...a.v, images: a.images.map(({ name, type, data }) => ({ name, type, data })) } }),
    onSuccess: () => { setFormKey((k) => k + 1); setTab("todo"); void refresh(); },
  });
  const save = useMutation({
    mutationFn: async (a: { v: Vals; images: NewImage[] }) => {
      await api(`/api/evolutions/${edit!.id}`, { method: "PUT", body: a.v });
      for (const i of a.images) await api(`/api/evolutions/${edit!.id}/images`, { body: { name: i.name, type: i.type, data: i.data } });
    },
    onSuccess: () => { setEdit(null); void refresh(); },
  });
  const rmImage = useMutation({
    mutationFn: (id: string) => api(`/api/evolutions/images/${id}`, { method: "DELETE" }),
    onSuccess: (_d, id) => { setEdit((e) => (e ? { ...e, images: e.images.filter((i) => i.id !== id) } : e)); void refresh(); },
  });

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-widest text-muted">{l("Configuration", "Configuration")}</div>
        <h1 className="text-2xl font-semibold tracking-tight">{l("Évolutions du portail", "Portal changes")}</h1>
        <p className="mt-1 text-sm text-muted">{l("Ce que l'on veut ajouter ou changer dans le portail, le plus urgent en premier.", "What we want to add or change in the portal, most urgent first.")}</p>
      </div>
      {canEdit && (
        <div className="glass mb-6 p-5">
          <EvoForm key={formKey} busy={create.isPending} submitLabel={l("Ajouter à la liste", "Add to the list")} error={create.isError ? errMsg(create.error, l("Échec de l'ajout.", "Could not add.")) : undefined}
            onSubmit={(v, images) => create.mutate({ v, images })} />
        </div>)}
      <Tabs<EvoTab> value={tab} onChange={setTab} tabs={[
        { key: "todo", label: `${l("À faire", "To do")} (${counts.todo})` }, { key: "review", label: `${l("À valider", "To review")} (${counts.review})` },
        { key: "done", label: `${l("Fait", "Done")} (${counts.done})` }, { key: "all", label: `${l("Toutes", "All")} (${counts.all})` }]} />
      <div className="space-y-3">
        {shown.map((e) => <Card key={e.id} e={e} canEdit={canEdit} meId={me.user?.id} onEdit={() => setEdit(e)} />)}
        {q.data && !shown.length && <div className="glass"><Empty>{l("Rien dans cette liste.", "Nothing in this list.")}</Empty></div>}
      </div>
      {edit && (
        <Modal title={l("Modifier l'évolution", "Edit item")} onClose={() => setEdit(null)} wide>
          <EvoForm key={edit.id} initial={edit} existing={edit.images} onRemoveExisting={(id) => rmImage.mutate(id)} busy={save.isPending} submitLabel={l("Enregistrer", "Save")}
            error={save.isError ? errMsg(save.error, l("Échec de l'enregistrement.", "Could not save.")) : undefined} onSubmit={(v, images) => save.mutate({ v, images })} />
        </Modal>)}
    </div>
  );
}
