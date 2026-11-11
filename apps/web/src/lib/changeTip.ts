const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string) {
  let f = formatters.get(locale);
  if (!f) { f = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); formatters.set(locale, f); }
  return f;
}

/** Hover text: who last changed a box and when ("Décoché par Emmy · 11 nov. 2026 15:04"). */
export function changeTip(l: (fr: string, en: string) => string, locale: string, status: string, by?: string | null, at?: string | null): string | undefined {
  if (!by && !at) return undefined;
  const what = status === "todo" ? l("Décoché par", "Unchecked by") : status === "done" ? l("Coché par", "Checked by") : status === "na" ? l("Marqué N/A par", "Marked N/A by") : l("Modifié par", "Changed by");
  const when = at ? fmt(locale).format(new Date(at)) : "";
  return `${what} ${by ?? "—"}${when ? ` · ${when}` : ""}`;
}
