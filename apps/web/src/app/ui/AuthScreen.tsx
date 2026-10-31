/** Signed-out screen: brand lockup, sign-in/sign-up tabs, honest cloud-preview notice. */
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AtSign, Eye, EyeOff, Lock, ShieldAlert, UserRound } from "lucide-react";
import { LuxoraApiError, type SignInInput, type SignUpInput } from "../contract";
import { useMessenger } from "../messenger";
import { useCopy, useLocale } from "../../i18n";
import { useStrings } from "./copy";
import { Spinner } from "./primitives";

const DEVICE_STORAGE_KEY = "luxora-web-device-name";

function detectDeviceName(fallback: string): string {
  try {
    const saved = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (saved && saved.trim()) return saved;
  } catch {
    /* storage unavailable */
  }
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const platform = /Windows/i.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macOS"
      : /Android/i.test(ua)
        ? "Android"
        : /iPhone|iPad/i.test(ua)
          ? "iOS"
          : /Linux/i.test(ua)
            ? "Linux"
            : "";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Chrome\//i.test(ua)
      ? "Chrome"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Safari\//i.test(ua)
          ? "Safari"
          : "";
  const label = [browser, platform].filter(Boolean).join(" · ");
  return label || fallback;
}

function validateUsername(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(value.trim());
}

function validatePassword(value: string): boolean {
  return value.length >= 12 && value.length <= 128;
}

type FieldErrors = Partial<Record<"username" | "displayName" | "password" | "deviceName", string>>;

