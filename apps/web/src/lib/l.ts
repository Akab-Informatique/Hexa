import { useTranslation } from "react-i18next";

/** Co-located bilingual strings: l("Clients", "Clients"). Returns the one for the current language. */
export function useL() {
  const { i18n } = useTranslation();
  const en = i18n.language === "en";
  return (fr: string, e: string) => (en ? e : fr);
}

export function useLocale() {
  const { i18n } = useTranslation();
  return i18n.language === "en" ? "en-CA" : "fr-CA";
}

export const money = (n: number | null | undefined, locale = "fr-CA") =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "CAD" }).format(n ?? 0);

/** Dates travel as YYYY-MM-DD; format without any timezone shift. */
export const fmtDate = (s: string | null | undefined, locale = "fr-CA") =>
  s ? new Date(`${s.slice(0, 10)}T12:00:00`).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" }) : "—";

export const hours = (minutes: number) => `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const mondayOf = (s: string) => {
  const d = new Date(`${s}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
