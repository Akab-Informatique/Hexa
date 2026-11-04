import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { fr } from "./fr";
import { en } from "./en";

const saved = (() => { try { return localStorage.getItem("nexo.lang"); } catch { return null; } })();

void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: saved === "en" ? "en" : "fr",
  fallbackLng: "fr",
  interpolation: { escapeValue: false },
});

export function setLanguage(lang: "fr" | "en") {
  try { localStorage.setItem("nexo.lang", lang); } catch { /* private mode */ }
  document.documentElement.lang = lang;
  void i18n.changeLanguage(lang);
}

export default i18n;
