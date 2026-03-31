import { useState } from "react";
import { UiButton, UiInput } from "@/components/ui";
import { localLogin, localRegister, oidcLoginUrl, type AuthConfig } from "@/lib/api";

type AuthFormProps = {
  config: AuthConfig | null;
  t: (key: string) => string;
  onSignedIn: () => Promise<void>;
  compact?: boolean;
};

export function AuthForm({ config, t, onSignedIn, compact = false }: AuthFormProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    try {
      setSubmitting(true);
      setError(null);
      if (mode === "login") {
        await localLogin(email.trim(), password);
      } else {
        await localRegister({
          email: email.trim(),
          username: username.trim(),
          password,
          display_name: displayName.trim() || undefined
        });
      }
      await onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`auth-form ${compact ? "compact" : ""}`}>
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
        {mode === "register" && (
          <UiInput
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("auth.username")}
          />
        )}
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
        <UiButton
          variant="primary"
          onClick={submit}
          disabled={
            submitting || !email.trim() || !password || (mode === "register" && !username.trim())
          }
        >
          {submitting ? t("common.loading") : t("auth.continue")}
        </UiButton>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