export function AuthScreen() {
  const s = useStrings();
  const api = useMessenger();
  const { locale, setLocale } = useLocale();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(() => detectDeviceName(s.auth.devicePlaceholder));
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement | null>(null);

  const submitting = busy || api.phase === "submitting";
  const localeCopy = useCopy({ en: "EN", ru: "RU" });

  const switchTab = (next: "signin" | "signup") => {
    if (next === mode) return;
    setMode(next);
    setFieldErrors({});
    setSubmitError(null);
  };

  const mapError = (error: unknown): string => {
    if (error instanceof LuxoraApiError) {
      return s.auth.errors[error.code] ?? s.auth.errorUnknown(error.code);
    }
    return s.auth.errorNetwork;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const errors: FieldErrors = {};
    if (!validateUsername(username)) errors.username = s.auth.errorUsername;
    if (!validatePassword(password)) errors.password = s.auth.errorPassword;
    if (mode === "signup" && (displayName.trim().length === 0 || displayName.trim().length > 80)) {
      errors.displayName = s.auth.errorDisplayName;
    }
    if (deviceName.trim().length === 0 || deviceName.trim().length > 80) {
      errors.deviceName = s.auth.errorDeviceName;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSubmitError(null);
      const firstInvalid = formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']");
      firstInvalid?.focus();
      return;
    }
    setSubmitError(null);
    setBusy(true);
    try {
      const base: SignInInput = { username: username.trim(), password, deviceName: deviceName.trim() };
      if (mode === "signup") {
        const input: SignUpInput = { ...base, displayName: displayName.trim() };
        await api.signUp(input);
      } else {
        await api.signIn(base);
      }
      try {
        localStorage.setItem(DEVICE_STORAGE_KEY, deviceName.trim());
      } catch {
        /* ignored */
      }
    } catch (error) {
      setSubmitError(mapError(error));
    } finally {
      setBusy(false);
    }
  };

  const errorText = useMemo(() => submitError ?? "", [submitError]);

  return (
    <div className="auth">
      <div className="auth__aurora" aria-hidden="true" />
      <section className="auth__brandside" aria-label={s.app.name}>
        <div className="brand brand--large">
          <img className="brand__mark" src="/logo.png" alt="" width={44} height={44} />
          <div className="brand__text">
            <span className="brand__name">{s.app.name}</span>
            <span className="brand__beta">{s.app.beta}</span>
          </div>
        </div>
        <h1 className="auth__headline">{s.app.tagline}</h1>
        <ul className="auth__points">
          <li>
            <ShieldAlert size={18} aria-hidden="true" />
            <span>{s.app.trustChip}</span>
          </li>
          <li>
            <Lock size={18} aria-hidden="true" />
            <span>{s.auth.passwordHint}</span>
          </li>
          <li>
            <AtSign size={18} aria-hidden="true" />
            <span>{s.auth.usernameHint}</span>
          </li>
        </ul>
        <p className="auth__notice">
          <strong>{s.auth.noticeTitle}.</strong> {s.auth.noticeBody}
        </p>
        <Link className="auth__backlink" to="/">
          ← {s.app.backToSite}
        </Link>
      </section>

      <section className="auth__formside" aria-label={mode === "signin" ? s.auth.tabSignIn : s.auth.tabSignUp}>
        <div className="auth__utility">
          <div className="locale-switch" role="group" aria-label={s.app.locale}>
            <button
              type="button"
              className={locale === "ru" ? "is-active" : ""}
              aria-pressed={locale === "ru"}
              onClick={() => setLocale("ru")}
              title={s.app.switchToRu}
            >
              RU
            </button>
            <button
              type="button"
              className={locale === "en" ? "is-active" : ""}
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
              title={s.app.switchToEn}
            >
              EN
            </button>
          </div>
        </div>

        <div className="auth-card">
          <div className="auth-tabs" role="tablist" aria-label={`${s.auth.tabSignIn} / ${s.auth.tabSignUp}`}>
            <button
              type="button"
              role="tab"
              id="auth-tab-signin"
              aria-selected={mode === "signin"}
              aria-controls="auth-form-panel"
              data-testid="auth-tab-signin"
              className={`auth-tabs__tab${mode === "signin" ? " is-active" : ""}`}
              onClick={() => switchTab("signin")}
            >
              {s.auth.tabSignIn}
            </button>
            <button
              type="button"
              role="tab"
              id="auth-tab-signup"
              aria-selected={mode === "signup"}
              aria-controls="auth-form-panel"
              data-testid="auth-tab-signup"
              className={`auth-tabs__tab${mode === "signup" ? " is-active" : ""}`}
              onClick={() => switchTab("signup")}
            >
              {s.auth.tabSignUp}
            </button>
          </div>

          <p className="auth-card__lead">{mode === "signin" ? s.auth.signInLead : s.auth.signUpLead}</p>

          <form
            ref={formRef}
            id="auth-form-panel"
            role="tabpanel"
            aria-labelledby={mode === "signin" ? "auth-tab-signin" : "auth-tab-signup"}
            className="auth-form"
            onSubmit={handleSubmit}
            noValidate
          >
            <div className="field">
              <label className="field__label" htmlFor="auth-username-input">
                {s.auth.username}
              </label>
              <div className={`field__control${fieldErrors.username ? " is-invalid" : ""}`}>
                <UserRound size={17} aria-hidden="true" />
                <input
                  id="auth-username-input"
                  name="username"
                  data-testid="auth-username"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={s.auth.usernamePlaceholder}
                  value={username}
                  disabled={submitting}
                  aria-invalid={fieldErrors.username ? true : undefined}
                  aria-describedby={`auth-username-hint${fieldErrors.username ? " auth-username-error" : ""}`}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                />
              </div>
              {fieldErrors.username ? (
                <p className="field__error" id="auth-username-error">
                  {fieldErrors.username}
                </p>
              ) : (
                <p className="field__hint" id="auth-username-hint">
                  {s.auth.usernameHint}
                </p>
              )}
            </div>

            {mode === "signup" ? (
              <div className="field">
                <label className="field__label" htmlFor="auth-displayname-input">
                  {s.auth.displayName}
                </label>
                <div className={`field__control${fieldErrors.displayName ? " is-invalid" : ""}`}>
                  <UserRound size={17} aria-hidden="true" />
                  <input
                    id="auth-displayname-input"
                    name="displayName"
                    data-testid="auth-displayname"
                    autoComplete="name"
                    placeholder={s.auth.displayNamePlaceholder}
                    value={displayName}
                    disabled={submitting}
                    maxLength={80}
                    aria-invalid={fieldErrors.displayName ? true : undefined}
                    aria-describedby={`auth-displayname-hint${fieldErrors.displayName ? " auth-displayname-error" : ""}`}
                    onChange={(event) => setDisplayName(event.target.value)}
                    required
                  />
                </div>
                {fieldErrors.displayName ? (
                  <p className="field__error" id="auth-displayname-error">
                    {fieldErrors.displayName}
                  </p>
                ) : (
                  <p className="field__hint" id="auth-displayname-hint">
                    {s.auth.displayNameHint}
                  </p>
                )}
              </div>
            ) : null}

            <div className="field">
              <label className="field__label" htmlFor="auth-password-input">
                {s.auth.password}
              </label>
              <div className={`field__control${fieldErrors.password ? " is-invalid" : ""}`}>
                <Lock size={17} aria-hidden="true" />
                <input
                  id="auth-password-input"
                  name="password"
                  data-testid="auth-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  placeholder={s.auth.passwordPlaceholder}
                  value={password}
                  disabled={submitting}
                  maxLength={128}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby={`auth-password-hint${fieldErrors.password ? " auth-password-error" : ""}`}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
                <button
                  type="button"
                  className="field__reveal"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? s.auth.hidePassword : s.auth.showPassword}
                  title={showPassword ? s.auth.hidePassword : s.auth.showPassword}
                >
                  {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                </button>
              </div>
              {fieldErrors.password ? (
                <p className="field__error" id="auth-password-error">
                  {fieldErrors.password}
                </p>
              ) : (
                <p className="field__hint" id="auth-password-hint">
                  {s.auth.passwordHint}
                </p>
              )}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="auth-device-input">
                {s.auth.deviceName}
              </label>
              <div className={`field__control${fieldErrors.deviceName ? " is-invalid" : ""}`}>
                <UserRound size={17} aria-hidden="true" />
                <input
                  id="auth-device-input"
                  name="deviceName"
                  data-testid="auth-device"
                  autoComplete="off"
                  placeholder={s.auth.devicePlaceholder}
                  value={deviceName}
                  disabled={submitting}
                  maxLength={80}
                  aria-invalid={fieldErrors.deviceName ? true : undefined}
                  aria-describedby={`auth-device-hint${fieldErrors.deviceName ? " auth-device-error" : ""}`}
                  onChange={(event) => setDeviceName(event.target.value)}
                  required
                />
              </div>
              {fieldErrors.deviceName ? (
                <p className="field__error" id="auth-device-error">
                  {fieldErrors.deviceName}
                </p>
              ) : (
                <p className="field__hint" id="auth-device-hint">
                  {s.auth.deviceHint}
                </p>
              )}
            </div>

            <div
              className={`auth-error${errorText ? " is-visible" : ""}`}
              data-testid="auth-error"
              role="alert"
              aria-live="assertive"
            >
              {errorText}
            </div>

            <button type="submit" className="button button--primary auth-submit" data-testid="auth-submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner /> {s.auth.submitting}
                </>
              ) : (
                <>{mode === "signin" ? s.auth.submitSignIn : s.auth.submitSignUp}</>
              )}
            </button>
          </form>

          <p className="auth-card__session">{s.auth.sessionNote}</p>
          <p className="auth-card__trust">
            <ShieldAlert size={15} aria-hidden="true" /> {s.app.trustChip}
          </p>
        </div>

        <p className="auth__utility-note">
          {localeCopy} · {s.app.beta}
        </p>
      </section>
    </div>
  );
}
