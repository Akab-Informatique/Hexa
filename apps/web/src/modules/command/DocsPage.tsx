import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, FolderOpen, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useL } from "../../lib/l";
import { Empty, errMsg, FormDialog, Toolbar, useClients, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

interface Doc { id: string; title: string; url: string; description: string; category: string; clientId: string | null; clientName: string | null; createdBy: string | null }

/**
 * Documentation: curated links into the firm's SharePoint libraries (global or per client).
 * Browsing SharePoint inside the app comes with the Microsoft 365 integration; links work today.
 */
export default function DocsPage() {
  const l = useL();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const clients = useClients();
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [edit, setEdit] = useState<null | { row?: Doc }>(null);
  const list = useQuery({ queryKey: ["docs", q, client], queryFn: () => api<Doc[]>(`/api/command/docs?q=${encodeURIComponent(q)}${client ? `&client=${client}` : ""}`) });
  const editor = can("docs.edit", "docs.manage");
  const fields: FieldDef[] = [
    { name: "title", label: ["Titre", "Title"], required: true, span: 2 }, { name: "url", label: ["Adresse SharePoint (lien)", "SharePoint link"], type: "url", required: true, span: 2, placeholder: "https://…sharepoint.com/…" },
    { name: "category", label: ["Catégorie", "Category"] }, { name: "clientId", label: ["Client (optionnel)", "Client (optional)"], type: "client" },
    { name: "description", label: ["Description", "Description"], type: "textarea", rows: 2 },
  ];
  const cats = [...new Set((list.data ?? []).map((d) => d.category))];
  const refresh = () => qc.invalidateQueries({ queryKey: ["docs"] });
  const own = (d: Doc) => can("docs.manage") || d.createdBy === me.user?.id;

  return (
    <>
      <PageHeader title={l("Documentation", "Documentation")} subtitle={l("Liens vers les bibliothèques SharePoint du cabinet", "Links to the firm's SharePoint libraries")}
        actions={editor && <button className="btn btn-primary" onClick={() => setEdit({})}><Plus size={16} />{l("Ajouter un lien", "Add a link")}</button>} />
      <Toolbar>
        <div className="relative min-w-[240px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" /><input className="input !pl-9" placeholder={l("Rechercher…", "Search…")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="input !w-auto" value={client} onChange={(e) => setClient(e.target.value)} aria-label="client"><option value="">{l("Tous les clients", "All clients")}</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </Toolbar>
      {list.data?.length === 0 && <div className="glass"><Empty>{l("Aucun document lié.", "No linked documents.")}</Empty></div>}
      {cats.map((c) => (
        <section key={c} className="mb-5"><h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted">{c}</h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{list.data!.filter((d) => d.category === c).map((d) => (
            <div key={d.id} className="glass flex flex-col p-4">
              <div className="flex items-start gap-3"><FolderOpen className="mt-0.5 shrink-0 text-brand" size={20} /><div className="min-w-0"><div className="font-medium">{d.title}</div>{d.clientName && <div className="text-xs text-muted">{d.clientName}</div>}</div></div>
              {d.description && <p className="mt-2 text-sm text-muted">{d.description}</p>}
              <div className="mt-3 flex items-center justify-between"><a href={d.url} target="_blank" rel="noopener noreferrer" className="btn no-underline"><ExternalLink size={14} />{l("Ouvrir", "Open")}</a>
                {editor && own(d) && <div className="flex gap-1.5"><button className="btn !p-1.5" onClick={() => setEdit({ row: d })} aria-label="edit"><Pencil size={14} /></button><button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => { if (window.confirm(l("Supprimer ce lien ?", "Delete this link?"))) void api(`/api/command/docs/${d.id}`, { method: "DELETE" }).then(refresh).catch((e) => alert(errMsg(e, "Error"))); }}><Trash2 size={14} /></button></div>}</div>
            </div>))}</div></section>))}
      {edit && <FormDialog title={edit.row ? l("Modifier le lien", "Edit link") : l("Nouveau lien", "New link")} fields={fields} wide initial={edit.row ? { ...edit.row, clientId: edit.row.clientId ?? "" } : { category: "Général" }}
        onSubmit={async (v) => { const body = { title: v.title, url: v.url, description: v.description ?? "", category: v.category || "Général", clientId: v.clientId || null }; if (edit.row) await api(`/api/command/docs/${edit.row.id}`, { method: "PATCH", body }); else await api("/api/command/docs", { body }); await refresh(); }} onClose={() => setEdit(null)} />}
    </>
  );
}
