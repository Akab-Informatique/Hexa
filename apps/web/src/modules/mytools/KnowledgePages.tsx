import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, FormDialog, Toolbar, type FieldDef } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

// ============================ Knowledge base ============================
interface Article { id: string; title: string; category: string; published: boolean; excerpt?: string; body?: string; authorName: string | null; updatedAt: string }

export function KbPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [view, setView] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | { row?: Article }>(null);
  const list = useQuery({ queryKey: ["kb", q], queryFn: () => api<Article[]>(`/api/my/kb?q=${encodeURIComponent(q)}`) });
  const article = useQuery({ queryKey: ["kb-one", view], queryFn: () => api<Article>(`/api/my/kb/${view}`), enabled: Boolean(view) });
  const editor = can("mytools.kb.edit");
  const fields: FieldDef[] = [
    { name: "title", label: ["Titre", "Title"], required: true, span: 2 }, { name: "category", label: ["Catégorie", "Category"] }, { name: "published", label: ["Publié", "Published"], type: "checkbox" },
    { name: "body", label: ["Contenu", "Content"], type: "textarea", rows: 12 },
  ];
  const cats = [...new Set((list.data ?? []).map((a) => a.category))];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["kb"] }); await qc.invalidateQueries({ queryKey: ["kb-one"] }); };

  return (
    <>
      <PageHeader title={l("Base de connaissances", "Knowledge base")} actions={editor && <button className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} />{l("Nouvel article", "New article")}</button>} />
      <Toolbar><div className="relative min-w-[240px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" /><input className="input !pl-9" placeholder={l("Rechercher…", "Search…")} value={q} onChange={(e) => setQ(e.target.value)} /></div></Toolbar>
      {list.data?.length === 0 ? <div className="glass"><Empty>{l("Aucun article.", "No articles.")}</Empty></div> : cats.map((c) => (
        <section key={c} className="mb-5"><h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">{c}</h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{list.data!.filter((a) => a.category === c).map((a) => (
            <button key={a.id} className="glass p-4 text-left transition hover:brightness-125" onClick={() => setView(a.id)}>
              <div className="flex items-start justify-between gap-2"><span className="font-medium">{a.title}</span>{!a.published && <Chip tone="warn">{l("Brouillon", "Draft")}</Chip>}</div>
              <p className="mt-1 line-clamp-2 text-sm text-muted">{a.excerpt}</p><div className="mt-2 text-xs text-muted">{fmtDate(a.updatedAt, loc)}</div></button>))}</div></section>))}
      {view && article.data && (
        <Modal title={article.data.title} onClose={() => setView(null)} wide>
          <div className="mb-3 text-xs text-muted">{article.data.category} · {article.data.authorName} · {fmtDate(article.data.updatedAt, loc)}</div>
          <div className="mb-5 whitespace-pre-wrap text-sm leading-relaxed">{article.data.body}</div>
          {editor && <div className="flex justify-between"><button className="btn btn-danger" onClick={() => confirmDo(l("Supprimer cet article ?", "Delete this article?"), () => { void api(`/api/my/kb/${view}`, { method: "DELETE" }).then(async () => { setView(null); await refresh(); }); })}><Trash2 size={14} />{l("Supprimer", "Delete")}</button><button className="btn" onClick={() => { setEdit({ row: article.data }); setView(null); }}><Pencil size={14} />{l("Modifier", "Edit")}</button></div>}
        </Modal>)}
      {edit && <FormDialog title={edit.row ? l("Modifier l'article", "Edit article") : l("Nouvel article", "New article")} fields={fields} wide initial={edit.row ? { ...edit.row } : { published: true, category: "Général" }}
        onSubmit={async (v) => { const body = { title: v.title, category: v.category || "Général", body: v.body ?? "", published: Boolean(v.published) }; if (edit.row) await api(`/api/my/kb/${edit.row.id}`, { method: "PATCH", body }); else await api("/api/my/kb", { body }); await refresh(); }} onClose={() => setEdit(null)} />}
    </>
  );
}

// ============================ Procedures ============================
interface Proc { id: string; title: string; description: string; category: string; status: "draft" | "published"; authorId: string | null; authorName: string | null; stepCount: number; steps?: { title: string; body: string }[] }

