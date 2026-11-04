import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { setLanguage } from "../i18n";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgb(0 0 0 / 0.55)", backdropFilter: "blur(4px)" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`glass w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[90vh] overflow-auto p-6`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn !p-1.5" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function LanguageToggle({ onChange }: { onChange?: (l: "fr" | "en") => void }) {
  const { i18n } = useTranslation();
  const pick = (l: "fr" | "en") => { setLanguage(l); onChange?.(l); };
  return (
    <div className="glass-flat inline-flex p-0.5 text-xs" role="group" aria-label="Language">
      {(["fr", "en"] as const).map((l) => (
        <button key={l} onClick={() => pick(l)} aria-pressed={i18n.language === l}
          className="rounded-[9px] px-2.5 py-1 font-medium uppercase transition"
          style={i18n.language === l ? { background: "linear-gradient(135deg, var(--brand), var(--brand-2))", color: "#fff" } : { color: "var(--muted)" }}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function BrandMark({ name, logoUrl, size = 36 }: { name: string; logoUrl?: string; size?: number }) {
  return logoUrl ? (
    <img src={logoUrl} alt={name} style={{ height: size, maxWidth: size * 4 }} className="object-contain" />
  ) : (
    <div className="grid place-items-center rounded-xl font-bold text-white" style={{ width: size, height: size, background: "linear-gradient(135deg, var(--brand), var(--brand-2))", boxShadow: "0 8px 24px -8px var(--glow)" }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
