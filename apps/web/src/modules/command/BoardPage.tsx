import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, useClients, useIntegrations } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

interface Message { id: string; title: string; body: string; pinned: boolean; audience: "all" | "selected"; authorName: string | null; emailCopy: boolean; emailStatus: string; createdAt: string; targets: { id: string; name: string }[] }

/** Message board: one-way broadcast to all clients or a selection, with an optional email copy. */
export default function BoardPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["board"], queryFn: () => api<Message[]>("/api/command/board") });
  const [composing, setComposing] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["board"] });
  const post = can("command.board.post", "command.board.manage");
  const manage = can("command.board.manage");

  return (
    <>
      <PageHeader title={l("Babillard", "Message board")} subtitle={l("Messages aux clients, dans leur portail ou par courriel", "Messages to clients, in their portal or by email")}
        actions={post && <button className="btn btn-primary" onClick={() => setComposing(true)}><Plus size={16} />{l("Nouveau message", "New message")}</button>} />
      {list.data?.length === 0 && <div className="glass"><Empty>{l("Aucun message publié.", "No messages posted.")}</Empty></div>}
      <div className="space-y-3">
        {list.data?.map((m) => (
          <article key={m.id} className="glass p-5">
            <div className="flex items-start justify-between gap-3">
              <div><h2 className="font-semibold">{m.pinned && "📌 "}{m.title}</h2><div className="mt-0.5 text-xs text-muted">{m.authorName} · {fmtDate(m.createdAt, loc)}</div></div>
              <div className="flex shrink-0 items-center gap-2">
                <Chip>{m.audience === "all" ? l("Tous les clients", "All clients") : `${m.targets.length} ${l("client(s)", "client(s)")}`}</Chip>
                {m.emailCopy && <Chip tone={m.emailStatus === "sent" ? "ok" : "warn"}><Mail size={11} />{m.emailStatus === "sent" ? l("Envoyé", "Sent") : l("En attente d'envoi", "Email pending")}</Chip>}
                {manage && <button className="btn !p-1.5" onClick={() => void api(`/api/command/board/${m.id}`, { method: "PATCH", body: { pinned: !m.pinned } }).then(refresh)} aria-label="pin">{m.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>}
                {post && <button className="btn btn-danger !p-1.5" onClick={() => { if (window.confirm(l("Supprimer ce message ?", "Delete this message?"))) void api(`/api/command/board/${m.id}`, { method: "DELETE" }).then(refresh).catch((e) => alert(errMsg(e, "Error"))); }} aria-label="delete"><Trash2 size={14} /></button>}
              </div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm">{m.body}</p>
            {m.audience === "selected" && <div className="mt-3 flex flex-wrap gap-1.5">{m.targets.map((t) => <span key={t.id} className="chip">{t.name}</span>)}</div>}
          </article>))}
      </div>
      {composing && <Compose onClose={() => setComposing(false)} onPosted={refresh} />}
    </>
  );
}

function Compose({ onClose, onPosted }: { onClose: () => void; onPosted: () => Promise<unknown> }) {
  const l = useL();
  const { can } = useAuth();
  const clients = useClients();
  const integ = useIntegrations();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<"all" | "selected">("all");
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [emailCopy, setEmailCopy] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const mailReady = integ.data?.mailjet?.configured && integ.data.mailjet.enabled;
  const shown = (clients.data ?? []).filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (id: string) => setClientIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Modal title={l("Nouveau message", "New message")} onClose={onClose} wide>
      <label className="mb-4 block"><span className="label">{l("Titre", "Title")} *</span><input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="mb-4 block"><span className="label">{l("Message", "Message")}</span><textarea className="input" rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></label>
      <label className="mb-3 block"><span className="label">{l("Destinataires", "Audience")}</span>
        <select className="input" value={audience} onChange={(e) => setAudience(e.target.value as "all" | "selected")}><option value="all">{l("Tous les clients", "All clients")}</option><option value="selected">{l("Clients choisis", "Selected clients")}</option></select></label>
      {audience === "selected" && (
        <div className="glass-flat mb-4 p-3"><input className="input mb-2" placeholder={l("Filtrer les clients…", "Filter clients…")} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="max-h-44 space-y-1 overflow-auto">{shown.map((c) => <label key={c.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={clientIds.includes(c.id)} onChange={() => toggle(c.id)} />{c.name}</label>)}</div>
          <div className="mt-2 text-xs text-muted">{clientIds.length} {l("sélectionné(s)", "selected")}</div></div>)}
      {can("command.board.email", "command.board.manage") && (
        <label className="mb-1 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={emailCopy} onChange={(e) => setEmailCopy(e.target.checked)} />{l("Envoyer aussi par courriel", "Also send by email")}</label>)}
      {emailCopy && !mailReady && <p className="mb-3 text-xs text-warn">{l("Mailjet n'est pas encore configuré: le courriel restera « en attente d'envoi » jusqu'à la configuration.", "Mailjet is not configured yet: the email will stay “pending” until it is set up.")}</p>}
      {error && <p role="alert" className="my-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button>
        <button className="btn btn-primary" disabled={!title.trim() || (audience === "selected" && !clientIds.length)} onClick={async () => { try { await api("/api/command/board", { body: { title, body, audience, clientIds, emailCopy } }); await onPosted(); onClose(); } catch (e) { setError(errMsg(e, "Error")); } }}>{l("Publier", "Post")}</button></div>
    </Modal>
  );
}
