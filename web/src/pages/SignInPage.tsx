import { useState } from "react";
import { UiButton, UiInput } from "@/components/ui";
import { localLogin, localRegister, oidcLoginUrl, type AuthConfig } from "@/lib/api";

export function SignInPage({
  config,
  t,
  onSignedIn
}: {
  config: AuthConfig | null;
  t: (key: string) => string;
  onSignedIn: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    try {
      setError(null);
      if (mode === "login") {
        await localLogin(email.trim(), password);
      } else {
        await localRegister({
          email: email.trim(),
          password,
          display_name: displayName.trim() || undefined
        });
      }
      await onSignedIn();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed";
      setError(message);
    }
  }

  return (
    <section className="auth-shell">
      <div className="auth-card">
        <h2>{t("auth.signIn")}</h2>
        <p>{t("auth.subtitle")}</p>
        <div className="toolbar">
          <UiButton variant={mode === "login" ? "primary" : "secondary"} onClick={() => setMode("login")}>
            {t("auth.localLogin")}
          </UiButton>
          {config?.allow_local_registration && (
            <UiButton variant={mode === "register" ? "primary" : "secondary"} onClick={() => setMode("register")}>
              {t("auth.register")}
            </UiButton>
          )}
          {config?.allow_oidc && (
            <a className="ui-button ui-secondary ui-md" href={oidcLoginUrl()}>
              {t("auth.oidcLogin")}
            </a>
          )}
        </div>
        <div className="auth-fields">
          <UiInput value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.email")} />
          <UiInput
            value={password}
            type="password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("auth.password")}
          />
          {mode === "register" && (
            <UiInput
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("auth.displayNameOptional")}
            />
          )}
          <UiButton variant="primary" onClick={submit} disabled={!email || !password}>
            {t("auth.continue")}
          </UiButton>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}

