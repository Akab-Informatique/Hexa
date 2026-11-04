import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBranding } from "../lib/theme";
import { BrandMark, Field, LanguageToggle } from "../components/ui";

/** One screen that walks the sign-in stages: password -> 2FA (or 2FA setup) -> forced password change. */
export default function Login() {
  const { t } = useTranslation();
  const { me, refresh } = useAuth();
  const brand = useBranding();
  return (
    <div className="relative grid min-h-full place-items-center p-4">
      <div className="canvas" />
      <div className="absolute right-4 top-4 z-10"><LanguageToggle /></div>
      <div className="glass relative z-10 w-full max-w-md p-8">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark name={brand.appName} logoUrl={brand.logoUrl} size={52} />
          <div className="text-xl font-semibold tracking-tight">{brand.appName}</div>
        </div>
        {me.stage === "anonymous" && <Credentials onDone={refresh} />}
        {me.stage === "mfa" && <Code onDone={refresh} />}
        {me.stage === "mfa-setup" && <Setup onDone={refresh} />}
        {me.stage === "password" && <ChangePassword onDone={refresh} />}
      </div>
      <div className="relative z-10 mt-6 text-xs text-muted">{t("common.poweredBy")}</div>
    </div>
  );
}

function useSubmit(action: () => Promise<unknown>, fallbackKey: string) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await action(); } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? t("login.tooMany") : err instanceof ApiError && err.status === 400 ? err.message : t(fallbackKey));
    } finally { setBusy(false); }
  };
  return { busy, error, submit };
}

const Err = ({ msg }: { msg: string }) => (msg ? <p role="alert" className="mb-3 text-sm text-danger">{msg}</p> : null);

function Credentials({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { busy, error, submit } = useSubmit(async () => { await api("/api/auth/login", { body: { email, password } }); await onDone(); }, "login.invalid");
  return (
    <form onSubmit={submit}>
      <h1 className="mb-1 text-lg font-semibold">{t("login.title")}</h1>
      <p className="mb-5 text-sm text-muted">{t("login.subtitle")}</p>
      <Field label={t("login.email")}><input className="input" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label={t("login.password")}><input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Err msg={error} />
      <button className="btn btn-primary w-full" disabled={busy}>{t("login.submit")}</button>
    </form>
  );
}

function Code({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const { busy, error, submit } = useSubmit(async () => { await api("/api/auth/mfa/verify", { body: { code } }); await onDone(); }, "login.mfaBad");
  return (
    <form onSubmit={submit}>
      <h1 className="mb-1 text-lg font-semibold">{t("login.mfaTitle")}</h1>
      <p className="mb-5 text-sm text-muted">{t("login.mfaHelp")}</p>
      <Field label={t("login.code")}><input className="input text-center text-xl tracking-[0.4em]" inputMode="numeric" pattern="\d{6}" maxLength={6} required autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
      <Err msg={error} />
      <button className="btn btn-primary w-full" disabled={busy || code.length !== 6}>{t("login.verify")}</button>
    </form>
  );
}

function Setup({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [data, setData] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  useEffect(() => { void api<{ qr: string; secret: string }>("/api/auth/mfa/setup", { body: {} }).then(setData); }, []);
  const { busy, error, submit } = useSubmit(async () => { await api("/api/auth/mfa/enable", { body: { code } }); await onDone(); }, "login.mfaBad");
  return (
    <form onSubmit={submit}>
      <h1 className="mb-1 text-lg font-semibold">{t("login.setupTitle")}</h1>
      <p className="mb-4 text-sm text-muted">{t("login.setupHelp")}</p>
      {data && (
        <div className="mb-4 flex flex-col items-center gap-2">
          <img src={data.qr} alt="QR" className="rounded-xl bg-white p-2" width={190} height={190} />
          <div className="text-xs text-muted">{t("login.setupSecret")}</div>
          <code className="select-all break-all rounded-lg bg-black/30 px-2 py-1 text-xs">{data.secret}</code>
        </div>
      )}
      <Field label={t("login.code")}><input className="input text-center text-xl tracking-[0.4em]" inputMode="numeric" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
      <Err msg={error} />
      <button className="btn btn-primary w-full" disabled={busy || code.length !== 6}>{t("login.enable")}</button>
    </form>
  );
}

function ChangePassword({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [local, setLocal] = useState("");
  const { busy, error, submit } = useSubmit(async () => {
    if (next.length < 12) return setLocal(t("login.pwShort"));
    if (next !== confirm) return setLocal(t("login.pwMismatch"));
    setLocal("");
    await api("/api/auth/password", { body: { current, next } });
    await onDone();
  }, "login.invalid");
  return (
    <form onSubmit={submit}>
      <h1 className="mb-1 text-lg font-semibold">{t("login.pwTitle")}</h1>
      <p className="mb-5 text-sm text-muted">{t("login.pwHelp")}</p>
      <Field label={t("login.pwCurrent")}><input className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label={t("login.pwNew")}><input className="input" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <Field label={t("login.pwConfirm")}><input className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
      <Err msg={local || error} />
      <button className="btn btn-primary w-full" disabled={busy}>{t("login.pwChange")}</button>
    </form>
  );
}