export function ProceduresPage() {
  const l = useL();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [view, setView] = useState<string | null>(null);
  const [edit, setEdit] = useState<null | { id?: string }>(null);
  const list = useQuery({ queryKey: ["procedures"], queryFn: () => api<Proc[]>("/api/my/procedures") });
  const detail = useQuery({ queryKey: ["procedure", view ?? edit?.id], queryFn: () => api<Proc>(`/api/my/procedures/${view ?? edit?.id}`), enabled: Boolean(view ?? edit?.id) });
  const canEdit = can("mytools.procedures.edit", "mytools.procedures.manage");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["procedures"] }); await qc.invalidateQueries({ queryKey: ["procedure"] }); };
  const mine = (p: Proc) => can("mytools.procedures.manage") || p.authorId === me.user?.id;

  return (
    <>
      <PageHeader title={l("Procédures", "Procedures")} subtitle={l("Guides étape par étape pour l'équipe", "Step-by-step guides for the team")}
        actions={canEdit && <button className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} />{l("Nouvelle procédure", "New procedure")}</button>} />
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {list.data?.map((p) => (
          <button key={p.id} className="glass p-4 text-left transition hover:brightness-125" onClick={() => setView(p.id)}>
            <div className="flex items-start justify-between gap-2"><span className="font-medium">{p.title}</span>{p.status === "draft" && <Chip tone="warn">{l("Brouillon", "Draft")}</Chip>}</div>
            <p className="mt-1 line-clamp-2 text-sm text-muted">{p.description}</p><div className="mt-2 text-xs text-muted">{p.category} · {p.stepCount} {l("étapes", "steps")}</div></button>))}
      </div>
      {list.data?.length === 0 && <div className="glass"><Empty>{l("Aucune procédure.", "No procedures.")}</Empty></div>}
      {view && detail.data && (
        <Modal title={detail.data.title} onClose={() => setView(null)} wide>
          <p className="mb-4 text-sm text-muted">{detail.data.description}</p>
          <ol className="mb-5 space-y-3">{detail.data.steps?.map((s, i) => <li key={i} className="glass-flat flex gap-3 p-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: "linear-gradient(135deg, var(--brand), var(--brand-2))" }}>{i + 1}</span><div><div className="font-medium">{s.title}</div><div className="mt-1 whitespace-pre-wrap text-sm text-muted">{s.body}</div></div></li>)}</ol>
          <div className="flex justify-between"><button className="btn" onClick={() => window.print()}>{l("Imprimer", "Print")}</button>{mine(detail.data) && canEdit && <button className="btn" onClick={() => { setEdit({ id: detail.data!.id }); setView(null); }}><Pencil size={14} />{l("Modifier", "Edit")}</button>}</div>
        </Modal>)}
      {edit && (edit.id ? detail.data : true) && <ProcedureEditor existing={edit.id ? detail.data : undefined} onClose={() => setEdit(null)} onSaved={refresh} />}
    </>
  );
}

function ProcedureEditor({ existing, onClose, onSaved }: { existing?: Proc; onClose: () => void; onSaved: () => Promise<void> }) {
  const l = useL();
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [category, setCategory] = useState(existing?.category ?? "Général");
  const [status, setStatus] = useState(existing?.status ?? "draft");
  const [steps, setSteps] = useState(existing?.steps?.length ? existing.steps.map((s) => ({ title: s.title, body: s.body })) : [{ title: "", body: "" }]);
  const [error, setError] = useState("");
  const setStep = (i: number, k: "title" | "body", v: string) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const move = (i: number, d: number) => setSteps((s) => { const a = [...s]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j]!, a[i]!]; return a; });
  const save = async () => {
    try {
      const body = { title, description, category, status, steps: steps.filter((s) => s.title.trim()) };
      if (existing) await api(`/api/my/procedures/${existing.id}`, { method: "PUT", body }); else await api("/api/my/procedures", { body });
      await onSaved(); onClose();
    } catch (e) { setError(errMsg(e, "Error")); }
  };
  return (
    <Modal title={existing ? l("Modifier la procédure", "Edit procedure") : l("Nouvelle procédure", "New procedure")} onClose={onClose} wide>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <label className="mb-4 sm:col-span-2"><span className="label">{l("Titre", "Title")} *</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="mb-4"><span className="label">{l("Catégorie", "Category")}</span><input className="input" value={category} onChange={(e) => setCategory(e.target.value)} /></label>
        <label className="mb-4"><span className="label">{l("Statut", "Status")}</span><select className="input" value={status} onChange={(e) => setStatus(e.target.value as "draft" | "published")}><option value="draft">{l("Brouillon", "Draft")}</option><option value="published">{l("Publiée", "Published")}</option></select></label>
        <label className="mb-4 sm:col-span-2"><span className="label">{l("Description", "Description")}</span><textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      </div>
      <h3 className="mb-2 text-sm font-semibold">{l("Étapes", "Steps")}</h3>
      <ol className="mb-3 space-y-3">{steps.map((s, i) => (
        <li key={i} className="glass-flat p-3"><div className="mb-2 flex items-center gap-2"><span className="text-sm font-semibold text-muted">{i + 1}.</span><input className="input" placeholder={l("Titre de l'étape", "Step title")} value={s.title} onChange={(e) => setStep(i, "title", e.target.value)} />
          <button className="btn !p-1.5" onClick={() => move(i, -1)} aria-label="up"><ArrowUp size={13} /></button><button className="btn !p-1.5" onClick={() => move(i, 1)} aria-label="down"><ArrowDown size={13} /></button><button className="btn btn-danger !p-1.5" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="remove"><Trash2 size={13} /></button></div>
          <textarea className="input" rows={2} placeholder={l("Détails…", "Details…")} value={s.body} onChange={(e) => setStep(i, "body", e.target.value)} /></li>))}</ol>
      <button className="btn mb-4" onClick={() => setSteps((s) => [...s, { title: "", body: "" }])}><Plus size={14} />{l("Ajouter une étape", "Add a step")}</button>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" disabled={!title.trim()} onClick={() => void save()}>{l("Enregistrer", "Save")}</button></div>
    </Modal>
  );
}
